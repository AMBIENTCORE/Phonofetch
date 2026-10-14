import { randomUUID } from "node:crypto";
import type { Candidate, FolderJob, MusicRequest, RemoteFile, RequestStatus, TransferItem } from "../shared/types";
import type { Config } from "./config";
import { Store } from "./db";
import { manualSelectionCheck, normalize, qualityCheck, rankFile, rankFolder } from "./matching";
import type { RemoteTransfer, SlskdPort } from "./port";
import { Workflow } from "./workflow";

export class Worker {
  private readonly owner = randomUUID();
  private timer?: ReturnType<typeof setInterval>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private running = false;
  private stopped = false;
  private connected: boolean | null = null;
  private lastConnectivityCheck = 0;
  constructor(private readonly store: Store, private readonly port: SlskdPort,
    private readonly config: Config, private readonly workflow: Workflow) {}

  start(): void {
    const deadline = new Date(Date.now() + 45000).toISOString();
    this.store.transaction(() => {
      this.store.run(`INSERT INTO worker_lock(id,owner,expires_at) VALUES(1,?,?)
        ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at
        WHERE worker_lock.expires_at < ?`, this.owner, deadline, new Date().toISOString());
      if (this.store.get<{ owner: string }>("SELECT owner FROM worker_lock WHERE id=1")?.owner !== this.owner)
        throw new Error("Another Phonofetch worker owns this database; run only one replica");
    });
    this.store.event("info", "system", "startup", "Background worker started");
    this.heartbeat = setInterval(() => {
      this.store.run("UPDATE worker_lock SET expires_at=? WHERE id=1 AND owner=?",
        new Date(Date.now() + 45000).toISOString(), this.owner);
      if (this.store.get<{ owner: string }>("SELECT owner FROM worker_lock WHERE id=1")?.owner !== this.owner) {
        this.store.event("error", "system", "lock_lost", "Worker lock lost; stopping processing");
        this.stop();
      }
    }, 10000);
    this.timer = setInterval(() => { void this.runOnce().catch(error =>
      this.store.event("error", "worker", "cycle_failed", `Worker cycle failed: ${this.message(error)}`)); }, 1000);
    void this.runOnce().catch(error =>
      this.store.event("error", "worker", "startup_recovery_failed", `Startup reconciliation failed: ${this.message(error)}`));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.timer = undefined; this.heartbeat = undefined;
    while (this.running) await new Promise(resolve => setTimeout(resolve, 50));
    this.store.run("DELETE FROM worker_lock WHERE id=1 AND owner=?", this.owner);
    this.store.event("info", "system", "shutdown", "Background worker stopped");
  }

  async runOnce(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      let live: RemoteTransfer[];
      try {
        if (this.connected !== true || Date.now() - this.lastConnectivityCheck > 30000) {
          await this.port.check();
          this.lastConnectivityCheck = Date.now();
        }
        live = await this.port.transfers();
        if (this.connected !== true) {
          this.connected = true;
          this.store.event("success", "slskd", "connected", "slskd authenticated and logged in to Soulseek; transfer reconciliation available");
        }
      } catch (error) {
        if (this.connected !== false) {
          this.connected = false;
          this.store.event("error", "slskd", "unavailable", `slskd unavailable: ${this.message(error)}`);
        }
        return;
      }
      if (this.stopped) return;
      await this.reconcile(live);
      await this.enqueueReady(live);
      await this.startPending();
      const searching = this.store.all<MusicRequest>("SELECT * FROM requests WHERE status='searching' ORDER BY created_at LIMIT 20");
      await Promise.all(searching.slice(0, this.config.SEARCH_CONCURRENCY).map(request => this.poll(request)));
    } finally {
      this.running = false;
    }
  }

  private message(error: unknown): string {
    return this.store.redact(error instanceof Error ? error.message : "Unexpected error");
  }

  private failureReason(transfer: RemoteTransfer): string | null {
    return transfer.status === "failed" ?
      this.store.redact(transfer.error?.trim() || "slskd reported failure without a detailed reason") : null;
  }

  private async startPending(): Promise<void> {
    const active = this.store.get<{ count: number }>("SELECT COUNT(*) AS count FROM requests WHERE status='searching'")?.count ?? 0;
    const slots = Math.max(0, this.config.SEARCH_CONCURRENCY - active);
    if (!slots) return;
    const pending = this.store.all<MusicRequest>(
      "SELECT * FROM requests WHERE status='pending' AND (next_attempt_at IS NULL OR next_attempt_at<=?) ORDER BY created_at LIMIT ?",
      new Date().toISOString(), slots);
    await Promise.all(pending.map(async request => {
      const query = normalize(request.query_text);
      if (!query) {
        this.store.run("UPDATE requests SET status='failed',error=?,updated_at=? WHERE id=?",
          "Search line contains no searchable text", new Date().toISOString(), request.id);
        this.store.event("error", "search", "invalid_query", "Search line contains no searchable text",
          { batchId: request.batch_id, requestId: request.id });
        return;
      }
      const date = new Date().toISOString();
      this.store.run("UPDATE requests SET status='searching',search_started_at=?,updated_at=? WHERE id=? AND status='pending'",
        date, date, request.id);
      this.store.event("info", "search", "started", `Soulseek text search: ${query}`,
        { batchId: request.batch_id, requestId: request.id }, { query, windowMs: request.search_window_ms });
      try {
        const id = await this.port.startSearch(query, request.search_window_ms);
        this.store.run("UPDATE requests SET search_id=?,updated_at=? WHERE id=?", id, new Date().toISOString(), request.id);
        this.store.event("info", "search", "submitted", `slskd accepted search ${id}`,
          { batchId: request.batch_id, requestId: request.id });
      } catch (error) { this.retrySearch(request, error); }
    }));
  }

  private retrySearch(request: MusicRequest, error: unknown): void {
    const retries = request.retries + 1;
    const message = this.message(error);
    if (retries <= this.config.MAX_RETRIES) {
      const delay = Math.min(60000, 2000 * 2 ** (retries - 1));
      this.store.run("UPDATE requests SET status='pending',retries=?,error=?,search_id=NULL,search_stop_requested_at=NULL,next_attempt_at=?,updated_at=? WHERE id=?",
        retries, message, new Date(Date.now() + delay).toISOString(), new Date().toISOString(), request.id);
      this.store.event("warning", "search", "retry", `Search failed; retry ${retries}/${this.config.MAX_RETRIES} in ${delay / 1000}s: ${message}`,
        { batchId: request.batch_id, requestId: request.id });
    } else {
      this.store.run("UPDATE requests SET status='failed',error=?,updated_at=? WHERE id=?",
        message, new Date().toISOString(), request.id);
      this.store.event("error", "search", "failed", `Search failed after bounded retries: ${message}`,
        { batchId: request.batch_id, requestId: request.id });
    }
  }

  private async poll(request: MusicRequest): Promise<void> {
    if (!request.search_id) {
      if (request.search_started_at && Date.now() - Date.parse(request.search_started_at) < this.config.SEARCH_TIMEOUT_MS) return;
      this.store.run("UPDATE requests SET status='failed',error=?,updated_at=? WHERE id=?",
        "Search creation may have succeeded before restart; retry manually", new Date().toISOString(), request.id);
      this.store.event("warning", "recovery", "search_uncertain", "Search ID unavailable after restart; not starting a duplicate automatically",
        { batchId: request.batch_id, requestId: request.id });
      return;
    }
    const elapsed = request.search_started_at ? Date.now() - Date.parse(request.search_started_at) : 0;
    if (elapsed > Math.max(this.config.SEARCH_TIMEOUT_MS, request.search_window_ms + 10000)) {
      this.store.run("UPDATE requests SET status='failed',error=?,updated_at=? WHERE id=?",
        "Search timed out; retry manually", new Date().toISOString(), request.id);
      this.store.event("warning", "search", "timeout", "Search timed out",
        { batchId: request.batch_id, requestId: request.id });
      return;
    }
    try {
      const snapshot = await this.port.getSearch(request.search_id);
      if (!snapshot.finished) {
        if (elapsed >= request.search_window_ms && !request.search_stop_requested_at) {
          await this.port.stopSearch(request.search_id);
          const now = new Date().toISOString();
          this.store.run("UPDATE requests SET search_stop_requested_at=?,updated_at=? WHERE id=? AND status='searching'",
            now, now, request.id);
          this.store.event("info", "search", "window_reached",
            `Search window ended after ${request.search_window_ms / 1000}s; collecting responses from slskd`,
            { batchId: request.batch_id, requestId: request.id });
        }
        if (request.search_file_count !== snapshot.reportedFileCount ||
          request.search_response_count !== snapshot.reportedResponseCount)
          this.store.run("UPDATE requests SET search_file_count=?,search_response_count=? WHERE id=?",
            snapshot.reportedFileCount, snapshot.reportedResponseCount, request.id);
        return;
      }
      if (/\bErrored\b/i.test(snapshot.state)) {
        this.retrySearch(request, new Error(`slskd search ended in ${snapshot.state} with ${snapshot.reportedResponseCount} responses`));
        return;
      }
      if (/\bCancelled\b/i.test(snapshot.state) && !request.search_stop_requested_at) {
        this.store.run("UPDATE requests SET status='cancelled',error=?,updated_at=? WHERE id=?",
          `slskd search was cancelled (${snapshot.state})`, new Date().toISOString(), request.id);
        this.store.event("warning", "search", "cancelled", `slskd search ${request.search_id} was cancelled`,
          { batchId: request.batch_id, requestId: request.id });
        return;
      }
      const dedup = new Map<string, RemoteFile>();
      for (const file of snapshot.results) {
        dedup.set(`${file.username}\0${file.path}`, file);
      }
      const candidates: Candidate[] = Array.from(dedup.values()).map(file => {
        const eligibility = request.mode === "automatic" ?
          qualityCheck(file, request.quality) : manualSelectionCheck(file);
        const relevance = rankFile(request, file);
        return { ...file, ...eligibility, ...relevance, request_id: request.id, id: randomUUID(), selected: false };
      }).sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.score - a.score ||
        Number(b.free_slot === true) - Number(a.free_slot === true) ||
        (b.upload_speed ?? -1) - (a.upload_speed ?? -1)).slice(0, this.config.SEARCH_RESULT_LIMIT);
      this.store.transaction(() => {
        for (const candidate of candidates) {
          this.store.run(`INSERT OR IGNORE INTO candidates(id,request_id,username,path,directory,size,metadata,eligible,reason,score,explanation,selected,upload_speed,queue_length,free_slot)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,0,?,?,?)`, candidate.id, request.id, candidate.username, candidate.path, candidate.directory,
          candidate.size, JSON.stringify(candidate.metadata), Number(candidate.eligible), candidate.reason, candidate.score, candidate.explanation,
          candidate.upload_speed ?? null, candidate.queue_length ?? null, candidate.free_slot == null ? null : Number(candidate.free_slot));
        }
        const hasEligible = candidates.some(c => c.eligible);
        this.store.run("UPDATE requests SET status=?,error=?,search_file_count=?,search_response_count=?,updated_at=? WHERE id=?",
          hasEligible ? "review" : "no_results",
          hasEligible ? null : candidates.length ?
            request.quality === "any" ? "No supported audio files in the search results" :
              "No files met the selected quality requirements" :
            "Soulseek returned no files for this text search",
          snapshot.reportedFileCount, snapshot.reportedResponseCount, new Date().toISOString(), request.id);
        this.store.event("info", "search", "completed",
          `Search ${snapshot.state}: ${snapshot.results.length} files returned, ${candidates.length} distinct, ${candidates.filter(c => c.eligible).length} eligible`,
          { batchId: request.batch_id, requestId: request.id },
          { searchId: request.search_id, reportedFileCount: snapshot.reportedFileCount, reportedResponseCount: snapshot.reportedResponseCount });
        if (request.type === "album_folder" || request.type === "search") {
          const folders = new Map<string, Candidate>();
          for (const candidate of candidates) {
            const key = `${candidate.username}\0${candidate.directory}`;
            if (!folders.has(key)) folders.set(key, candidate);
          }
          for (const candidate of folders.values()) this.store.event("info", "folder", "candidate_discovered",
            `Candidate folder ${candidate.username}: ${candidate.directory}; seed relevance ${Math.round(candidate.score * 100)}%`,
            { batchId: request.batch_id, requestId: request.id });
        }
      });
      if (request.mode === "automatic") await this.autoSelect(request, candidates);
    } catch (error) {
      this.store.event("warning", "search", "poll_failed", `Search polling error: ${this.message(error)}`,
        { batchId: request.batch_id, requestId: request.id });
    }
  }

  private async autoSelect(request: MusicRequest, candidates: Candidate[]): Promise<void> {
    const eligible = candidates.filter(c => c.eligible);
    if (!eligible.length) {
      this.store.event("warning", "automatic", "left_for_review", "No quality-eligible results; never lowering required quality",
        { batchId: request.batch_id, requestId: request.id }); return;
    }
    if (request.type === "track") {
      const [best, second] = eligible;
      if (best && best.score >= this.config.AUTO_TRACK_SCORE && (!second || best.score - second.score >= 0.1)) {
        this.workflow.queueTrack(request, best, true);
        this.store.event("info", "automatic", "selected", `High-confidence track: ${best.explanation}; ${best.reason}`,
          { batchId: request.batch_id, requestId: request.id }, { score: best.score });
      } else this.store.event("warning", "automatic", "left_for_review", "Track confidence or uniqueness below automatic threshold",
        { batchId: request.batch_id, requestId: request.id });
      return;
    }
    if (request.type === "search") {
      this.store.event("warning", "automatic", "left_for_review", "Manual search requires explicit file or folder selection",
        { batchId: request.batch_id, requestId: request.id }); return;
    }
    if (request.seed_kind === "track_seed") {
      this.store.event("warning", "automatic", "left_for_review", "Track-seeded folder requires manual album confirmation",
        { batchId: request.batch_id, requestId: request.id }); return;
    }
    const folders = Array.from(new Map(eligible.map(candidate => [`${candidate.username}\0${candidate.directory}`, candidate])).values());
    const [best, second] = folders;
    if (!best || (second && best.score - second.score < 0.1)) {
      this.store.event("warning", "automatic", "left_for_review", "Several plausible folders; manual review required",
        { batchId: request.batch_id, requestId: request.id }); return;
    }
    try {
      const preview = await this.workflow.preview(request, best, false, true);
      const evidence = rankFolder(request, best.directory, preview.files, best.score);
      if (evidence.score >= this.config.AUTO_ALBUM_SCORE && preview.eligible_count >= 2 && preview.excluded_count === 0 &&
        preview.files.some(file => file.path === best.path)) {
        await this.workflow.queueFolder(request, preview, undefined, true);
        this.store.event("info", "automatic", "selected", `Album selected: ${evidence.explanation}; all files quality-eligible`,
          { batchId: request.batch_id, requestId: request.id }, { score: evidence.score });
      } else this.store.event("warning", "automatic", "left_for_review",
        `Album requires manual review: ${evidence.explanation}; ${preview.excluded_count} excluded files or seed file absent`,
        { batchId: request.batch_id, requestId: request.id });
    } catch (error) {
      this.store.event("warning", "automatic", "left_for_review", `Album browse/verification failed: ${this.message(error)}`,
        { batchId: request.batch_id, requestId: request.id });
    }
  }

  private async reconcile(live: RemoteTransfer[]): Promise<void> {
    const byKey = new Map(live.map(item => [`${item.username}\0${item.path}`, item]));
    const byBatch = new Map(live.filter(item => item.batchId).map(item => [item.batchId, item]));
    const items = this.store.all<TransferItem>(
      "SELECT * FROM transfers WHERE status IN ('ready','queueing','queued','active','failed','cancelled','uncertain')");
    for (const item of items) {
      const samePath = byKey.get(`${item.username}\0${item.path}`);
      const remote = byBatch.get(item.queue_id ?? item.id) ??
        (item.retries || (item.status === "ready" && samePath && ["failed", "cancelled"].includes(samePath.status)) ?
          undefined : samePath);
      if (remote && (remote.username !== item.username || remote.path !== item.path)) continue;
      if (remote) {
        const changed = item.status !== remote.status;
        const reason = this.failureReason(remote);
        const progress = Math.round(100 * Math.min(1, remote.transferred / Math.max(1, item.size)));
        this.store.run(`UPDATE transfers SET status=?,slskd_id=?,transferred=?,progress=?,error=?,updated_at=?,
          stat_epoch=CASE WHEN ?='completed' THEN (SELECT epoch FROM download_stats WHERE id=1) ELSE stat_epoch END,
          hidden_from_downloads=CASE WHEN status<>? THEN 0 ELSE hidden_from_downloads END WHERE id=?`,
          remote.status, remote.id, remote.transferred, progress, reason, new Date().toISOString(), remote.status, remote.status, item.id);
        const request = this.store.get<MusicRequest>("SELECT * FROM requests WHERE id=?", item.request_id);
        if (["ready", "queueing", "uncertain"].includes(item.status))
          this.store.event("info", "recovery", "transfer_found",
            `Existing slskd transfer found for ${item.path}; no duplicate enqueue`,
            { batchId: request?.batch_id, requestId: item.request_id, transferId: item.id });
        if ((changed || remote.status === "failed" && item.error !== reason) && request)
          this.store.event(remote.status === "completed" ? "success" : remote.status === "failed" ? "error" : "info",
          "transfer", remote.status, `${item.path}: ${remote.status}${reason ? ` · ${reason}` : ""}`,
          { batchId: request.batch_id, requestId: item.request_id, folderJobId: item.folder_job_id ?? undefined, transferId: item.id });
        else if (Math.floor(progress / 10) > Math.floor(item.progress / 10) && request)
          this.store.event("info", "transfer", "progress", `${item.path}: ${progress}%`,
            { batchId: request.batch_id, requestId: item.request_id, transferId: item.id });
      } else if (item.status === "queueing" && Date.now() - Date.parse(item.updated_at) > 30000) {
        this.store.run("UPDATE transfers SET status='uncertain',error=?,updated_at=? WHERE id=?",
          "Queue acknowledgement lost; inspect slskd before retrying", new Date().toISOString(), item.id);
        this.store.event("warning", "recovery", "enqueue_uncertain",
          `Cannot safely determine whether ${item.path} was queued; not enqueueing again`,
          { requestId: item.request_id, transferId: item.id });
      } else if (["queued", "active"].includes(item.status) &&
        Date.now() - Date.parse(item.updated_at) > 120000) {
        this.store.run("UPDATE transfers SET status='uncertain',error=?,updated_at=? WHERE id=?",
          "Transfer disappeared from slskd before completion could be verified", new Date().toISOString(), item.id);
        this.store.event("warning", "recovery", "transfer_missing",
          `slskd no longer reports ${item.path}; completion cannot be assumed`,
          { requestId: item.request_id, transferId: item.id });
      }
    }
    this.updateAggregates();
  }

  private async enqueueReady(live: RemoteTransfer[]): Promise<void> {
    const byKey = new Map(live.map(item => [`${item.username}\0${item.path}`, item]));
    const byBatch = new Map(live.filter(item => item.batchId).map(item => [item.batchId, item]));
    const ready = this.store.all<TransferItem>("SELECT * FROM transfers WHERE status='ready' ORDER BY created_at LIMIT 20");
    for (const item of ready) {
      const samePath = byKey.get(`${item.username}\0${item.path}`);
      const existing = byBatch.get(item.queue_id ?? item.id) ??
        (item.retries || (samePath && ["failed", "cancelled"].includes(samePath.status)) ? undefined : samePath);
      if (existing) {
        const reason = this.failureReason(existing);
        this.store.run(`UPDATE transfers SET status=?,slskd_id=?,transferred=?,error=?,updated_at=?,
          stat_epoch=CASE WHEN ?='completed' THEN (SELECT epoch FROM download_stats WHERE id=1) ELSE stat_epoch END WHERE id=?`,
          existing.status, existing.id, existing.transferred, reason, new Date().toISOString(), existing.status, item.id);
        this.store.event("info", "recovery", "transfer_found", `Existing slskd transfer found for ${item.path}; no duplicate enqueue`,
          { requestId: item.request_id, transferId: item.id });
        if (reason) this.store.event("error", "transfer", "failed", `${item.path}: failed · ${reason}`,
          { requestId: item.request_id, transferId: item.id });
        continue;
      }
      this.store.run("UPDATE transfers SET status='queueing',updated_at=? WHERE id=? AND status='ready'",
        new Date().toISOString(), item.id);
      try {
        const request = this.store.get<MusicRequest>("SELECT * FROM requests WHERE id=?", item.request_id);
        if (!request) throw new Error("Request missing");
        const preview = item.folder_job_id ? this.store.get<{ files: string }>(
          "SELECT p.files FROM folder_previews p JOIN folder_jobs j ON j.preview_id=p.id WHERE j.id=?", item.folder_job_id) : undefined;
        const metadata = item.folder_job_id ?
          preview && (JSON.parse(preview.files) as Array<RemoteFile & { eligible: boolean }>)
            .find(file => file.username === item.username && file.path === item.path && file.size === item.size)?.metadata :
          this.store.get<{ metadata: string }>(`SELECT metadata FROM candidates
            WHERE request_id=? AND username=? AND path=? AND size=? AND selected=1`,
          item.request_id, item.username, item.path, item.size)?.metadata;
        if (!metadata) throw new Error("Selected file metadata missing; refusing to queue");
        const file: RemoteFile = { username: item.username, path: item.path, directory: request.selected_directory ?? "",
          size: item.size, metadata: typeof metadata === "string" ? JSON.parse(metadata) as RemoteFile["metadata"] : metadata };
        if (!(request.mode === "automatic" ?
          qualityCheck(file, request.quality).eligible : manualSelectionCheck(file).eligible))
          throw new Error("Stored candidate is unavailable for download; refusing to queue");
        const slskdId = await this.port.enqueue(item.username, file, item.queue_id ?? item.id);
        this.store.run("UPDATE transfers SET status='queued',slskd_id=?,updated_at=? WHERE id=?", slskdId, new Date().toISOString(), item.id);
        this.store.event("success", "transfer", "queued", `Queued ${item.path}`,
          { batchId: request.batch_id, requestId: item.request_id, folderJobId: item.folder_job_id ?? undefined, transferId: item.id });
      } catch (error) {
        this.store.run("UPDATE transfers SET status='uncertain',error=?,updated_at=? WHERE id=?",
          this.message(error), new Date().toISOString(), item.id);
        this.store.event("error", "transfer", "queue_uncertain", `Queue operation uncertain for ${item.path}: ${this.message(error)}. Check slskd; no automatic duplicate retry.`,
          { requestId: item.request_id, transferId: item.id });
      }
    }
    this.updateAggregates();
  }

  private updateAggregates(): void {
    const aggregate = (items: TransferItem[], partialFolder: boolean, folderJobs: boolean): RequestStatus => {
      if (items.some(item => item.status === "uncertain")) return "uncertain";
      const terminal = items.every(item => ["completed", "failed", "cancelled"].includes(item.status));
      if (terminal) {
        if (items.every(item => item.status === "completed")) return partialFolder ? "partial" : "completed";
        if (folderJobs && items.some(item => item.status === "completed")) return "partial";
        return items.every(item => item.status === "cancelled") ? "cancelled" : "failed";
      }
      return items.every(item => ["ready", "queueing"].includes(item.status)) ? "queueing" : "active";
    };
    const ids = this.store.all<{ request_id: string }>("SELECT DISTINCT request_id FROM transfers");
    for (const { request_id } of ids) {
      const transfers = this.store.all<TransferItem>("SELECT * FROM transfers WHERE request_id=?", request_id);
      const jobs = this.store.all<Pick<FolderJob, "id" | "status" | "excluded_count" | "unselected_count">>(
        "SELECT id,status,excluded_count,unselected_count FROM folder_jobs WHERE request_id=?", request_id);
      for (const job of jobs) {
        const files = transfers.filter(transfer => transfer.folder_job_id === job.id);
        if (!files.length) continue;
        const status = aggregate(files, Boolean(job.excluded_count || job.unselected_count), true);
        if (status !== job.status)
          this.store.run("UPDATE folder_jobs SET status=?,updated_at=? WHERE id=?",
            status, new Date().toISOString(), job.id);
      }
      const excluded = jobs.reduce((sum, job) => sum + job.excluded_count, 0);
      const unselected = jobs.reduce((sum, job) => sum + job.unselected_count, 0);
      const status = aggregate(transfers, Boolean(excluded || unselected), jobs.length > 0);
      const current = this.store.get<MusicRequest>("SELECT * FROM requests WHERE id=?", request_id);
      if (current && current.status !== status) {
        this.store.run("UPDATE requests SET status=?,updated_at=? WHERE id=?", status, new Date().toISOString(), request_id);
        this.store.event(status === "completed" ? "success" : ["partial", "failed", "uncertain"].includes(status) ? "warning" : "info",
          "request", "status_changed", `Request ${status}${excluded || unselected ?
            `; ${excluded} quality-excluded, ${unselected} unselected (partial folder)` : ""}`,
          { batchId: current.batch_id, requestId: request_id, folderJobId: jobs.length === 1 ? jobs[0]!.id : undefined });
      }
    }
  }
}
