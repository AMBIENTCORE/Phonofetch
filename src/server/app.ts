import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import express, { type ErrorRequestHandler, type Express } from "express";
import { z, ZodError } from "zod";
import type { Batch, Candidate, FolderPreview, MusicRequest, Quality } from "../shared/types";
import { ApiError, installAuth } from "./auth";
import type { Config } from "./config";
import { Store, batchName } from "./db";
import { normalize, parseLines } from "./matching";
import type { SlskdPort } from "./port";
import { SlskdError, SlskdRequestError, SlskdShapeError } from "./slskd";
import { Workflow } from "./workflow";
import { canInspectFolder, canQueueSearchHits } from "../shared/search-selection";

const uuid = z.uuid();
const entry = z.object({
  original: z.string().min(1).max(256),
  queryText: z.string().trim().min(1).max(256),
  type: z.enum(["search", "track", "album_folder"]),
  seedKind: z.enum(["track_seed", "album_title"]),
  quality: z.enum(["mp3_320", "flac", "any"])
});
const newBatch = z.object({
  originalInput: z.string().min(1).max(32768),
  defaultType: z.enum(["search", "track", "album_folder"]),
  mode: z.enum(["review", "automatic"]),
  entries: z.array(entry).min(1).max(100)
});

export function createApp(store: Store, port: SlskdPort, config: Config, workflow: Workflow): Express {
  const app = express();
  app.disable("x-powered-by");
  if (config.TRUST_PROXY) app.set("trust proxy", 1);
  app.use(express.json({ limit: "512kb", type: "application/json" }));
  app.use((_, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
    next();
  });
  app.get("/api/health", (_, res) => {
    store.get("SELECT 1 AS ready");
    res.json({ status: "ok" });
  });
  installAuth(app, store, config);
  app.get("/api/dashboard", (_, res) => {
    const batches = store.all<Batch & { total: number; first_query: string | null }>(
      `SELECT b.*,COUNT(r.id) AS total,
        (SELECT query_text FROM requests WHERE batch_id=b.id ORDER BY position,created_at,id LIMIT 1) AS first_query
        FROM batches b LEFT JOIN requests r ON r.batch_id=b.id GROUP BY b.id ORDER BY b.created_at DESC LIMIT 100`)
      .map(batch => ({ ...batch, name: batchName(batch.number, batch.first_query ?? "", batch.total) }));
    res.json({ batches, downloads: store.downloads(20, 20), slskd_status: store.slskdStatus(),
      activity: store.activity({ limit: 40, hideFileDetails: true }) });
  });
  app.get("/api/downloads", (req, res) => {
    const { activeLimit, finishedLimit, sort } = z.object({
      activeLimit: z.coerce.number().int().min(1).max(25000).default(50),
      finishedLimit: z.coerce.number().int().min(1).max(25000).default(50),
      sort: z.enum(["newest", "oldest", "largest", "smallest", "pathAsc", "pathDesc",
        "peerAsc", "peerDesc", "statusAsc", "statusDesc"]).default("newest")
    }).parse(req.query);
    res.json(store.downloads(activeLimit, finishedLimit, sort));
  });
  app.post("/api/downloads/clear", (_, res) => {
    res.json({ cleared: store.clearFinishedDownloads() });
  });
  app.post("/api/downloads/stats/clear", (_, res) => {
    store.clearDownloadStats();
    res.json({ stats: store.downloadStats() });
  });
  app.post("/api/batches", (req, res) => {
    const body = newBatch.parse(req.body);
    const sourceLines = parseLines(body.originalInput, body.defaultType);
    if (sourceLines.length > 100) throw new ApiError(400, "A search can contain at most 100 nonempty lines");
    if (body.mode === "automatic" && body.entries.some(item => item.type === "search"))
      throw new ApiError(400, "Automatic downloads require choosing a track or album folder");
    const available = new Map<string, number>();
    for (const line of sourceLines) available.set(line.original, (available.get(line.original) ?? 0) + 1);
    const seen = new Set<string>();
    for (const item of body.entries) {
      const remaining = available.get(item.original) ?? 0;
      if (!remaining) throw new ApiError(400, "Reviewed entry is not in the submitted search text");
      available.set(item.original, remaining - 1);
      if (item.type === "track" && item.seedKind !== "track_seed") throw new ApiError(400, "Track requests must use track seed");
      if (!normalize(item.queryText)) throw new ApiError(400, "Search line must contain searchable text");
      const key = `${normalize(item.queryText)}\0${item.type}\0${item.seedKind}`;
      if (seen.has(key)) {
        store.event("warning", "batch", "duplicate_detected", `Duplicate query detected: ${item.queryText}`);
        throw new ApiError(400, "Duplicate requests must be removed or edited before submission");
      }
      seen.add(key);
    }
    const id = randomUUID();
    const date = new Date().toISOString();
    let number = 0;
    let name = "";
    store.transaction(() => {
      const next = store.get<{ value: number }>("SELECT COALESCE(MAX(number),0)+1 AS value FROM batches");
      if (!next) throw new Error("Could not allocate batch number");
      number = next.value;
      name = batchName(number, body.entries[0]!.queryText, body.entries.length);
      store.run("INSERT INTO batches(id,number,name,original_input,default_type,mode,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
        id, number, name, body.originalInput, body.defaultType, body.mode, date, date);
      for (const [position, item] of body.entries.entries()) {
        const requestId = randomUUID();
        store.run(`INSERT INTO requests(id,batch_id,position,query_text,type,seed_kind,artist,title,original_input,norm_artist,norm_title,quality,mode,status,search_window_ms,created_at,updated_at)
          VALUES(?,?,?,?,?,?,'','',?,'','',?,?,'pending',?,?,?)`, requestId, id, position, item.queryText, item.type, item.seedKind,
        item.original, item.quality, body.mode, config.SEARCH_FAST_WINDOW_MS, date, date);
        store.event("info", "batch", "parsed", `Parsed ${item.type}: ${item.queryText}`,
          { batchId: id, requestId }, { quality: item.quality, seedKind: item.seedKind });
      }
      store.event("success", "batch", "created", `${name} created with ${body.entries.length} queries`,
        { batchId: id }, { mode: body.mode });
    });
    res.status(201).json({ id, number, name });
  });
  app.get("/api/batches/:id", (req, res) => {
    const detail = store.batchDetail(uuid.parse(req.params.id));
    if (!detail) throw new ApiError(404, "Search not found");
    res.json(detail);
  });
  function getRequest(id: string): MusicRequest {
    const request = store.get<MusicRequest>("SELECT * FROM requests WHERE id=?", uuid.parse(id));
    if (!request) throw new ApiError(404, "Request not found");
    return request;
  }
  function getCandidate(request: MusicRequest, id: string): Candidate {
    const row = store.get<Omit<Candidate, "metadata" | "eligible" | "selected" | "free_slot"> & { metadata: string; eligible: number; selected: number; free_slot: number | null }>(
      "SELECT * FROM candidates WHERE id=? AND request_id=?", uuid.parse(id), request.id);
    if (!row) throw new ApiError(404, "Candidate not found");
    return { ...row, metadata: JSON.parse(row.metadata) as Candidate["metadata"],
      eligible: Boolean(row.eligible), selected: Boolean(row.selected),
      free_slot: row.free_slot === null ? null : Boolean(row.free_slot) };
  }
  app.post("/api/requests/:id/select", (req, res) => {
    const request = getRequest(req.params.id);
    if (request.status !== "review" && !(request.status === "no_results" && request.mode === "review"))
      throw new ApiError(409, "Request is not awaiting review");
    const { candidateId } = z.object({ candidateId: uuid }).parse(req.body);
    res.status(202).json({ id: workflow.queueTrack(request, getCandidate(request, candidateId)) });
  });
  app.post("/api/requests/:id/select-hits", (req, res) => {
    const request = getRequest(req.params.id);
    if (!canQueueSearchHits(request))
      throw new ApiError(409, "Request is not awaiting review");
    const { candidateIds } = z.object({ candidateIds: z.array(uuid).min(1).max(Math.max(1000, config.MAX_FOLDER_FILES)) }).parse(req.body);
    res.status(202).json({ ids: workflow.queueSearchHits(request, candidateIds) });
  });
  app.post("/api/requests/:id/preview", async (req, res) => {
    const request = getRequest(req.params.id);
    if (!canInspectFolder(request)) throw new ApiError(409, "Request is not awaiting review");
    const { candidateId, recursive } = z.object({ candidateId: uuid, recursive: z.boolean().default(false) }).parse(req.body);
    res.json(await workflow.preview(request, getCandidate(request, candidateId), recursive));
  });
  app.post("/api/requests/:id/queue-folder", async (req, res) => {
    const request = getRequest(req.params.id);
    if (!canInspectFolder(request)) throw new ApiError(409, "Request is not awaiting review");
    const { previewId, selectedPaths } = z.object({
      previewId: uuid, selectedPaths: z.array(z.string().min(1).max(1024))
        .max(Math.max(1000, config.MAX_FOLDER_FILES)).optional()
    }).parse(req.body);
    const row = store.get<Omit<FolderPreview, "files" | "recursive" | "eligible_count" | "excluded_count" | "audio_bytes" | "eligible_bytes"> & { files: string; recursive: number }>(
      "SELECT * FROM folder_previews WHERE id=? AND request_id=?", previewId, request.id);
    if (!row) throw new ApiError(404, "Folder preview not found");
    res.status(202).json({ id: await workflow.queueFolder(request,
      store.inflatePreview(row, request.mode === "review"), selectedPaths) });
  });
  app.post("/api/requests/:id/retry", (req, res) => {
    const request = getRequest(req.params.id);
    if (!["no_results", "failed", "review", "cancelled"].includes(request.status))
      throw new ApiError(409, "Request cannot be retried while processing");
    const { quality, longer } = z.object({
      quality: z.enum(["mp3_320", "flac", "any"]), longer: z.boolean().default(false)
    }).parse(req.body);
    workflow.retry(request, quality, longer);
    res.json({ ok: true });
  });
  app.post("/api/requests/:id/show-all", (req, res) => {
    workflow.showAllResults(getRequest(req.params.id));
    res.json({ ok: true });
  });
  app.post("/api/transfers/:id/cancel", async (req, res) => {
    const id = uuid.parse(req.params.id);
    const transfer = store.get<{ username: string; path: string; status: string; request_id: string; slskd_id: string | null }>(
      "SELECT username,path,status,request_id,slskd_id FROM transfers WHERE id=?", id);
    if (!transfer) throw new ApiError(404, "Transfer not found");
    if (!["queued", "active"].includes(transfer.status)) throw new ApiError(409, "Transfer cannot be cancelled in this state");
    const remoteId = transfer.slskd_id ?? (await port.transfers()).find(item =>
      item.username === transfer.username && item.path === transfer.path)?.id;
    if (!remoteId) throw new ApiError(409, "slskd transfer ID unavailable; wait for reconciliation");
    await port.cancel(transfer.username, remoteId);
    store.run("UPDATE transfers SET status='cancelled',updated_at=? WHERE id=?", new Date().toISOString(), id);
    store.event("warning", "transfer", "cancelled", `Transfer cancelled: ${transfer.path}`,
      { requestId: transfer.request_id, transferId: id });
    res.json({ ok: true });
  });
  app.post("/api/transfers/:id/retry", async (req, res) => {
    const id = uuid.parse(req.params.id);
    const transfer = store.get<{ username: string; path: string; status: string; request_id: string; retries: number; slskd_id: string | null }>(
      "SELECT username,path,status,request_id,retries,slskd_id FROM transfers WHERE id=?", id);
    if (!transfer) throw new ApiError(404, "Transfer not found");
    if (!["failed", "cancelled"].includes(transfer.status)) throw new ApiError(409, "Only a confirmed failed or cancelled transfer can be retried");
    if (transfer.retries >= config.MAX_RETRIES) throw new ApiError(409, "Transfer retry limit reached");
    const live = await port.transfers();
    if (live.some(item => item.username === transfer.username && item.path === transfer.path &&
      ["queued", "active", "completed"].includes(item.status)))
      throw new ApiError(409, "slskd already reports this file; inspect its transfer before retrying");
    const date = new Date().toISOString();
    store.transaction(() => {
      const current = store.get<{ status: string }>("SELECT status FROM transfers WHERE id=?", id);
      if (!current || !["failed", "cancelled"].includes(current.status))
        throw new ApiError(409, "Transfer state changed; retry not queued");
      store.run(`UPDATE transfers SET queue_id=?,slskd_id=NULL,status='ready',transferred=0,progress=0,hidden_from_downloads=0,
        error=NULL,retries=retries+1,updated_at=? WHERE id=?`, randomUUID(), date, id);
      store.run("UPDATE requests SET status='queueing',updated_at=? WHERE id=?", date, transfer.request_id);
      store.event("info", "transfer", "retry_requested", `Manual retry ${transfer.retries + 1}/${config.MAX_RETRIES} for ${transfer.path}`,
        { requestId: transfer.request_id, transferId: id }, { previousSlskdId: transfer.slskd_id });
    });
    res.status(202).json({ ok: true });
  });
  app.get("/api/activity", (req, res) => {
    const filters = z.object({
      severity: z.enum(["info", "success", "warning", "error"]).optional(),
      category: z.string().max(40).optional(),
      batchId: uuid.optional(), requestId: uuid.optional(),
      search: z.string().max(120).optional(),
      cursor: z.coerce.number().int().positive().optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
      order: z.enum(["asc", "desc"]).optional(),
      sort: z.enum(["date", "severity", "category", "message"]).optional()
    }).parse(req.query);
    if (filters.cursor && filters.sort && filters.sort !== "date" &&
      !store.get("SELECT id FROM activity WHERE id=?", filters.cursor))
      throw new ApiError(400, "Activity cursor not found");
    res.json(store.activity(filters));
  });
  app.use("/api", (_, res) => { res.status(404).json({ error: "API route not found" }); });
  const client = resolve(process.cwd(), "dist/client");
  app.use(express.static(client));
  app.use((req, res, next) => {
    if (req.method === "GET" && !req.path.startsWith("/api")) { res.sendFile(resolve(client, "index.html")); return; }
    next();
  });
  const errors: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    if (error instanceof ApiError) { res.status(error.status).json({ error: store.redact(error.message) }); return; }
    if (typeof error === "object" && error !== null && "type" in error && error.type === "entity.too.large") {
      res.status(413).json({ error: "Request body exceeds the upload limit" });
      return;
    }
    if (error instanceof ZodError) {
      res.status(400).json({ error: `Invalid request: ${error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; ")}` });
      return;
    }
    if (error instanceof SlskdError || error instanceof SlskdRequestError || error instanceof SlskdShapeError) {
      store.event("error", "api", "request_failed", error.message);
      res.status(502).json({ error: store.redact(error.message) });
      return;
    }
    store.event("error", "api", "request_failed", `Request failed: ${store.redact(error instanceof Error ? error.message : "Unknown error")}`);
    res.status(502).json({ error: "Request could not be completed; see the Activity Log" });
  };
  app.use(errors);
  return app;
}
