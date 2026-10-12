import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Candidate, MusicRequest, RemoteFile } from "../shared/types";
import { loadConfig } from "./config";
import { Store } from "./db";
import { unknownMetadata } from "./matching";
import type { RemoteTransfer, SlskdPort } from "./port";
import { Worker } from "./worker";
import { Workflow } from "./workflow";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });
function harness() {
  const dir = mkdtempSync(join(tmpdir(), "phonofetch-worker-"));
  const config = loadConfig({
    DATABASE_PATH: join(dir, "db.sqlite"), SLSKD_API_KEY: "secret",
    PHONOFETCH_AUTH_USERNAME: "admin", PHONOFETCH_AUTH_PASSWORD: "a-very-long-password",
    PHONOFETCH_SESSION_SECRET: "a-secret-of-at-least-thirty-two-characters",
    SEARCH_TIMEOUT_MS: "5000", MAX_RETRIES: "2"
  });
  const store = new Store(config.DATABASE_PATH);
  const holder = { current: store };
  cleanup.push(() => { holder.current.close(); rmSync(dir, { recursive: true, force: true }); });
  const id = "7f384540-8493-4b4c-9827-7492d7635f16";
  const batch = "207070cf-c403-4d81-8148-769ca11b12c5";
  const date = new Date().toISOString();
  store.run("INSERT INTO batches(id,number,name,original_input,default_type,mode,created_at,updated_at) VALUES(?,1,?,?,?,?,?,?)",
    batch, "test", "Burial - Archangel", "track", "review", date, date);
  store.run(`INSERT INTO requests(id,batch_id,position,query_text,type,seed_kind,artist,title,original_input,norm_artist,norm_title,quality,mode,status,created_at,updated_at)
    VALUES(?,?,0,'Burial - Archangel','track','track_seed','Burial','Archangel','Burial - Archangel','burial','archangel','flac','review','pending',?,?)`,
  id, batch, date, date);
  const live: RemoteTransfer[] = [];
  const port: SlskdPort = {
    check: vi.fn(async () => {}),
    startSearch: vi.fn(async () => "search-id"),
    getSearch: vi.fn(async () => ({ id: "search-id", finished: false, results: [] })),
    browse: vi.fn(async () => []),
    transfers: vi.fn(async () => live),
    enqueue: vi.fn(async (_username, _file, transferId) => {
      live.push({ id: "slskd-id", batchId: transferId, username: "alice", path: "Burial\\Untrue\\01 Archangel.flac",
        size: 100, transferred: 0, status: "queued" });
      return "slskd-id";
    }),
    cancel: vi.fn(async () => {})
  };
  const workflow = new Workflow(store, port, config);
  const worker = new Worker(store, port, config, workflow);
  const getRequest = () => store.get<MusicRequest>("SELECT * FROM requests WHERE id=?", id)!;
  const candidate: Candidate = { id: "aa05e4e5-14ab-48f1-a62c-4a13a0953147", request_id: id,
    username: "alice", path: "Burial\\Untrue\\01 Archangel.flac", directory: "Burial\\Untrue", size: 100,
    metadata: unknownMetadata(), eligible: true, reason: "FLAC", score: 0.98, explanation: "artist/title", selected: false };
  return { store, port, worker, workflow, config, id, live, candidate, getRequest,
    replaceStore: (next: Store) => { holder.current = next; } };
}

describe("worker retries and recovery", () => {
  it("sends flat normalized Soulseek text and distinguishes zero files from quality exclusions", async () => {
    const h = harness();
    h.store.run("UPDATE requests SET query_text=? WHERE id=?", "Ben Klock - Subzero", h.id);
    vi.mocked(h.port.getSearch).mockResolvedValueOnce({ id: "search-id", finished: true, results: [] });
    await h.worker.runOnce();
    expect(h.port.startSearch).toHaveBeenCalledWith("ben klock subzero");
    expect(h.getRequest()).toMatchObject({ status: "no_results", error: "Soulseek returned no files for this text search" });
    expect(h.store.activity({ category: "search", search: "Soulseek text search: ben klock subzero" })).toHaveLength(1);
    expect(h.store.activity({ category: "search", search: "0 files returned" })).toHaveLength(1);
  });

  it("keeps searches pending while slskd is unavailable and reports the connection state", async () => {
    const h = harness();
    vi.mocked(h.port.check).mockRejectedValueOnce(new Error("slskd offline"));
    await h.worker.runOnce();
    expect(h.getRequest().status).toBe("pending");
    expect(h.port.startSearch).not.toHaveBeenCalled();
    expect(h.store.batchDetail(h.getRequest().batch_id)?.slskd_status).toBe("unavailable");
    await h.worker.runOnce();
    expect(h.port.startSearch).toHaveBeenCalledTimes(1);
    expect(h.store.slskdStatus()).toBe("connected");
  });

  it("backs off on search failure and times out without creating duplicate searches", async () => {
    const h = harness();
    vi.mocked(h.port.startSearch).mockRejectedValueOnce(new Error("peer unavailable"));
    await h.worker.runOnce();
    expect(h.getRequest()).toMatchObject({ status: "pending", retries: 1 });
    expect(h.store.activity({ category: "search", search: "retry" })).not.toHaveLength(0);
    h.store.run("UPDATE requests SET next_attempt_at=? WHERE id=?", new Date(0).toISOString(), h.id);
    await h.worker.runOnce();
    expect(h.getRequest().search_id).toBe("search-id");
    h.store.run("UPDATE requests SET search_started_at=? WHERE id=?", new Date(0).toISOString(), h.id);
    await h.worker.runOnce();
    expect(h.getRequest().status).toBe("failed");
    expect(h.port.startSearch).toHaveBeenCalledTimes(2);
    expect(h.store.activity({ category: "search", search: "timed out" })).toHaveLength(1);
  });

  it("limits in-flight searches across worker ticks", async () => {
    const h = harness();
    const now = new Date().toISOString();
    for (let position = 1; position <= 2; position++) h.store.run(
      `INSERT INTO requests(id,batch_id,position,query_text,type,seed_kind,artist,title,original_input,norm_artist,norm_title,quality,mode,status,created_at,updated_at)
       SELECT ?,batch_id,?,?,'track','track_seed','Burial',?,'Burial - Other','burial','other','flac','review','pending',?,?
       FROM requests WHERE id=?`,
    `additional-${position}`, position, `Burial Other ${position}`, `Other ${position}`, now, now, h.id);
    await h.worker.runOnce();
    await h.worker.runOnce();
    expect(h.port.startSearch).toHaveBeenCalledTimes(2);
    expect(h.store.get<{ count: number }>("SELECT COUNT(*) AS count FROM requests WHERE status='searching'")?.count).toBe(2);
    h.store.run("UPDATE requests SET status='no_results' WHERE id=?", h.id);
    await h.worker.runOnce();
    expect(h.port.startSearch).toHaveBeenCalledTimes(3);
  });

  it("recovers a ready item already present in slskd without enqueuing it twice", async () => {
    const h = harness();
    h.store.run("UPDATE requests SET status='review' WHERE id=?", h.id);
    h.workflow.queueTrack(h.getRequest(), h.candidate);
    h.live.push({ id: "old-transfer", batchId: null, username: "alice", path: h.candidate.path,
      size: 100, transferred: 100, status: "completed" });
    await h.worker.runOnce();
    expect(h.getRequest().status).toBe("completed");
    expect(h.port.enqueue).not.toHaveBeenCalled();
    await h.worker.runOnce();
    expect(h.port.enqueue).not.toHaveBeenCalled();
  });

  it("reopens SQLite after restart and reconciles an unfinished transfer by persisted batch ID", async () => {
    const h = harness();
    h.store.run("UPDATE requests SET status='review' WHERE id=?", h.id);
    h.workflow.queueTrack(h.getRequest(), h.candidate);
    const pending = h.store.get<{ queue_id: string }>("SELECT queue_id FROM transfers WHERE request_id=?", h.id)!;
    h.store.close();
    const reopened = new Store(h.config.DATABASE_PATH);
    h.replaceStore(reopened);
    h.live.push({ id: "after-restart", batchId: pending.queue_id, username: "alice", path: h.candidate.path,
      size: 100, transferred: 100, status: "completed" });
    const resumed = new Worker(reopened, h.port, h.config, new Workflow(reopened, h.port, h.config));
    await resumed.runOnce();
    expect(reopened.get<MusicRequest>("SELECT * FROM requests WHERE id=?", h.id)?.status).toBe("completed");
    expect(h.port.enqueue).not.toHaveBeenCalled();
    expect(reopened.activity({ category: "recovery", search: "Existing" })).toHaveLength(1);
  });

  it("never automatically repeats ambiguous enqueue and later reconciles by stable batch ID", async () => {
    const h = harness();
    h.store.run("UPDATE requests SET status='review' WHERE id=?", h.id);
    h.workflow.queueTrack(h.getRequest(), h.candidate);
    vi.mocked(h.port.enqueue).mockRejectedValueOnce(new Error("connection lost after request"));
    await h.worker.runOnce();
    expect(h.getRequest().status).toBe("uncertain");
    expect(h.port.enqueue).toHaveBeenCalledTimes(1);
    await h.worker.runOnce();
    expect(h.port.enqueue).toHaveBeenCalledTimes(1);
    const id = h.store.get<{ id: string }>("SELECT id FROM transfers WHERE request_id=?", h.id)!.id;
    h.live.push({ id: "later-transfer", batchId: id, username: "alice", path: h.candidate.path,
      size: 100, transferred: 100, status: "completed" });
    await h.worker.runOnce();
    expect(h.getRequest().status).toBe("completed");
    expect(h.store.get<{ slskd_id: string }>("SELECT slskd_id FROM transfers WHERE id=?", id)?.slskd_id).toBe("later-transfer");
  });
});
