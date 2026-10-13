import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Activity, Batch, BatchDetail, Candidate, DownloadItem, DownloadsData, DownloadStats, FolderJob, FolderPreview, MusicRequest, PreviewFile, Severity, SlskdConnectionState, TransferItem } from "../shared/types";

type SqlValue = string | number | bigint | Buffer | null;

export function batchName(number: number, search: string, count: number): string {
  return `Search #${number}${search ? ` · ${search}` : ""}${count > 1 ? ` (+${count - 1} more)` : ""}`;
}

export class Store {
  readonly db: DatabaseSync;
  constructor(path: string, private readonly secrets: string[] = []) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000");
    const version = this.db.prepare("PRAGMA user_version").get()?.user_version;
    if (![0, 1, 2, 3, 4, 5, 6, 7, 8].includes(Number(version))) throw new Error(`Unsupported database version: ${String(version)}`);
    if (version === 0) {
      this.transaction(() => {
        this.db.exec(`
          CREATE TABLE batches (
            id TEXT PRIMARY KEY, number INTEGER NOT NULL UNIQUE, name TEXT NOT NULL, original_input TEXT NOT NULL,
            default_type TEXT NOT NULL, mode TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
          );
          CREATE TABLE requests (
            id TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES batches(id), position INTEGER NOT NULL,
            query_text TEXT NOT NULL, type TEXT NOT NULL,
            seed_kind TEXT NOT NULL, artist TEXT NOT NULL, title TEXT NOT NULL, original_input TEXT NOT NULL,
            norm_artist TEXT NOT NULL, norm_title TEXT NOT NULL, quality TEXT NOT NULL, mode TEXT NOT NULL,
            status TEXT NOT NULL, search_id TEXT, search_started_at TEXT,
            search_window_ms INTEGER NOT NULL DEFAULT 40000, search_stop_requested_at TEXT,
            search_file_count INTEGER NOT NULL DEFAULT 0, search_response_count INTEGER NOT NULL DEFAULT 0,
            selected_candidate_id TEXT,
            selected_directory TEXT, score REAL, explanation TEXT, error TEXT,
            retries INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
          );
          CREATE INDEX requests_work ON requests(status,next_attempt_at);
          CREATE INDEX requests_batch ON requests(batch_id);
          CREATE TABLE candidates (
            id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES requests(id), username TEXT NOT NULL,
            path TEXT NOT NULL, directory TEXT NOT NULL, size INTEGER NOT NULL, metadata TEXT NOT NULL,
            eligible INTEGER NOT NULL, reason TEXT NOT NULL, score REAL NOT NULL, explanation TEXT NOT NULL,
            selected INTEGER NOT NULL DEFAULT 0, upload_speed INTEGER, queue_length INTEGER, free_slot INTEGER,
            UNIQUE(request_id,username,path)
          );
          CREATE INDEX candidates_request ON candidates(request_id,score DESC);
          CREATE TABLE folder_previews (
            id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES requests(id), username TEXT NOT NULL,
            directory TEXT NOT NULL, recursive INTEGER NOT NULL, files TEXT NOT NULL, created_at TEXT NOT NULL
          );
          CREATE TABLE folder_jobs (
            id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES requests(id), preview_id TEXT NOT NULL REFERENCES folder_previews(id),
            username TEXT NOT NULL, directory TEXT NOT NULL, recursive INTEGER NOT NULL,
            discovered_count INTEGER NOT NULL, eligible_count INTEGER NOT NULL, excluded_count INTEGER NOT NULL,
            selected_count INTEGER NOT NULL, unselected_count INTEGER NOT NULL,
            estimated_bytes INTEGER NOT NULL, status TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
          );
          CREATE TABLE transfers (
            id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES requests(id), folder_job_id TEXT REFERENCES folder_jobs(id),
            username TEXT NOT NULL, path TEXT NOT NULL, size INTEGER NOT NULL, status TEXT NOT NULL,
            slskd_id TEXT, queue_id TEXT NOT NULL,
            transferred INTEGER NOT NULL DEFAULT 0, progress REAL NOT NULL DEFAULT 0,
            error TEXT, retries INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
            hidden_from_downloads INTEGER NOT NULL DEFAULT 0, stat_epoch INTEGER NOT NULL DEFAULT 0,
            UNIQUE(username,path,request_id)
          );
          CREATE INDEX transfers_status ON transfers(status);
          CREATE TABLE download_stats (id INTEGER PRIMARY KEY CHECK(id=1), epoch INTEGER NOT NULL DEFAULT 0);
          INSERT INTO download_stats(id,epoch) VALUES(1,0);
          CREATE TABLE activity (
            id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, severity TEXT NOT NULL,
            category TEXT NOT NULL, event_type TEXT NOT NULL, message TEXT NOT NULL,
            batch_id TEXT, request_id TEXT, folder_job_id TEXT, transfer_id TEXT, metadata TEXT NOT NULL DEFAULT '{}'
          );
          CREATE INDEX activity_time ON activity(id DESC);
          CREATE INDEX activity_batch ON activity(batch_id,id DESC);
          CREATE INDEX activity_request ON activity(request_id,id DESC);
          CREATE TABLE sessions (
            token_hash TEXT PRIMARY KEY, csrf_token TEXT NOT NULL, expires_at TEXT NOT NULL
          );
          CREATE TABLE worker_lock (
            id INTEGER PRIMARY KEY CHECK (id=1), owner TEXT NOT NULL, expires_at TEXT NOT NULL
          );
          PRAGMA user_version=8;
        `);
      });
    }
    if (version === 1) this.transaction(() => {
      this.db.exec("ALTER TABLE transfers ADD COLUMN slskd_id TEXT; PRAGMA user_version=2");
    });
    if (version === 1 || version === 2) this.transaction(() => {
      this.db.exec("ALTER TABLE requests ADD COLUMN position INTEGER NOT NULL DEFAULT 0; PRAGMA user_version=3");
    });
    if (version === 1 || version === 2 || version === 3) this.transaction(() => {
      this.db.exec("ALTER TABLE transfers ADD COLUMN queue_id TEXT; UPDATE transfers SET queue_id=id; PRAGMA user_version=4");
    });
    if (version === 1 || version === 2 || version === 3 || version === 4) this.transaction(() => {
      this.db.exec(`
        ALTER TABLE batches ADD COLUMN number INTEGER;
        UPDATE batches SET number = (
          SELECT COUNT(*) FROM batches AS earlier
          WHERE earlier.created_at < batches.created_at
            OR (earlier.created_at = batches.created_at AND earlier.id <= batches.id)
        );
        CREATE UNIQUE INDEX batches_number ON batches(number);
        ALTER TABLE requests ADD COLUMN query_text TEXT;
        UPDATE requests SET query_text = CASE
          WHEN TRIM(original_input) != '' THEN TRIM(original_input)
          ELSE TRIM(norm_artist || ' ' || norm_title) END;
        PRAGMA user_version=5;
      `);
    });
    if (version === 1 || version === 2 || version === 3 || version === 4 || version === 5) this.transaction(() => {
      this.db.exec(`ALTER TABLE folder_jobs ADD COLUMN selected_count INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE folder_jobs ADD COLUMN unselected_count INTEGER NOT NULL DEFAULT 0;
        UPDATE folder_jobs SET selected_count=eligible_count;
        PRAGMA user_version=6;`);
    });
    if (version === 1 || version === 2 || version === 3 || version === 4 || version === 5 || version === 6) this.transaction(() => {
      this.db.exec(`ALTER TABLE requests ADD COLUMN search_window_ms INTEGER NOT NULL DEFAULT 40000;
        ALTER TABLE requests ADD COLUMN search_stop_requested_at TEXT;
        ALTER TABLE requests ADD COLUMN search_file_count INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE requests ADD COLUMN search_response_count INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE candidates ADD COLUMN upload_speed INTEGER;
        ALTER TABLE candidates ADD COLUMN queue_length INTEGER;
        ALTER TABLE candidates ADD COLUMN free_slot INTEGER;
        PRAGMA user_version=7;`);
    });
    if (version !== 0 && Number(version) < 8) this.transaction(() => {
      this.db.exec(`ALTER TABLE transfers ADD COLUMN hidden_from_downloads INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE transfers ADD COLUMN stat_epoch INTEGER NOT NULL DEFAULT 0;
        CREATE TABLE download_stats (id INTEGER PRIMARY KEY CHECK(id=1), epoch INTEGER NOT NULL DEFAULT 0);
        INSERT INTO download_stats(id,epoch) VALUES(1,0);
        PRAGMA user_version=8;`);
    });
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  get<T>(sql: string, ...args: SqlValue[]): T | undefined {
    return this.db.prepare(sql).get(...args) as T | undefined;
  }

  all<T>(sql: string, ...args: SqlValue[]): T[] {
    return this.db.prepare(sql).all(...args) as T[];
  }

  run(sql: string, ...args: SqlValue[]): void {
    this.db.prepare(sql).run(...args);
  }

  redact(value: string): string {
    let safe = value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 1200)
      .replace(/(x-api-key|authorization|cookie|password|session_secret)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]");
    for (const secret of this.secrets.filter(Boolean)) safe = safe.split(secret).join("[redacted]");
    return safe;
  }

  event(severity: Severity, category: string, eventType: string, message: string,
    ids: { batchId?: string; requestId?: string; folderJobId?: string; transferId?: string } = {},
    metadata: Record<string, unknown> = {}): void {
    const safeMessage = this.redact(message);
    const safeMetadata = JSON.stringify(metadata, (key, value: unknown) =>
      /key|password|secret|cookie|authorization|token/i.test(key) ? "[redacted]" :
        typeof value === "string" ? this.redact(value) : value);
    const at = new Date().toISOString();
    this.run(`INSERT INTO activity(created_at,severity,category,event_type,message,batch_id,request_id,folder_job_id,transfer_id,metadata)
      VALUES (?,?,?,?,?,?,?,?,?,?)`, at, severity, category, eventType, safeMessage,
    ids.batchId ?? null, ids.requestId ?? null, ids.folderJobId ?? null, ids.transferId ?? null, safeMetadata);
    console.log(JSON.stringify({ at, severity, category, eventType, message: safeMessage }));
  }

  activity(filters: { severity?: string; category?: string; batchId?: string; requestId?: string;
    search?: string; cursor?: number; limit?: number; hideFileDetails?: boolean } = {}): Activity[] {
    const where: string[] = [];
    const args: SqlValue[] = [];
    for (const [column, value] of [["severity", filters.severity],
      ["batch_id", filters.batchId], ["request_id", filters.requestId]] as const) {
      if (value) { where.push(`${column}=?`); args.push(value); }
    }
    if (filters.category === "search") where.push("category IN ('search','batch')");
    else if (filters.category) { where.push("category=?"); args.push(filters.category); }
    if (filters.hideFileDetails) where.push("event_type NOT IN ('folder_file_excluded','candidate_excluded','candidate_ranked')");
    if (filters.search) { where.push("message LIKE ? ESCAPE '\\'"); args.push(`%${filters.search.replace(/[\\%_]/g, "\\$&")}%`); }
    if (filters.cursor) { where.push("id<?"); args.push(filters.cursor); }
    return this.all<Activity>(`SELECT * FROM activity ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY id DESC LIMIT ?`, ...args, Math.min(100, Math.max(1, filters.limit ?? 30)));
  }

  slskdStatus(): SlskdConnectionState {
    return this.get<{ event_type: "connected" | "unavailable" }>(
      "SELECT event_type FROM activity WHERE category='slskd' AND event_type IN ('connected','unavailable') ORDER BY id DESC LIMIT 1")?.event_type ?? null;
  }

  downloadStats(): DownloadStats {
    const stats = this.get<DownloadStats>(`SELECT
      COALESCE(SUM(CASE WHEN status='completed' AND stat_epoch=(SELECT epoch FROM download_stats WHERE id=1) THEN 1 ELSE 0 END),0) AS completed_count,
      COALESCE(SUM(CASE WHEN status='completed' AND stat_epoch=(SELECT epoch FROM download_stats WHERE id=1) THEN size ELSE 0 END),0) AS completed_bytes,
      COALESCE(SUM(CASE WHEN status IN ('ready','queueing','queued','active') THEN 1 ELSE 0 END),0) AS active_count,
      COALESCE(SUM(CASE WHEN status IN ('ready','queueing','queued','active') THEN transferred ELSE 0 END),0) AS active_transferred_bytes,
      COALESCE(SUM(CASE WHEN status='uncertain' THEN 1 ELSE 0 END),0) AS uncertain_count
      FROM transfers`);
    if (!stats) throw new Error("Could not read download statistics");
    return stats;
  }

  downloads(activeLimit: number, finishedLimit: number): DownloadsData {
    const from = `FROM transfers t JOIN requests r ON r.id=t.request_id JOIN batches b ON b.id=r.batch_id`;
    const fields = `SELECT t.*,r.batch_id,r.query_text,b.number AS batch_number ${from}`;
    const activeWhere = "t.hidden_from_downloads=0 AND t.status IN ('ready','queueing','queued','active','uncertain')";
    const finishedWhere = "t.hidden_from_downloads=0 AND t.status IN ('completed','failed','cancelled')";
    return {
      active: this.all<DownloadItem>(`${fields} WHERE ${activeWhere} ORDER BY t.updated_at DESC,t.id DESC LIMIT ?`, activeLimit),
      finished: this.all<DownloadItem>(`${fields} WHERE ${finishedWhere} ORDER BY t.updated_at DESC,t.id DESC LIMIT ?`, finishedLimit),
      active_total: this.get<{ count: number }>(`SELECT COUNT(*) AS count ${from} WHERE ${activeWhere}`)?.count ?? 0,
      finished_total: this.get<{ count: number }>(`SELECT COUNT(*) AS count ${from} WHERE ${finishedWhere}`)?.count ?? 0,
      stats: this.downloadStats()
    };
  }

  clearFinishedDownloads(): number {
    return this.transaction(() => {
      const count = this.get<{ count: number }>(`SELECT COUNT(*) AS count FROM transfers
        WHERE status IN ('completed','failed','cancelled') AND hidden_from_downloads=0`)?.count ?? 0;
      this.run(`UPDATE transfers SET hidden_from_downloads=1
        WHERE status IN ('completed','failed','cancelled') AND hidden_from_downloads=0`);
      this.event("info", "downloads", "list_cleared", `Cleared ${count} finished downloads from the list`);
      return count;
    });
  }

  clearDownloadStats(): void {
    this.transaction(() => {
      this.run("UPDATE download_stats SET epoch=epoch+1 WHERE id=1");
      this.event("info", "downloads", "stats_cleared", "Download statistics reset; transfers remain available");
    });
  }

  batchDetail(id: string): BatchDetail | undefined {
    const batch = this.get<Batch>("SELECT * FROM batches WHERE id=?", id);
    if (!batch) return undefined;
    const requests = this.all<MusicRequest>("SELECT * FROM requests WHERE batch_id=? ORDER BY position,created_at,id", id).map(request => {
      const candidates = this.all<Omit<Candidate, "metadata" | "eligible" | "selected" | "free_slot"> & { metadata: string; eligible: number; selected: number; free_slot: number | null }>(
        "SELECT * FROM candidates WHERE request_id=? ORDER BY score DESC LIMIT 200", request.id)
        .map(candidate => ({ ...candidate, metadata: JSON.parse(candidate.metadata) as Candidate["metadata"],
          eligible: Boolean(candidate.eligible), selected: Boolean(candidate.selected),
          free_slot: candidate.free_slot === null ? null : Boolean(candidate.free_slot) }));
      const previews = this.all<Omit<FolderPreview, "files" | "recursive" | "eligible_count" | "excluded_count" | "audio_bytes" | "eligible_bytes"> & { files: string; recursive: number }>(
        "SELECT * FROM folder_previews WHERE request_id=? ORDER BY created_at DESC LIMIT 20", request.id)
        .map(preview => this.inflatePreview(preview));
      const jobs = this.all<FolderJob>("SELECT * FROM folder_jobs WHERE request_id=? ORDER BY created_at DESC", request.id)
        .map(job => ({ ...job, transfers: this.all<TransferItem>("SELECT * FROM transfers WHERE folder_job_id=? ORDER BY path", job.id) }));
      return { ...request, candidates, previews, jobs, transfers: this.all<TransferItem>("SELECT * FROM transfers WHERE request_id=? ORDER BY path", request.id) };
    });
    const counts: Record<string, number> = {};
    for (const request of requests) counts[request.status] = (counts[request.status] ?? 0) + 1;
    const status = requests.every(request => request.status === "completed") ? "completed" :
      requests.some(request => ["failed", "uncertain"].includes(request.status)) ? "attention" :
        requests.every(request => ["completed", "partial"].includes(request.status)) ? "partial" :
          requests.some(request => ["active", "queueing", "searching", "pending"].includes(request.status)) ? "processing" : "review";
    return { batch: { ...batch, name: batchName(batch.number, requests[0]?.query_text ?? "", requests.length), status, counts },
      slskd_status: this.slskdStatus(),
      requests, activity: this.activity({ batchId: id, limit: 15, hideFileDetails: true }) };
  }

  inflatePreview(row: Omit<FolderPreview, "files" | "recursive" | "eligible_count" | "excluded_count" | "audio_bytes" | "eligible_bytes"> & { files: string; recursive: number }): FolderPreview {
    const files = JSON.parse(row.files) as PreviewFile[];
    const eligible = files.filter(file => file.eligible);
    return { ...row, files, recursive: Boolean(row.recursive), eligible_count: eligible.length,
      excluded_count: files.length - eligible.length,
      audio_bytes: files.reduce((sum, file) => sum + file.size, 0),
      eligible_bytes: eligible.reduce((sum, file) => sum + file.size, 0) };
  }

  savePreview(preview: Omit<FolderPreview, "id" | "created_at" | "eligible_count" | "excluded_count" | "audio_bytes" | "eligible_bytes">): FolderPreview {
    const id = randomUUID();
    const created_at = new Date().toISOString();
    this.run("INSERT INTO folder_previews(id,request_id,username,directory,recursive,files,created_at) VALUES(?,?,?,?,?,?,?)",
      id, preview.request_id, preview.username, preview.directory, Number(preview.recursive), JSON.stringify(preview.files), created_at);
    const eligible = preview.files.filter(file => file.eligible);
    return { ...preview, id, created_at, eligible_count: eligible.length, excluded_count: preview.files.length - eligible.length,
      audio_bytes: preview.files.reduce((sum, file) => sum + file.size, 0),
      eligible_bytes: eligible.reduce((sum, file) => sum + file.size, 0) };
  }

  close(): void { this.db.close(); }
}
