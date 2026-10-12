import { randomUUID } from "node:crypto";
import type { Candidate, FolderPreview, MusicRequest, PreviewFile, RemoteFile, Quality } from "../shared/types";
import { ApiError } from "./auth";
import type { Config } from "./config";
import { Store } from "./db";
import { qualityCheck, rankFolder, withinDirectory } from "./matching";
import type { SlskdPort } from "./port";

export class Workflow {
  constructor(readonly store: Store, readonly port: SlskdPort, readonly config: Config) {}

  async preview(request: MusicRequest, candidate: Candidate, recursive: boolean): Promise<FolderPreview> {
    if (request.type !== "album_folder" || request.id !== candidate.request_id) throw new ApiError(400, "Not an album candidate");
    this.store.event("info", "folder", "browse_started", "Browsing remote folder", { batchId: request.batch_id, requestId: request.id },
      { username: candidate.username, directory: candidate.directory, recursive });
    try {
      const all = await this.port.browse(candidate.username, candidate.directory, recursive);
      const bounded = all.filter(file => withinDirectory(file.path, candidate.directory, recursive));
      if (bounded.length > this.config.MAX_FOLDER_FILES) throw new ApiError(413, "Folder exceeds configured file limit");
      if (!bounded.length) throw new ApiError(404, "Selected directory is empty or inaccessible");
      const audio = bounded.filter(file => /\.(mp3|flac|m4a|ogg|opus|wav|aac)$/i.test(file.path));
      if (!audio.length) throw new ApiError(422, "No supported audio files in this folder");
      const files: PreviewFile[] = audio.map(file => ({ ...file, ...qualityCheck(file, request.quality) })).sort((a, b) => a.path.localeCompare(b.path));
      if (!Number.isSafeInteger(files.reduce((total, file) => total + file.size, 0)))
        throw new ApiError(413, "Folder size exceeds a reliable byte count");
      const eligibleBytes = files.reduce((total, file) => total + (file.eligible ? file.size : 0), 0);
      if (eligibleBytes > this.config.MAX_FOLDER_BYTES) throw new ApiError(413, "Eligible files exceed configured size limit");
      const preview = this.store.savePreview({ request_id: request.id, username: candidate.username,
        directory: candidate.directory, recursive, files });
      this.store.event("success", "folder", "browse_completed",
        `Folder inspected: ${files.length} audio files, ${preview.eligible_count} eligible, ${preview.excluded_count} excluded`,
        { batchId: request.batch_id, requestId: request.id },
        { directory: candidate.directory, audioBytes: preview.audio_bytes, eligibleBytes,
          ignoredNonAudio: bounded.length - audio.length });
      for (const file of files.filter(item => !item.eligible))
        this.store.event("info", "quality", "folder_file_excluded", `${file.path}: ${file.reason}`,
          { batchId: request.batch_id, requestId: request.id });
      return preview;
    } catch (error) {
      this.store.event("error", "folder", "browse_failed", `Could not inspect folder: ${error instanceof Error ? error.message : "Unknown error"}`,
        { batchId: request.batch_id, requestId: request.id });
      throw error;
    }
  }

  async queueFolder(request: MusicRequest, preview: FolderPreview, selectedPaths?: string[]): Promise<string> {
    if (preview.request_id !== request.id || request.type !== "album_folder") throw new ApiError(400, "Invalid folder preview");
    if (Date.now() - Date.parse(preview.created_at) > 10 * 60 * 1000) throw new ApiError(409, "Folder preview expired; inspect again");
    const eligible = preview.files.filter(file => file.eligible && qualityCheck(file, request.quality).eligible);
    if (!eligible.length) throw new ApiError(422, "No files meet strict quality criteria");
    if (selectedPaths && new Set(selectedPaths).size !== selectedPaths.length)
      throw new ApiError(400, "Duplicate file selection");
    const included = new Set(selectedPaths ?? eligible.map(file => file.path));
    if (!included.size) throw new ApiError(422, "Select at least one eligible file");
    if (included.size > this.config.MAX_FOLDER_FILES ||
      [...included].some(path => !eligible.some(file => file.path === path)))
      throw new ApiError(422, "Selection contains files outside this folder or failing strict quality");
    const selected = eligible.filter(file => included.has(file.path));
    const selectedBytes = selected.reduce((sum, file) => sum + file.size, 0);
    if (selectedBytes > this.config.MAX_FOLDER_BYTES) throw new ApiError(413, "Selected files exceed configured size limit");
    const seed = this.store.get<{ score: number }>(
      "SELECT MAX(score) AS score FROM candidates WHERE request_id=? AND username=? AND directory=?",
      request.id, preview.username, preview.directory);
    if (seed?.score == null) throw new ApiError(409, "Folder has no matching search candidate");
    const evidence = rankFolder(request, preview.directory, preview.files, seed.score);
    const current = await this.port.browse(preview.username, preview.directory, preview.recursive);
    const now = current.filter(file => withinDirectory(file.path, preview.directory, preview.recursive))
      .filter(file => /\.(mp3|flac|m4a|ogg|opus|wav|aac)$/i.test(file.path))
      .map(file => ({ ...file, ...qualityCheck(file, request.quality) })).sort((a, b) => a.path.localeCompare(b.path));
    const signature = (files: PreviewFile[]) => JSON.stringify(files.map(file =>
      [file.username, file.path, file.size, file.metadata, file.eligible]));
    if (signature(now) !== signature(preview.files)) throw new ApiError(409, "Remote folder changed; inspect again before queueing");
    const id = randomUUID();
    this.store.transaction(() => {
      const active = this.store.get<{ id: string }>("SELECT id FROM transfers WHERE request_id=? LIMIT 1", request.id);
      if (active) throw new ApiError(409, "This request already has transfers; no duplicate enqueue");
      const date = new Date().toISOString();
      this.store.run(`INSERT INTO folder_jobs(id,request_id,preview_id,username,directory,recursive,discovered_count,eligible_count,excluded_count,selected_count,unselected_count,estimated_bytes,status,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, request.id, preview.id, preview.username, preview.directory,
      Number(preview.recursive), preview.files.length, preview.eligible_count, preview.excluded_count,
      selected.length, eligible.length - selected.length, selectedBytes, "queueing", date, date);
      for (const file of selected) this.insertTransfer(request, id, file);
      this.store.run("UPDATE requests SET status='queueing',selected_directory=?,score=?,explanation=?,updated_at=? WHERE id=?",
        preview.directory, evidence.score, evidence.explanation, date, request.id);
      this.store.event("success", "folder", "confirmed",
        `${selected.length} of ${eligible.length} eligible files selected (${preview.excluded_count} quality-excluded, ${eligible.length - selected.length} unselected)`,
        { batchId: request.batch_id, requestId: request.id, folderJobId: id },
        { directory: preview.directory, username: preview.username, selectedBytes, evidence });
    });
    return id;
  }

  queueTrack(request: MusicRequest, candidate: Candidate): string {
    if (candidate.request_id !== request.id || request.type !== "track" || !candidate.eligible ||
      !qualityCheck(candidate, request.quality).eligible) throw new ApiError(422, "Selected file does not meet strict quality criteria");
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

  private insertTransfer(request: MusicRequest, jobId: string, file: RemoteFile): void {
    const date = new Date().toISOString();
    const id = randomUUID();
    this.store.run(`INSERT INTO transfers(id,queue_id,request_id,folder_job_id,username,path,size,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,'ready',?,?)`, id, id, request.id, jobId, file.username, file.path, file.size, date, date);
  }

  retry(request: MusicRequest, quality: Quality): void {
    this.store.transaction(() => {
      if (this.store.get("SELECT id FROM transfers WHERE request_id=? LIMIT 1", request.id))
        throw new ApiError(409, "Existing transfers cannot be blindly retried or enqueued again");
      this.store.run("DELETE FROM folder_previews WHERE request_id=?", request.id);
      this.store.run("DELETE FROM candidates WHERE request_id=?", request.id);
      this.store.run(`UPDATE requests SET quality=?,status='pending',search_id=NULL,search_started_at=NULL,
        selected_candidate_id=NULL,selected_directory=NULL,score=NULL,explanation=NULL,error=NULL,
        retries=0,next_attempt_at=NULL,updated_at=? WHERE id=?`, quality, new Date().toISOString(), request.id);
      this.store.event("info", "search", "retry_requested", `Retry requested with ${quality} quality`,
        { batchId: request.batch_id, requestId: request.id });
    });
  }
}
