import { randomUUID } from "node:crypto";
import type { AudioMetadata, Candidate, FolderPreview, MusicRequest, PreviewFile, RemoteFile, Quality } from "../shared/types";
import { ApiError } from "./auth";
import type { Config } from "./config";
import { Store } from "./db";
import { isSupportedAudioFile, manualSelectionCheck, mergeAudioMetadata, qualityCheck, rankFolder, withinDirectory } from "./matching";
import type { SlskdPort } from "./port";
import { canAppendManualSearch, canInspectFolder, canQueueSearchHits, isFolderPreviewExpired, remoteFileKey } from "../shared/search-selection";

export class Workflow {
  constructor(readonly store: Store, readonly port: SlskdPort, readonly config: Config) {}

  private async browseFiles(request: MusicRequest, username: string, directory: string, recursive: boolean): Promise<RemoteFile[]> {
    const browsed = await this.port.browse(username, directory, recursive);
    const seeds = this.store.all<{ path: string; size: number; metadata: string }>(
      "SELECT path,size,metadata FROM candidates WHERE request_id=? AND username=?", request.id, username);
    const key = (path: string, size: number): string => JSON.stringify([path.replace(/\\/g, "/"), size]);
    const reported = new Map<string, AudioMetadata | null>();
    for (const seed of seeds) {
      const id = key(seed.path, seed.size);
      reported.set(id, reported.has(id) ? null : JSON.parse(seed.metadata) as AudioMetadata);
    }
    return browsed.map(file => {
      const metadata = reported.get(key(file.path, file.size));
      return metadata ? { ...file, metadata: mergeAudioMetadata(file.metadata, metadata) } : file;
    });
  }

  async preview(request: MusicRequest, candidate: Candidate, recursive: boolean,
    automatic = request.mode === "automatic"): Promise<FolderPreview> {
    if (!["album_folder", "search"].includes(request.type) || request.id !== candidate.request_id)
      throw new ApiError(400, "Not a folder candidate");
    this.store.event("info", "folder", "browse_started", "Browsing remote folder", { batchId: request.batch_id, requestId: request.id },
      { username: candidate.username, directory: candidate.directory, recursive });
    try {
      const all = await this.browseFiles(request, candidate.username, candidate.directory, recursive);
      const bounded = all.filter(file => withinDirectory(file.path, candidate.directory, recursive));
      if (!bounded.length) throw new ApiError(404, "Selected directory is empty or inaccessible");
      const available = automatic ? bounded.filter(file => isSupportedAudioFile(file.path)) : bounded;
      if (!available.length) throw new ApiError(422, "No supported audio files in this folder");
      const previewLimit = automatic ? this.config.MAX_FOLDER_FILES : Math.max(1000, this.config.MAX_FOLDER_FILES);
      if (available.length > previewLimit)
        throw new ApiError(413, `Folder has ${available.length} files; inspection limit is ${previewLimit}. Select search hits or narrow the folder.`);
      const files: PreviewFile[] = available.map(file => ({
        ...file, ...(automatic ? qualityCheck(file, request.quality) : manualSelectionCheck(file))
      })).sort((a, b) => a.path.localeCompare(b.path));
      if (!Number.isSafeInteger(files.reduce((total, file) => total + file.size, 0)))
        throw new ApiError(413, "Folder size exceeds a reliable byte count");
      const eligibleBytes = files.reduce((total, file) => total + (file.eligible ? file.size : 0), 0);
      if (automatic && eligibleBytes > this.config.MAX_FOLDER_BYTES)
        throw new ApiError(413, "Eligible files exceed configured size limit");
      const latest = this.store.get<Pick<MusicRequest, "quality" | "type" | "mode" | "status">>(
        "SELECT quality,type,mode,status FROM requests WHERE id=?", request.id);
      if (!latest || latest.quality !== request.quality || latest.type !== request.type ||
        latest.mode !== request.mode || !canInspectFolder(latest))
        throw new ApiError(409, "Search settings changed; inspect this folder again");
      const preview = this.store.savePreview({ request_id: request.id, username: candidate.username,
        directory: candidate.directory, recursive, files });
      this.store.event("success", "folder", "browse_completed",
        `Folder inspected: ${files.length} files, ${preview.eligible_count} selectable, ${preview.excluded_count} unavailable`,
        { batchId: request.batch_id, requestId: request.id },
        { directory: candidate.directory, folderBytes: preview.audio_bytes, eligibleBytes,
          ignoredNonAudio: bounded.length - available.length });
      return preview;
    } catch (error) {
      this.store.event("error", "folder", "browse_failed", `Could not inspect folder: ${error instanceof Error ? error.message : "Unknown error"}`,
        { batchId: request.batch_id, requestId: request.id });
      throw error;
    }
  }

  async queueFolder(request: MusicRequest, preview: FolderPreview, selectedPaths?: string[],
    automatic = request.mode === "automatic"): Promise<string> {
    if (preview.request_id !== request.id || !["album_folder", "search"].includes(request.type))
      throw new ApiError(400, "Invalid folder preview");
    if (isFolderPreviewExpired(preview.created_at)) throw new ApiError(409, "Folder preview expired; inspect again");
    const eligible = preview.files.filter(file => automatic ?
      file.eligible && qualityCheck(file, request.quality).eligible : manualSelectionCheck(file).eligible);
    if (!eligible.length) throw new ApiError(422, "No selectable files in this folder");
    if (selectedPaths && new Set(selectedPaths).size !== selectedPaths.length)
      throw new ApiError(400, "Duplicate file selection");
    const included = new Set(selectedPaths ?? eligible.map(file => file.path));
    if (!included.size) throw new ApiError(422, "Select at least one file");
    if (included.size > this.config.MAX_FOLDER_FILES)
      throw new ApiError(413, `Select at most ${this.config.MAX_FOLDER_FILES} files at a time`);
    if ([...included].some(path => !eligible.some(file => file.path === path)))
      throw new ApiError(422, "Selection contains files outside this folder or unavailable for download");
    const selected = eligible.filter(file => included.has(file.path));
    const selectedBytes = selected.reduce((sum, file) => sum + file.size, 0);
    if (selectedBytes > this.config.MAX_FOLDER_BYTES) throw new ApiError(413, "Selected files exceed configured size limit");
    const seed = this.store.get<{ score: number }>(
      "SELECT MAX(score) AS score FROM candidates WHERE request_id=? AND username=? AND directory=?",
      request.id, preview.username, preview.directory);
    if (seed?.score == null) throw new ApiError(409, "Folder has no matching search candidate");
    const evidence = rankFolder(request, preview.directory, preview.files, seed.score);
    const current = await this.browseFiles(request, preview.username, preview.directory, preview.recursive);
    const now = current.filter(file => withinDirectory(file.path, preview.directory, preview.recursive))
      .filter(file => !automatic || isSupportedAudioFile(file.path))
      .map(file => ({ ...file, ...(automatic ? qualityCheck(file, request.quality) : manualSelectionCheck(file)) }))
      .sort((a, b) => a.path.localeCompare(b.path));
    const signature = (files: PreviewFile[]) => JSON.stringify(files.map(file =>
      [file.username, file.path, file.size, file.metadata, ...(automatic ? [file.eligible] : [])]));
    if (signature(now) !== signature(preview.files))
      throw new ApiError(409, "Remote folder changed or was inspected before all files were shown; refresh it before queueing");
    const id = randomUUID();
    this.store.transaction(() => {
      const latest = this.store.get<Pick<MusicRequest, "quality" | "type" | "mode" | "status">>(
        "SELECT quality,type,mode,status FROM requests WHERE id=?", request.id);
      if (!latest || latest.quality !== request.quality || latest.type !== request.type ||
        latest.mode !== request.mode || !canInspectFolder(latest))
        throw new ApiError(409, "Search settings changed; inspect this folder again");
      const queued = this.store.all<{ username: string; path: string }>(
        "SELECT username,path FROM transfers WHERE request_id=?", request.id);
      if (queued.length && !canAppendManualSearch(latest))
        throw new ApiError(409, "This request already has transfers; no duplicate enqueue");
      const queuedKeys = new Set(queued.map(remoteFileKey));
      if (selected.some(file => queuedKeys.has(remoteFileKey(file))))
        throw new ApiError(409, "Selection contains an already queued file");
      const remaining = eligible.filter(file => !queuedKeys.has(remoteFileKey(file)));
      const date = new Date().toISOString();
      this.updateFolderRemainders(request, queuedKeys, selected);
      this.store.run(`INSERT INTO folder_jobs(id,request_id,preview_id,username,directory,recursive,discovered_count,eligible_count,excluded_count,selected_count,unselected_count,estimated_bytes,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, request.id, preview.id, preview.username, preview.directory,
      Number(preview.recursive), preview.files.length, preview.eligible_count, preview.excluded_count,
      selected.length, remaining.length - selected.length, selectedBytes, "queueing", date, date);
      for (const file of selected) this.insertTransfer(request, id, file);
      this.store.run("UPDATE requests SET status='queueing',selected_directory=?,score=?,explanation=?,updated_at=? WHERE id=?",
        preview.directory, evidence.score, evidence.explanation, date, request.id);
      this.store.event("success", "folder", "confirmed",
        `${selected.length} of ${remaining.length} remaining files selected (${preview.excluded_count} unavailable, ${remaining.length - selected.length} unselected)`,
        { batchId: request.batch_id, requestId: request.id, folderJobId: id },
        { directory: preview.directory, username: preview.username, selectedBytes, evidence });
    });
    return id;
  }

  queueTrack(request: MusicRequest, candidate: Candidate, automatic = request.mode === "automatic"): string {
    if (candidate.request_id !== request.id || !["track", "search"].includes(request.type) ||
      automatic && !candidate.eligible ||
      !(automatic ? qualityCheck(candidate, request.quality) : manualSelectionCheck(candidate)).eligible)
      throw new ApiError(422, "Selected file is unavailable for download");
    const id = randomUUID();
    this.store.transaction(() => {
      if (this.store.get("SELECT id FROM transfers WHERE request_id=? LIMIT 1", request.id))
        throw new ApiError(409, "This request already has a transfer");
      const date = new Date().toISOString();
      this.store.run(`INSERT INTO transfers(id,queue_id,request_id,folder_job_id,username,path,size,status,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,'ready',?,?)`, id, id, request.id, null, candidate.username, candidate.path, candidate.size, date, date);
      this.store.run("UPDATE candidates SET selected=1 WHERE id=?", candidate.id);
      this.store.run(`UPDATE requests SET status='queueing',selected_candidate_id=?,score=?,explanation=?,updated_at=? WHERE id=?`,
        candidate.id, candidate.score, candidate.explanation, date, request.id);
      this.store.event("success", "selection", "track_selected", `Selected ${candidate.path} for single-file download`,
        { batchId: request.batch_id, requestId: request.id, transferId: id }, { score: candidate.score, reason: candidate.reason });
    });
    return id;
  }

  queueSearchHits(request: MusicRequest, candidateIds: string[]): string[] {
    if (!["search", "album_folder"].includes(request.type)) throw new ApiError(400, "Not a search-hit request");
    if (!candidateIds.length) throw new ApiError(422, "Select at least one file");
    if (candidateIds.length > this.config.MAX_FOLDER_FILES) throw new ApiError(413, "Selection exceeds configured file limit");
    if (new Set(candidateIds).size !== candidateIds.length) throw new ApiError(400, "Duplicate file selection");
    return this.store.transaction(() => {
      const latest = this.store.get<Pick<MusicRequest, "status" | "type" | "mode" | "quality">>(
        "SELECT status,type,mode,quality FROM requests WHERE id=?", request.id);
      if (!latest || !canQueueSearchHits(latest) ||
        latest.type !== request.type || latest.mode !== request.mode || latest.quality !== request.quality)
        throw new ApiError(409, "Search settings changed; select files again");
      const queued = this.store.all<{ username: string; path: string }>(
        "SELECT username,path FROM transfers WHERE request_id=?", request.id);
      if (queued.length && !canAppendManualSearch(latest))
        throw new ApiError(409, "This search already has transfers; no duplicate enqueue");
      const selected = candidateIds.map(id => {
        const row = this.store.get<{ id: string; username: string; path: string; directory: string;
          size: number; metadata: string; eligible: number; score: number }>(
          "SELECT id,username,path,directory,size,metadata,eligible,score FROM candidates WHERE id=? AND request_id=?",
          id, request.id);
        if (!row) throw new ApiError(422, "Selection contains a file outside this search");
        const file: RemoteFile = { username: row.username, path: row.path, directory: row.directory,
          size: row.size, metadata: JSON.parse(row.metadata) as AudioMetadata };
        if (!(request.mode === "automatic" ?
          row.eligible && qualityCheck(file, request.quality).eligible : manualSelectionCheck(file).eligible))
          throw new ApiError(422, "Selection contains an ineligible file");
        return { ...row, file };
      });
      const paths = selected.map(item => JSON.stringify([item.username, item.path.replace(/\\/g, "/")]));
      if (new Set(paths).size !== paths.length) throw new ApiError(400, "Duplicate remote file selection");
      const queuedKeys = new Set(queued.map(remoteFileKey));
      if (selected.some(item => queuedKeys.has(remoteFileKey(item.file))))
        throw new ApiError(409, "Selection contains an already queued file");
      const totalBytes = selected.reduce((sum, item) => sum + item.file.size, 0);
      if (!Number.isSafeInteger(totalBytes) || totalBytes > this.config.MAX_FOLDER_BYTES)
        throw new ApiError(413, "Selected files exceed configured size limit");
      const ids = selected.map(item => this.insertTransfer(request, null, item.file));
      this.updateFolderRemainders(request, queuedKeys, selected.map(item => item.file));
      for (const item of selected) this.store.run("UPDATE candidates SET selected=1 WHERE id=?", item.id);
      const date = new Date().toISOString();
      this.store.run(`UPDATE requests SET status='queueing',selected_candidate_id=?,selected_directory=?,
        score=?,explanation=?,updated_at=? WHERE id=?`,
      selected.length === 1 ? selected[0]!.id : null,
      selected.length === 1 ? selected[0]!.directory : null,
      selected.length === 1 ? selected[0]!.score : null,
      `${selected.length} search hits selected`, date, request.id);
      this.store.event("success", "selection", "hits_selected",
        `Selected ${selected.length} search hits (${totalBytes} bytes)`,
        { batchId: request.batch_id, requestId: request.id }, { selectedCount: selected.length, totalBytes });
      return ids;
    });
  }

  private updateFolderRemainders(request: MusicRequest, queued: ReadonlySet<string>, selected: RemoteFile[]): void {
    const allQueued = new Set([...queued, ...selected.map(remoteFileKey)]);
    const jobs = this.store.all<{ id: string; files: string }>(
      `SELECT j.id,p.files FROM folder_jobs j JOIN folder_previews p ON p.id=j.preview_id
       WHERE j.request_id=?`, request.id);
    for (const job of jobs) {
      const remaining = (JSON.parse(job.files) as PreviewFile[]).filter(file =>
        (request.mode === "automatic" ? qualityCheck(file, request.quality) : manualSelectionCheck(file)).eligible &&
        !allQueued.has(remoteFileKey(file))).length;
      this.store.run("UPDATE folder_jobs SET unselected_count=?,updated_at=? WHERE id=?",
        remaining, new Date().toISOString(), job.id);
    }
  }

  private insertTransfer(request: MusicRequest, jobId: string | null, file: RemoteFile): string {
    const date = new Date().toISOString();
    const id = randomUUID();
    this.store.run(`INSERT INTO transfers(id,queue_id,request_id,folder_job_id,username,path,size,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,'ready',?,?)`, id, id, request.id, jobId, file.username, file.path, file.size, date, date);
    return id;
  }

  showAllResults(request: MusicRequest): void {
    if (request.quality === "any" || !["review", "no_results"].includes(request.status) ||
      this.store.get("SELECT id FROM transfers WHERE request_id=? LIMIT 1", request.id))
      throw new ApiError(409, "Only an unqueued, quality-limited search can show all results");
    const candidates = this.store.all<{ id: string; path: string; size: number; metadata: string }>(
      "SELECT id,path,size,metadata FROM candidates WHERE request_id=?", request.id);
    const previews = this.store.all<{ id: string; files: string }>(
      "SELECT id,files FROM folder_previews WHERE request_id=?", request.id);
    let available = 0;
    this.store.transaction(() => {
      for (const candidate of candidates) {
        const result = manualSelectionCheck(candidate);
        if (result.eligible) available++;
        this.store.run("UPDATE candidates SET eligible=?,reason=? WHERE id=?",
          Number(result.eligible), result.reason, candidate.id);
      }
      for (const preview of previews) {
        const files = (JSON.parse(preview.files) as PreviewFile[]).map(file => ({
          ...file, ...manualSelectionCheck(file)
        }));
        this.store.run("UPDATE folder_previews SET files=? WHERE id=?", JSON.stringify(files), preview.id);
      }
      this.store.run(`UPDATE requests SET quality='any',type='search',mode='review',status=?,error=?,updated_at=? WHERE id=?`,
        available ? "review" : "no_results",
        available ? null : candidates.length ? "No selectable search hits; inspect folders for more files" :
          "Soulseek returned no files for this text search",
        new Date().toISOString(), request.id);
      this.store.event("info", "search", "quality_limit_removed",
        `All files enabled without a new search (${available} searchable files)`,
        { batchId: request.batch_id, requestId: request.id });
    });
  }

  retry(request: MusicRequest, quality: Quality, longer = false): void {
    this.store.transaction(() => {
      if (this.store.get("SELECT id FROM transfers WHERE request_id=? LIMIT 1", request.id))
        throw new ApiError(409, "Existing transfers cannot be blindly retried or enqueued again");
      this.store.run("DELETE FROM folder_previews WHERE request_id=?", request.id);
      this.store.run("DELETE FROM candidates WHERE request_id=?", request.id);
      this.store.run(`UPDATE requests SET quality=?,status='pending',search_id=NULL,search_started_at=NULL,
        search_window_ms=?,search_stop_requested_at=NULL,search_file_count=0,search_response_count=0,
        selected_candidate_id=NULL,selected_directory=NULL,score=NULL,explanation=NULL,error=NULL,
        retries=0,next_attempt_at=NULL,updated_at=? WHERE id=?`, quality,
      longer ? this.config.SEARCH_TIMEOUT_MS - 5000 : this.config.SEARCH_FAST_WINDOW_MS, new Date().toISOString(), request.id);
      this.store.event("info", "search", "retry_requested", `Retry requested with ${quality} quality (${longer ? "long" : "fast"} search)`,
        { batchId: request.batch_id, requestId: request.id });
    });
  }
}
