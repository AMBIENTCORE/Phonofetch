import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import type { MusicRequest, RemoteFile } from "../shared/types";
import { createApp } from "./app";
import { loadConfig } from "./config";
import { Store } from "./db";
import { parentDirectory, unknownMetadata } from "./matching";
import type { RemoteTransfer, SearchSnapshot, SlskdPort } from "./port";
import { SlskdAdapter, SlskdRequestError, SlskdShapeError } from "./slskd";
import { Workflow } from "./workflow";
import { Worker } from "./worker";

const folders: string[] = [];
const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const path of folders.splice(0)) rmSync(path, { force: true, recursive: true });
});
const remote = (path: string): RemoteFile => ({
  username: "alice", path, directory: parentDirectory(path), size: 100,
  metadata: { ...unknownMetadata() }
});
function setup() {
  const folder = mkdtempSync(join(tmpdir(), "phonofetch-api-")); folders.push(folder);
  const config = loadConfig({
    DATABASE_PATH: join(folder, "db.sqlite"), SLSKD_API_KEY: "test-api-key",
    PHONOFETCH_AUTH_USERNAME: "admin", PHONOFETCH_AUTH_PASSWORD: "very-strong-password",
    PHONOFETCH_SESSION_SECRET: "a-secret-of-at-least-thirty-two-characters"
  });
  const store = new Store(config.DATABASE_PATH, ["test-api-key", "very-strong-password"]);
  stores.push(store);
  const transfers: RemoteTransfer[] = [];
  const folderFiles = [remote("alice\\Burial\\Untrue\\01 - Archangel.flac"),
    remote("alice\\Burial\\Untrue\\02 - Ghost.flac"),
    remote("alice\\Burial\\Untrue\\03 - Song.mp3"),
    remote("alice\\Burial\\Untrue\\cover.jpg"),
    remote("alice\\Burial\\Another\\04 - Sibling.flac"),
    remote("alice\\Burial\\Untrue\\CD2\\05 - Nested.flac")];
  let searchSnapshot: SearchSnapshot = { id: "search-1", state: "Completed", finished: true,
    reportedFileCount: 1, reportedResponseCount: 1, results: [folderFiles[0]!] };
  const port: SlskdPort = {
    check: vi.fn(async () => {}),
    startSearch: vi.fn(async () => "search-1"),
    getSearch: vi.fn(async () => searchSnapshot),
    stopSearch: vi.fn(async () => {}),
    browse: vi.fn(async () => folderFiles),
    enqueue: vi.fn(async (username, file, batchId) => {
      const id = `transfer-${transfers.length + 1}`;
      transfers.push({ id, batchId, username, path: file.path, size: file.size, transferred: 0, status: "queued" });
      return id;
    }),
    transfers: vi.fn(async () => transfers),
    cancel: vi.fn(async (username, transferId) => {
      const item = transfers.find(t => t.username === username && t.id === transferId);
      if (item) item.status = "cancelled";
    })
  };
  const workflow = new Workflow(store, port, config);
  const worker = new Worker(store, port, config, workflow);
  const app = createApp(store, port, config, workflow);
  return { app, config, store, port, workflow, worker, transfers, folderFiles,
    setSnapshot: (snapshot: SearchSnapshot) => { searchSnapshot = snapshot; } };
}
const headers = { Host: "localhost:3000", Origin: "http://localhost:3000" };
async function login(app: ReturnType<typeof createApp>) {
  const response = await request(app).post("/api/login").set(headers)
    .send({ username: "admin", password: "very-strong-password" });
  expect(response.status).toBe(200);
  const cookie = response.headers["set-cookie"];
  const sessionCookie = Array.isArray(cookie) ? cookie[0] : cookie;
  if (!sessionCookie) throw new Error("Login did not set a session cookie");
  return { Cookie: sessionCookie.split(";")[0]!,
    "X-CSRF-Token": response.body.csrf as string, ...headers };
}
const entries = [
  { original: "Burial - Archangel", queryText: "Burial - Archangel",
    type: "track", seedKind: "track_seed", quality: "flac" },
  { original: "Burial - Untrue", queryText: "Burial - Untrue",
    type: "album_folder", seedKind: "album_title", quality: "flac" }
];

describe("authenticated mixed-batch workflow", () => {
  it("cancels all ongoing downloads in one search/peer/folder, including unloaded ready files", async () => {
    const { app, store, port, transfers, worker } = setup();
    const auth = await login(app);
    const makeSearch = async (text: string): Promise<{ batchId: string; requestId: string }> => {
      const created = await request(app).post("/api/batches").set(auth).send({
        originalInput: text, defaultType: "search", mode: "review",
        entries: [{ original: text, queryText: text, type: "search", seedKind: "track_seed", quality: "any" }]
      });
      const requestId = store.get<{ id: string }>("SELECT id FROM requests WHERE batch_id=?", created.body.id)?.id;
      if (!requestId) throw new Error("Search request missing");
      store.run("UPDATE requests SET status='active' WHERE id=?", requestId);
      return { batchId: created.body.id as string, requestId };
    };
    const first = await makeSearch("First search");
    const other = await makeSearch("Other search");
    const add = (requestId: string, username: string, path: string, status: "ready" | "queued" | "active" | "completed") => {
      const id = randomUUID();
      const remoteId = status === "queued" || status === "active" ? randomUUID() : null;
      const date = new Date().toISOString();
      store.run(`INSERT INTO transfers(id,queue_id,request_id,folder_job_id,username,path,size,status,slskd_id,created_at,updated_at)
        VALUES(?,?,?,NULL,?,?,?,?,?,?,?)`, id, id, requestId, username, path, 100, status, remoteId, date, date);
      if (remoteId && (status === "queued" || status === "active"))
        transfers.push({ id: remoteId, batchId: id, username, path, size: 100,
        transferred: 0, status });
      return { id, remoteId };
    };
    const queued = add(first.requestId, "alice", "Music\\Album\\01.flac", "queued");
    const active = add(first.requestId, "alice", "Music\\Album\\02.flac", "active");
    const ready = add(first.requestId, "alice", "Music\\Album\\03.flac", "ready");
    const finished = add(first.requestId, "alice", "Music\\Album\\04.flac", "completed");
    const sibling = add(first.requestId, "alice", "Music\\Album 2\\05.flac", "queued");
    const anotherPeer = add(first.requestId, "bob", "Music\\Album\\06.flac", "queued");
    const anotherSearch = add(other.requestId, "alice", "Music\\Album\\07.flac", "queued");
    const body = { batchId: first.batchId, username: "alice", directory: "Music\\Album" };
    expect((await request(app).post("/api/downloads/cancel-folder").set(headers).send(body)).status).toBe(401);
    expect((await request(app).post("/api/downloads/cancel-folder")
      .set({ ...headers, Cookie: auth.Cookie }).send(body)).status).toBe(403);
    const response = await request(app).post("/api/downloads/cancel-folder").set(auth).send(body);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ cancelled: 3, failures: [] });
    expect(vi.mocked(port.cancel).mock.calls).toEqual(expect.arrayContaining([
      ["alice", queued.remoteId], ["alice", active.remoteId]
    ]));
    expect(port.cancel).toHaveBeenCalledTimes(2);
    const statuses = store.all<{ id: string; status: string }>("SELECT id,status FROM transfers");
    const state = (id: string) => statuses.find(item => item.id === id)?.status;
    expect([queued.id, active.id, ready.id].map(state)).toEqual(["cancelled", "cancelled", "cancelled"]);
    expect([finished.id, sibling.id, anotherPeer.id, anotherSearch.id].map(state))
      .toEqual(["completed", "queued", "queued", "queued"]);
    expect((await request(app).post("/api/downloads/cancel-folder").set(auth).send(body)).status).toBe(409);
    await worker.runOnce();
    expect(port.enqueue).not.toHaveBeenCalled();
  });

  it("reports per-file cancel failures and keeps unconfirmed transfers unchanged", async () => {
    const { app, store, port, transfers } = setup();
    const auth = await login(app);
    const created = await request(app).post("/api/batches").set(auth).send({
      originalInput: "Album", defaultType: "search", mode: "review",
      entries: [{ original: "Album", queryText: "Album", type: "search", seedKind: "track_seed", quality: "any" }]
    });
    const requestId = store.get<{ id: string }>("SELECT id FROM requests WHERE batch_id=?", created.body.id)?.id;
    if (!requestId) throw new Error("Search request missing");
    const add = (filename: string, status: "queued" | "queueing" | "uncertain") => {
      const id = randomUUID();
      const remoteId = status === "queued" ? randomUUID() : null;
      const path = `Music\\Album\\${filename}`;
      const date = new Date().toISOString();
      store.run(`INSERT INTO transfers(id,queue_id,request_id,folder_job_id,username,path,size,status,slskd_id,created_at,updated_at)
        VALUES(?,?,?,NULL,'alice',?,?,?,?,?,?)`, id, id, requestId, path, 100, status, remoteId, date, date);
      if (remoteId) transfers.push({ id: remoteId, batchId: id, username: "alice", path, size: 100,
        transferred: 0, status: "queued" });
      return id;
    };
    const failed = add("01.flac", "queued");
    const success = add("02.flac", "queued");
    const pending = add("03.flac", "queueing");
    const uncertain = add("04.flac", "uncertain");
    const completedRemotely = add("05.flac", "queued");
    const completed = transfers.find(item => item.batchId === completedRemotely);
    if (!completed) throw new Error("Remote transfer missing");
    completed.status = "completed";
    vi.mocked(port.cancel).mockRejectedValueOnce(new Error("Peer declined cancellation"));
    const response = await request(app).post("/api/downloads/cancel-folder").set(auth)
      .send({ batchId: created.body.id, username: "alice", directory: "Music\\Album" });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ cancelled: 1, failures: [
      { id: failed, reason: "Cancellation failed; see Activity Log" },
      { id: pending, reason: "Transfer not confirmed in slskd; wait for reconciliation" },
      { id: uncertain, reason: "Transfer not confirmed in slskd; wait for reconciliation" },
      { id: completedRemotely, reason: "slskd reports completed; wait for reconciliation" }
    ] });
    expect(port.cancel).toHaveBeenCalledTimes(2);
    expect(store.get<{ status: string }>("SELECT status FROM transfers WHERE id=?", success)?.status).toBe("cancelled");
    expect(store.get<{ status: string }>("SELECT status FROM transfers WHERE id=?", failed)?.status).toBe("queued");
    expect(store.get<{ status: string }>("SELECT status FROM transfers WHERE id=?", pending)?.status).toBe("queueing");
    expect(store.get<{ status: string }>("SELECT status FROM transfers WHERE id=?", uncertain)?.status).toBe("uncertain");
    expect(store.get<{ status: string }>("SELECT status FROM transfers WHERE id=?", completedRemotely)?.status).toBe("queued");
    expect(store.activity({ category: "transfer", search: "Could not cancel" })).toHaveLength(4);
  });

  it("downloads checked audio and non-audio hits from multiple peers without inspecting their folders", async () => {
    const { app, worker, store, port, folderFiles, setSnapshot } = setup();
    const mp3 = { ...folderFiles[2]!, username: "bob",
      metadata: { ...unknownMetadata(), bitrate: 320, vbr: false } };
    const hits = [folderFiles[0]!, mp3, remote("Single.flac"),
      folderFiles[3]!];
    setSnapshot({ id: "search-1", state: "Completed", finished: true,
      reportedFileCount: hits.length, reportedResponseCount: 3, results: hits });
    const auth = await login(app);
    const created = await request(app).post("/api/batches").set(auth).send({
      originalInput: "Burial Song", defaultType: "search", mode: "review",
      entries: [{ original: "Burial Song", queryText: "Burial Song", type: "search",
        seedKind: "track_seed", quality: "flac" }]
    });
    await worker.runOnce();
    const item = (await request(app).get(`/api/batches/${created.body.id}`).set(auth)).body.requests[0];
    expect(item.candidates).toHaveLength(4);
    expect(item.candidates.find((candidate: { path: string }) => candidate.path === mp3.path))
      .toMatchObject({ eligible: true, metadata: { bitrate: 320, vbr: false } });
    const candidates = item.candidates.filter((file: { eligible: boolean }) => file.eligible);
    expect(candidates).toHaveLength(4);
    vi.mocked(port.browse).mockRejectedValueOnce(new Error("Peer refuses directory browse"));
    expect((await request(app).post(`/api/requests/${item.id}/preview`).set(auth)
      .send({ candidateId: candidates[0].id })).status).toBe(502);
    const queued = await request(app).post(`/api/requests/${item.id}/select-hits`).set(auth)
      .send({ candidateIds: candidates.map((file: { id: string }) => file.id) });
    expect(queued.status).toBe(202);
    expect(queued.body.ids).toHaveLength(4);
    const detail = store.batchDetail(created.body.id)?.requests[0];
    expect(detail?.selected_candidate_id).toBeNull();
    expect(detail?.transfers).toHaveLength(4);
    expect(detail?.candidates.filter(candidate => candidate.selected)).toHaveLength(4);
    expect(port.browse).toHaveBeenCalledOnce();
    await worker.runOnce();
    expect(port.enqueue).toHaveBeenCalledTimes(4);
    expect(vi.mocked(port.enqueue).mock.calls.map(([user, file]) => [user, file.path])).toEqual(expect.arrayContaining([
      ["alice", folderFiles[0]!.path], ["bob", folderFiles[2]!.path],
      ["alice", "Single.flac"], ["alice", folderFiles[3]!.path]
    ]));
    expect(store.all<{ status: string }>("SELECT status FROM transfers").every(row => row.status === "queued")).toBe(true);
    expect((await request(app).post(`/api/requests/${item.id}/select-hits`).set(auth)
      .send({ candidateIds: [candidates[0].id] })).status).toBe(409);
  });

  it("queues another folder and search hit after a first album without duplicating its files", async () => {
    const { app, worker, folderFiles, port, transfers, setSnapshot } = setup();
    const second = { ...remote("bob\\Hybrid Theory\\01 - Papercut.flac"), username: "bob" };
    const third = { ...remote("bob\\Meteora\\01 - Foreword.flac"), username: "bob" };
    folderFiles.push(second, third);
    setSnapshot({ id: "search-1", state: "Completed", finished: true,
      reportedFileCount: 3, reportedResponseCount: 2, results: [folderFiles[0]!, second, third] });
    const auth = await login(app);
    const created = await request(app).post("/api/batches").set(auth).send({
      originalInput: "Linkin Park", defaultType: "search", mode: "review",
      entries: [{ original: "Linkin Park", queryText: "Linkin Park", type: "search",
        seedKind: "track_seed", quality: "any" }]
    });
    await worker.runOnce();
    const detail = (await request(app).get(`/api/batches/${created.body.id}`).set(auth)).body.requests[0];
    const [firstHit, secondHit, thirdHit] = detail.candidates;
    const firstPreview = await request(app).post(`/api/requests/${detail.id}/preview`).set(auth)
      .send({ candidateId: firstHit.id });
    expect(firstPreview.status).toBe(200);
    expect((await request(app).post(`/api/requests/${detail.id}/queue-folder`).set(auth)
      .send({ previewId: firstPreview.body.id })).status).toBe(202);
    await worker.runOnce();
    for (const transfer of transfers) {
      transfer.status = "completed";
      transfer.transferred = transfer.size;
    }
    await worker.runOnce();
    expect((await request(app).get(`/api/batches/${created.body.id}`).set(auth)).body.requests[0].status)
      .toBe("completed");

    const secondPreview = await request(app).post(`/api/requests/${detail.id}/preview`).set(auth)
      .send({ candidateId: secondHit.id });
    expect(secondPreview.status).toBe(200);
    expect((await request(app).post(`/api/requests/${detail.id}/queue-folder`).set(auth)
      .send({ previewId: secondPreview.body.id })).status).toBe(202);
    expect((await request(app).post(`/api/requests/${detail.id}/select-hits`).set(auth)
      .send({ candidateIds: [thirdHit.id] })).status).toBe(202);
    expect((await request(app).post(`/api/requests/${detail.id}/queue-folder`).set(auth)
      .send({ previewId: firstPreview.body.id })).status).toBe(409);
    expect((await request(app).post(`/api/requests/${detail.id}/select-hits`).set(auth)
      .send({ candidateIds: [secondHit.id] })).status).toBe(409);
    await worker.runOnce();
    expect(port.enqueue).toHaveBeenCalledTimes(firstPreview.body.eligible_count + 2);
    let updated = (await request(app).get(`/api/batches/${created.body.id}`).set(auth)).body.requests[0];
    expect(updated.jobs).toHaveLength(2);
    expect(updated.transfers).toHaveLength(firstPreview.body.eligible_count + 2);
    expect(updated.jobs.find((job: { directory: string }) => job.directory === firstPreview.body.directory).status)
      .toBe("completed");
    for (const transfer of transfers) {
      transfer.status = "completed";
      transfer.transferred = transfer.size;
    }
    await worker.runOnce();
    updated = (await request(app).get(`/api/batches/${created.body.id}`).set(auth)).body.requests[0];
    expect(updated.status).toBe("completed");
    expect(updated.jobs.every((job: { status: string }) => job.status === "completed")).toBe(true);
  });

  it("can queue the remaining files in a partially selected manual folder", async () => {
    const { app, worker, transfers, port } = setup();
    const auth = await login(app);
    const created = await request(app).post("/api/batches").set(auth).send({
      originalInput: "Burial Untrue", defaultType: "search", mode: "review",
      entries: [{ original: "Burial Untrue", queryText: "Burial Untrue", type: "search",
        seedKind: "track_seed", quality: "any" }]
    });
    await worker.runOnce();
    const item = (await request(app).get(`/api/batches/${created.body.id}`).set(auth)).body.requests[0];
    const preview = await request(app).post(`/api/requests/${item.id}/preview`).set(auth)
      .send({ candidateId: item.candidates[0].id });
    expect(preview.status).toBe(200);
    const paths = preview.body.files.map((file: { path: string }) => file.path);
    expect((await request(app).post(`/api/requests/${item.id}/queue-folder`).set(auth)
      .send({ previewId: preview.body.id, selectedPaths: [paths[0]] })).status).toBe(202);
    await worker.runOnce();
    transfers[0]!.status = "completed";
    transfers[0]!.transferred = transfers[0]!.size;
    await worker.runOnce();
    expect((await request(app).get(`/api/batches/${created.body.id}`).set(auth)).body.requests[0].status).toBe("partial");
    expect((await request(app).post(`/api/requests/${item.id}/queue-folder`).set(auth)
      .send({ previewId: preview.body.id, selectedPaths: paths.slice(1) })).status).toBe(202);
    expect((await request(app).post(`/api/requests/${item.id}/queue-folder`).set(auth)
      .send({ previewId: preview.body.id, selectedPaths: [paths[0]] })).status).toBe(409);
    await worker.runOnce();
    expect(port.enqueue).toHaveBeenCalledTimes(paths.length);
    for (const transfer of transfers) {
      transfer.status = "completed";
      transfer.transferred = transfer.size;
    }
    await worker.runOnce();
    const updated = (await request(app).get(`/api/batches/${created.body.id}`).set(auth)).body.requests[0];
    expect(updated.status).toBe("completed");
    expect(updated.jobs).toHaveLength(2);
    expect(updated.jobs.every((job: { status: string; unselected_count: number }) =>
      job.status === "completed" && job.unselected_count === 0)).toBe(true);
  });

  it("rejects duplicate, ineligible, foreign and oversized hit selections atomically", async () => {
    const { app, worker, store, folderFiles, setSnapshot } = setup();
    const other = { ...remote("Music\\Song.flac"), username: "bob" };
    setSnapshot({ id: "search-1", state: "Completed", finished: true,
      reportedFileCount: 3, reportedResponseCount: 2,
      results: [folderFiles[0]!, { ...folderFiles[3]!, size: 0 }, other] });
    const auth = await login(app);
    const created = await request(app).post("/api/batches").set(auth).send({
      originalInput: "Burial Song", defaultType: "search", mode: "review",
      entries: [{ original: "Burial Song", queryText: "Burial Song", type: "search",
        seedKind: "track_seed", quality: "any" }]
    });
    await worker.runOnce();
    const item = (await request(app).get(`/api/batches/${created.body.id}`).set(auth)).body.requests[0];
    const flac = item.candidates.find((candidate: { path: string }) => candidate.path === folderFiles[0]!.path);
    const jpg = item.candidates.find((candidate: { path: string }) => candidate.path === folderFiles[3]!.path);
    for (const [ids, status] of [
      [[flac.id, flac.id], 400], [[flac.id, jpg.id], 422],
      [[flac.id, "050c378d-1667-4257-84e8-567e396dd102"], 422]
    ] as const) {
      const result = await request(app).post(`/api/requests/${item.id}/select-hits`).set(auth)
        .send({ candidateIds: ids });
      expect(result.status).toBe(status);
      expect(store.all("SELECT id FROM transfers")).toHaveLength(0);
      expect(store.get<MusicRequest>("SELECT * FROM requests WHERE id=?", item.id)?.status).toBe("review");
    }
    store.run("UPDATE candidates SET size=? WHERE id=?", 11 * 1024 * 1024 * 1024, flac.id);
    expect((await request(app).post(`/api/requests/${item.id}/select-hits`).set(auth)
      .send({ candidateIds: [flac.id] })).status).toBe(413);
    expect(store.all("SELECT id FROM transfers")).toHaveLength(0);
  });

  it("rejects duplicate remote files reported with different path separators", async () => {
    const { app, worker, store, setSnapshot } = setup();
    const first = remote("Music\\Album\\Track.flac");
    const second = { ...first, path: "Music/Album/Track.flac", directory: "Music/Album" };
    setSnapshot({ id: "search-1", state: "Completed", finished: true,
      reportedFileCount: 2, reportedResponseCount: 1, results: [first, second] });
    const auth = await login(app);
    const created = await request(app).post("/api/batches").set(auth).send({
      originalInput: "Track", defaultType: "search", mode: "review",
      entries: [{ original: "Track", queryText: "Track", type: "search",
        seedKind: "track_seed", quality: "any" }]
    });
    await worker.runOnce();
    const item = (await request(app).get(`/api/batches/${created.body.id}`).set(auth)).body.requests[0];
    expect(item.candidates).toHaveLength(2);
    const result = await request(app).post(`/api/requests/${item.id}/select-hits`).set(auth)
      .send({ candidateIds: item.candidates.map((candidate: { id: string }) => candidate.id) });
    expect(result.status).toBe(400);
    expect(result.body.error).toBe("Duplicate remote file selection");
    expect(store.all("SELECT id FROM transfers")).toHaveLength(0);
    expect((await request(app).post(`/api/requests/${item.id}/select-hits`).set(auth)
      .send({ candidateIds: [item.candidates[0].id] })).status).toBe(202);
    expect((await request(app).post(`/api/requests/${item.id}/select-hits`).set(auth)
      .send({ candidateIds: [item.candidates[1].id] })).status).toBe(409);
    expect(store.all("SELECT id FROM transfers")).toHaveLength(1);
  });

  it("checks the exact selected hit's metadata when queueing strict-quality files", async () => {
    const { app, worker, port, folderFiles, setSnapshot, store } = setup();
    const hits = [folderFiles[2]!, { ...remote("alice\\Burial\\Another\\Other.mp3") }];
    for (const hit of hits) hit.metadata = { ...unknownMetadata(), bitrate: 320, vbr: false };
    setSnapshot({ id: "search-1", state: "Completed", finished: true,
      reportedFileCount: 2, reportedResponseCount: 1, results: hits });
    const auth = await login(app);
    const created = await request(app).post("/api/batches").set(auth).send({
      originalInput: "Burial Song", defaultType: "search", mode: "review",
      entries: [{ original: "Burial Song", queryText: "Burial Song", type: "search",
        seedKind: "track_seed", quality: "mp3_320" }]
    });
    await worker.runOnce();
    const item = (await request(app).get(`/api/batches/${created.body.id}`).set(auth)).body.requests[0];
    expect((await request(app).post(`/api/requests/${item.id}/select-hits`).set(auth)
      .send({ candidateIds: item.candidates.map((hit: { id: string }) => hit.id) })).status).toBe(202);
    expect(store.get<MusicRequest>("SELECT * FROM requests WHERE id=?", item.id)?.selected_candidate_id).toBeNull();
    await worker.runOnce();
    expect(port.enqueue).toHaveBeenCalledTimes(2);
    expect(vi.mocked(port.enqueue).mock.calls.map(([, file]) => file.metadata)).toEqual([
      { ...unknownMetadata(), bitrate: 320, vbr: false },
      { ...unknownMetadata(), bitrate: 320, vbr: false }
    ]);
  });

  it("exposes selectable files after a full-share browse with named audio attributes", async () => {
    const { app, config, store, worker } = setup();
    const auth = await login(app);
    const created = await request(app).post("/api/batches").set(auth).send({
      originalInput: "Burial Song", defaultType: "search", mode: "review",
      entries: [{ original: "Burial Song", queryText: "Burial Song", type: "search",
        seedKind: "track_seed", quality: "any" }]
    });
    await worker.runOnce();
    const item = (await request(app).get(`/api/batches/${created.body.id}`).set(auth)).body.requests[0];
    const reply = (body: unknown): Response => new Response(JSON.stringify(body),
      { headers: { "Content-Type": "application/json" } });
    const fetcher = vi.fn(async (url: RequestInfo | URL) => String(url).endsWith("/directory") ?
      reply({ name: "alice\\Burial\\Untrue", files: [] }) :
      reply({ directories: [{ name: "alice\\Burial\\Untrue", files: [{
        filename: "03 - Song.mp3", size: 100,
        attributes: [{ type: "BitRate", value: 320 }, { type: "VariableBitRate", value: 0 }]
      }] }], lockedDirectories: [] }));
    const adapter = new SlskdAdapter("http://slskd:5030", "test-api-key", 5000, 10, fetcher);
    const browsedApp = createApp(store, adapter, config, new Workflow(store, adapter, config));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const inspected = await request(browsedApp).post(`/api/requests/${item.id}/preview`).set(auth)
        .send({ candidateId: item.candidates[0].id });
      expect(inspected.status).toBe(200);
      expect(inspected.body).toMatchObject({ eligible_count: 1,
        files: [{ path: "alice\\Burial\\Untrue\\03 - Song.mp3", eligible: true,
          metadata: { bitrate: 320, vbr: false } }] });
      const detail = (await request(browsedApp).get(`/api/batches/${created.body.id}`).set(auth)).body.requests[0];
      expect(detail.previews[0].files[0].eligible).toBe(true);
    } finally { warn.mockRestore(); }
  });

  it("inspects non-audio extras even when their count exceeds the file-selection limit", async () => {
    const { app, worker, folderFiles, port } = setup();
    folderFiles.push(...Array.from({ length: 260 }, (_, index) =>
      remote(`alice\\Burial\\Untrue\\cover-${index}.jpg`)));
    const auth = await login(app);
    const created = await request(app).post("/api/batches").set(auth).send({
      originalInput: "Burial Song", defaultType: "search", mode: "review",
      entries: [{ original: "Burial Song", queryText: "Burial Song", type: "search",
        seedKind: "track_seed", quality: "any" }]
    });
    await worker.runOnce();
    const item = (await request(app).get(`/api/batches/${created.body.id}`).set(auth)).body.requests[0];
    const inspected = await request(app).post(`/api/requests/${item.id}/preview`).set(auth)
      .send({ candidateId: item.candidates[0].id });
    expect(inspected.status).toBe(200);
    expect(inspected.body).toMatchObject({ eligible_count: 264, excluded_count: 0 });
    expect(inspected.body.files).toHaveLength(264);
    const cover = inspected.body.files.find((file: { path: string }) => file.path.endsWith("cover-259.jpg"));
    expect(cover).toMatchObject({ eligible: true });
    expect((await request(app).post(`/api/requests/${item.id}/queue-folder`).set(auth)
      .send({ previewId: inspected.body.id })).status).toBe(413);
    const allPaths = inspected.body.files.map((file: { path: string }) => file.path);
    const tooMany = await request(app).post(`/api/requests/${item.id}/queue-folder`).set(auth)
      .send({ previewId: inspected.body.id, selectedPaths: allPaths });
    expect(tooMany.status).toBe(413);
    expect(tooMany.body.error).toContain("Select at most 250 files");
    expect((await request(app).post(`/api/requests/${item.id}/queue-folder`).set(auth)
      .send({ previewId: inspected.body.id, selectedPaths: [cover.path] })).status).toBe(202);
    await worker.runOnce();
    expect(vi.mocked(port.enqueue).mock.calls[0]?.[1].path).toBe(cover.path);
  });

  it("inspects and queues AIF, NFO, M3U and JPG files selected from a manual folder", async () => {
    const { app, worker, port, folderFiles } = setup();
    const extras = ["notes.nfo", "playlist.m3u", "art.jpg", "master.aif"]
      .map(name => remote(`alice\\Burial\\Untrue\\${name}`));
    folderFiles.push(...extras);
    const auth = await login(app);
    const created = await request(app).post("/api/batches").set(auth).send({
      originalInput: "Burial Untrue", defaultType: "search", mode: "review",
      entries: [{ original: "Burial Untrue", queryText: "Burial Untrue", type: "search",
        seedKind: "track_seed", quality: "any" }]
    });
    await worker.runOnce();
    const item = (await request(app).get(`/api/batches/${created.body.id}`).set(auth)).body.requests[0];
    const inspected = await request(app).post(`/api/requests/${item.id}/preview`).set(auth)
      .send({ candidateId: item.candidates[0].id });
    expect(inspected.status).toBe(200);
    for (const file of extras)
      expect(inspected.body.files.find((row: { path: string }) => row.path === file.path)).toMatchObject({
        eligible: true, reason: "Available for manual download"
      });
    expect((await request(app).post(`/api/requests/${item.id}/queue-folder`).set(auth)
      .send({ previewId: inspected.body.id, selectedPaths: extras.map(file => file.path) })).status).toBe(202);
    await worker.runOnce();
    expect(vi.mocked(port.enqueue).mock.calls.map(([, file]) => file.path)).toEqual(
      expect.arrayContaining(extras.map(file => file.path)));
    expect(port.enqueue).toHaveBeenCalledTimes(extras.length);
  });

  it("queues every selectable file including non-audio extras when downloading all", async () => {
    const { app, worker, port, folderFiles } = setup();
    folderFiles.push(remote("alice\\Burial\\Untrue\\playlist.m3u"),
      remote("alice\\Burial\\Untrue\\notes.nfo"));
    const auth = await login(app);
    const created = await request(app).post("/api/batches").set(auth).send({
      originalInput: "Burial Untrue", defaultType: "search", mode: "review",
      entries: [{ original: "Burial Untrue", queryText: "Burial Untrue", type: "search",
        seedKind: "track_seed", quality: "any" }]
    });
    expect(created.status).toBe(201);
    await worker.runOnce();
    const item = (await request(app).get(`/api/batches/${created.body.id}`).set(auth)).body.requests[0];
    const inspected = await request(app).post(`/api/requests/${item.id}/preview`).set(auth)
      .send({ candidateId: item.candidates[0].id });
    expect(inspected.status).toBe(200);
    expect(inspected.body).toMatchObject({ eligible_count: 6, excluded_count: 0 });
    const paths = inspected.body.files.map((file: { path: string }) => file.path);
    expect((await request(app).post(`/api/requests/${item.id}/queue-folder`).set(auth)
      .send({ previewId: inspected.body.id, selectedPaths: paths })).status).toBe(202);
    await worker.runOnce();
    expect(vi.mocked(port.enqueue).mock.calls.map(([, file]) => file.path)).toEqual(expect.arrayContaining(paths));
    expect(port.enqueue).toHaveBeenCalledTimes(paths.length);
  });

  it("bounds very large folder inspections and still queues an individual search hit", async () => {
    const { app, worker, store, port, folderFiles } = setup();
    folderFiles.push(...Array.from({ length: 997 }, (_, index) =>
      remote(`alice\\Burial\\Untrue\\${index}-extra.flac`)));
    const auth = await login(app);
    const created = await request(app).post("/api/batches").set(auth).send({
      originalInput: "Burial Song", defaultType: "search", mode: "review",
      entries: [{ original: "Burial Song", queryText: "Burial Song", type: "search",
        seedKind: "track_seed", quality: "any" }]
    });
    await worker.runOnce();
    const item = (await request(app).get(`/api/batches/${created.body.id}`).set(auth)).body.requests[0];
    const inspected = await request(app).post(`/api/requests/${item.id}/preview`).set(auth)
      .send({ candidateId: item.candidates[0].id });
    expect(inspected.status).toBe(413);
    expect(inspected.body.error).toContain("1001 files; inspection limit is 1000");
    expect(inspected.body.error).not.toContain("upload limit");
    expect(store.batchDetail(created.body.id)?.requests[0]?.previews).toHaveLength(0);
    expect((await request(app).post(`/api/requests/${item.id}/select`).set(auth)
      .send({ candidateId: item.candidates[0].id })).status).toBe(202);
    await worker.runOnce();
    expect(port.enqueue).toHaveBeenCalledOnce();
  });

  it("keeps oversized JSON requests distinct from the folder preview limit", async () => {
    const { app } = setup();
    const auth = await login(app);
    const result = await request(app).post("/api/batches").set(auth)
      .send({ originalInput: "x".repeat(512 * 1024) });
    expect(result.status).toBe(413);
    expect(result.body.error).toBe("Request body exceeds the upload limit");
  });

  it("keeps missing-bitrate MP3 files selectable in an unfiltered manual search", async () => {
    const { app, worker, port, folderFiles, setSnapshot } = setup();
    const auth = await login(app);
    setSnapshot({ id: "search-1", state: "Completed", finished: true,
      reportedFileCount: 1, reportedResponseCount: 1, results: [folderFiles[2]!] });
    const created = await request(app).post("/api/batches").set(auth).send({
      originalInput: "Burial Song", defaultType: "search", mode: "review",
      entries: [{ original: "Burial Song", queryText: "Burial Song", type: "search",
        seedKind: "track_seed", quality: "any" }]
    });
    await worker.runOnce();
    const item = (await request(app).get(`/api/batches/${created.body.id}`).set(auth)).body.requests[0];
    expect(item).toMatchObject({ quality: "any", type: "search", status: "review" });
    expect(item.candidates[0]).toMatchObject({ eligible: true, metadata: { bitrate: null, vbr: null } });
    const preview = await request(app).post(`/api/requests/${item.id}/preview`).set(auth)
      .send({ candidateId: item.candidates[0].id });
    expect(preview.body).toMatchObject({ eligible_count: 4, excluded_count: 0 });
    expect((await request(app).post(`/api/requests/${item.id}/select`).set(auth)
      .send({ candidateId: item.candidates[0].id })).status).toBe(202);
    await worker.runOnce();
    expect(port.enqueue).toHaveBeenCalledOnce();
  });

  it("selects an old saved non-audio hit without a new search or quality conversion", async () => {
    const { app, worker, store, port, setSnapshot } = setup();
    setSnapshot({ id: "search-1", state: "Completed", finished: true,
      reportedFileCount: 1, reportedResponseCount: 1,
      results: [remote("alice\\Music\\cover.jpg")] });
    const auth = await login(app);
    const created = await request(app).post("/api/batches").set(auth).send({
      originalInput: "Music", defaultType: "search", mode: "review",
      entries: [{ original: "Music", queryText: "Music", type: "search",
        seedKind: "track_seed", quality: "mp3_320" }]
    });
    await worker.runOnce();
    const saved = store.get<MusicRequest>("SELECT * FROM requests WHERE batch_id=?", created.body.id)!;
    store.run("UPDATE requests SET status='no_results',error='No files met the selected quality requirements' WHERE id=?", saved.id);
    store.run("UPDATE candidates SET eligible=0,reason='Not a supported audio file' WHERE request_id=?", saved.id);
    const item = (await request(app).get(`/api/batches/${created.body.id}`).set(auth)).body.requests[0];
    expect(item).toMatchObject({ status: "review", error: null, quality: "mp3_320" });
    expect(item.candidates[0]).toMatchObject({ path: "alice\\Music\\cover.jpg", eligible: true });
    expect((await request(app).post(`/api/requests/${saved.id}/select-hits`).set(auth)
      .send({ candidateIds: [item.candidates[0].id] })).status).toBe(202);
    await worker.runOnce();
    expect(vi.mocked(port.enqueue).mock.calls[0]?.[1].path).toBe("alice\\Music\\cover.jpg");
    expect(store.batchDetail(created.body.id)?.requests[0]?.candidates[0]).toMatchObject({
      selected: true, eligible: true, reason: "Available for manual download"
    });
  });

  it("can review old quality-limited results and queue a folder subset without another search", async () => {
    const { app, store, worker, folderFiles, setSnapshot, port } = setup();
    const auth = await login(app);
    setSnapshot({ id: "search-1", state: "Completed", finished: true,
      reportedFileCount: 1, reportedResponseCount: 1, results: [folderFiles[2]!] });
    const created = await request(app).post("/api/batches").set(auth).send({
      originalInput: "Burial Song", defaultType: "album_folder", mode: "review",
      entries: [{ original: "Burial Song", queryText: "Burial Song", type: "album_folder",
        seedKind: "track_seed", quality: "mp3_320" }]
    });
    await worker.runOnce();
    const stored = store.get<MusicRequest>("SELECT * FROM requests WHERE batch_id=?", created.body.id)!;
    store.run("UPDATE requests SET status='no_results',error='No files met the selected quality requirements' WHERE id=?", stored.id);
    store.run("UPDATE candidates SET eligible=0,reason='MP3 required' WHERE request_id=?", stored.id);
    let item = (await request(app).get(`/api/batches/${created.body.id}`).set(auth)).body.requests[0];
    expect(item).toMatchObject({ status: "review", quality: "mp3_320", error: null });
    expect(item.candidates[0]).toMatchObject({ eligible: true, reason: "Available for manual download" });
    const preview = await request(app).post(`/api/requests/${item.id}/preview`).set(auth)
      .send({ candidateId: item.candidates[0].id });
    expect(preview.body.eligible_count).toBe(4);
    expect(store.activity({ requestId: item.id, category: "quality" })).toHaveLength(0);
    expect((await request(app).post(`/api/requests/${item.id}/show-all`).set(auth).send({})).status).toBe(200);
    item = (await request(app).get(`/api/batches/${created.body.id}`).set(auth)).body.requests[0];
    expect(item).toMatchObject({ type: "search", mode: "review", quality: "any", status: "review", error: null });
    expect(item.candidates[0]).toMatchObject({ eligible: true, metadata: { bitrate: null } });
    expect(item.previews[0]).toMatchObject({ eligible_count: 4, excluded_count: 0 });
    const mp3 = item.previews[0].files.find((file: { path: string }) => file.path.endsWith(".mp3"));
    expect((await request(app).post(`/api/requests/${item.id}/queue-folder`).set(auth)
      .send({ previewId: preview.body.id, selectedPaths: [mp3.path] })).status).toBe(202);
    expect((await request(app).post(`/api/requests/${item.id}/show-all`).set(auth).send({})).status).toBe(409);
    await worker.runOnce();
    expect(port.startSearch).toHaveBeenCalledOnce();
    expect(port.enqueue).toHaveBeenCalledOnce();
  });

  it("does not persist a folder preview created under an old quality rule after it is removed", async () => {
    const { app, store, worker, port, folderFiles, setSnapshot } = setup();
    const auth = await login(app);
    setSnapshot({ id: "search-1", state: "Completed", finished: true,
      reportedFileCount: 1, reportedResponseCount: 1, results: [folderFiles[2]!] });
    const created = await request(app).post("/api/batches").set(auth).send({
      originalInput: "Burial Song", defaultType: "album_folder", mode: "review",
      entries: [{ original: "Burial Song", queryText: "Burial Song", type: "album_folder",
        seedKind: "track_seed", quality: "mp3_320" }]
    });
    await worker.runOnce();
    const item = (await request(app).get(`/api/batches/${created.body.id}`).set(auth)).body.requests[0];
    let startBrowse!: () => void;
    let finishBrowse!: (files: RemoteFile[]) => void;
    const started = new Promise<void>(resolve => { startBrowse = resolve; });
    vi.mocked(port.browse).mockImplementationOnce(async () => {
      startBrowse();
      return new Promise<RemoteFile[]>(resolve => { finishBrowse = resolve; });
    });
    const pending = request(app).post(`/api/requests/${item.id}/preview`).set(auth)
      .send({ candidateId: item.candidates[0].id }).then(response => response);
    await started;
    expect((await request(app).post(`/api/requests/${item.id}/show-all`).set(auth).send({})).status).toBe(200);
    finishBrowse(folderFiles);
    expect((await pending).status).toBe(409);
    expect(store.batchDetail(created.body.id)?.requests[0]?.previews).toHaveLength(0);
  });

  it("searches without an upfront choice and allows inspecting another file after one hit was queued", async () => {
    const { app, port, worker } = setup();
    const auth = await login(app);
    const created = await request(app).post("/api/batches").set(auth).send({
      originalInput: "Burial - Archangel", defaultType: "search", mode: "review",
      entries: [{ ...entries[0], type: "search" }]
    });
    expect(created.status).toBe(201);
    await worker.runOnce();
    expect(port.startSearch).toHaveBeenCalledWith("burial archangel", 5000);
    const item = (await request(app).get(`/api/batches/${created.body.id}`).set(auth)).body.requests[0];
    expect(item).toMatchObject({ type: "search", status: "review", quality: "flac" });
    expect((await request(app).post(`/api/requests/${item.id}/preview`).set(auth)
      .send({ candidateId: item.candidates[0].id })).status).toBe(200);
    expect((await request(app).post(`/api/requests/${item.id}/select`).set(auth)
      .send({ candidateId: item.candidates[0].id })).status).toBe(202);
    const refreshed = await request(app).post(`/api/requests/${item.id}/preview`).set(auth)
      .send({ candidateId: item.candidates[0].id });
    expect(refreshed.status).toBe(200);
    const cover = refreshed.body.files.find((file: { path: string }) => file.path.endsWith("cover.jpg"));
    expect((await request(app).post(`/api/requests/${item.id}/queue-folder`).set(auth)
      .send({ previewId: refreshed.body.id, selectedPaths: [cover.path] })).status).toBe(202);
    await worker.runOnce();
    expect(port.enqueue).toHaveBeenCalledTimes(2);
  });

  it("queues a selected subset of a folder from the same untyped search", async () => {
    const { app, worker, store, port } = setup();
    const auth = await login(app);
    const created = await request(app).post("/api/batches").set(auth).send({
      originalInput: "Burial - Untrue", defaultType: "search", mode: "review",
      entries: [{ ...entries[1], type: "search", seedKind: "track_seed" }]
    });
    await worker.runOnce();
    const item = (await request(app).get(`/api/batches/${created.body.id}`).set(auth)).body.requests[0];
    const preview = await request(app).post(`/api/requests/${item.id}/preview`).set(auth)
      .send({ candidateId: item.candidates[0].id });
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ eligible_count: 4, excluded_count: 0 });
    const selected = preview.body.files.find((file: { path: string }) => file.path.endsWith("01 - Archangel.flac"));
    expect((await request(app).post(`/api/requests/${item.id}/queue-folder`).set(auth)
      .send({ previewId: preview.body.id, selectedPaths: [selected.path] })).status).toBe(202);
    expect(store.batchDetail(created.body.id)?.requests[0]?.jobs[0]).toMatchObject({
      selected_count: 1, unselected_count: 3
    });
    await worker.runOnce();
    expect(port.enqueue).toHaveBeenCalledOnce();
  });

  it("queues a root-level search hit without requiring folder inspection", async () => {
    const { app, worker, setSnapshot, port } = setup();
    const auth = await login(app);
    const rootFile = remote("Example.flac");
    setSnapshot({ id: "search-1", state: "Completed", finished: true,
      reportedFileCount: 1, reportedResponseCount: 1, results: [rootFile] });
    const created = await request(app).post("/api/batches").set(auth).send({
      originalInput: "Example", defaultType: "search", mode: "review",
      entries: [{ original: "Example", queryText: "Example", type: "search",
        seedKind: "track_seed", quality: "flac" }]
    });
    await worker.runOnce();
    const item = (await request(app).get(`/api/batches/${created.body.id}`).set(auth)).body.requests[0];
    expect(item.candidates[0]).toMatchObject({ path: "Example.flac", directory: "", eligible: true });
    expect((await request(app).post(`/api/requests/${item.id}/select`).set(auth)
      .send({ candidateId: item.candidates[0].id })).status).toBe(202);
    await worker.runOnce();
    expect(port.enqueue).toHaveBeenCalledOnce();
  });

  it("does not accept an untyped search in automatic mode", async () => {
    const { app } = setup();
    const auth = await login(app);
    const response = await request(app).post("/api/batches").set(auth).send({
      originalInput: entries[0]!.original, defaultType: "search", mode: "automatic",
      entries: [{ ...entries[0], type: "search" }]
    });
    expect(response.status).toBe(400);
    expect(response.body.error).toContain("Automatic downloads require choosing");
  });

  it("numbers batches, stores edited full-text lines and permits removing reviewed lines", async () => {
    const { app, store } = setup();
    const auth = await login(app);
    const created = await request(app).post("/api/batches").set(auth).send({
      originalInput: "Pepper - Stone Love\nBurial - Archangel", defaultType: "track",
      mode: "review", entries: [{ ...entries[0], queryText: "burial archangel" }]
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ number: 1, name: "Search #1 · burial archangel" });
    const detail = (await request(app).get(`/api/batches/${created.body.id}`).set(auth)).body;
    expect(detail.requests).toHaveLength(1);
    expect(detail.requests[0]).toMatchObject({ query_text: "burial archangel", original_input: "Burial - Archangel" });
    store.run("UPDATE batches SET name=? WHERE id=?", "Batch #1 [2026-10-12]", created.body.id);
    expect((await request(app).get("/api/dashboard").set(auth)).body.batches[0].name)
      .toBe("Search #1 · burial archangel");
    expect((await request(app).get(`/api/batches/${created.body.id}`).set(auth)).body.batch.name)
      .toBe("Search #1 · burial archangel");
    const second = await request(app).post("/api/batches").set(auth).send({
      originalInput: "Ben Klock Subzero", defaultType: "track", mode: "review",
      entries: [{ original: "Ben Klock Subzero", queryText: "Ben Klock Subzero", type: "track",
        seedKind: "track_seed", quality: "flac" }]
    });
    expect(second.body).toMatchObject({ number: 2, name: "Search #2 · Ben Klock Subzero" });
    expect(store.all("SELECT number FROM batches")).toHaveLength(2);
  });

  it("separately clears finished-list entries and completed-byte statistics without touching active transfers", async () => {
    const { app, worker, transfers, port, store, config } = setup();
    const auth = await login(app);
    expect((await request(app).get("/api/downloads").set(headers)).status).toBe(401);
    const created = await request(app).post("/api/batches").set(auth).send({
      originalInput: entries[1]!.original, defaultType: "album_folder", mode: "review", entries: [entries[1]]
    });
    await worker.runOnce();
    const item = (await request(app).get(`/api/batches/${created.body.id}`).set(auth)).body.requests[0];
    const preview = await request(app).post(`/api/requests/${item.id}/preview`).set(auth)
      .send({ candidateId: item.candidates[0].id, recursive: false });
    const audioPaths = preview.body.files.filter((file: { path: string }) => file.path.endsWith(".flac"))
      .map((file: { path: string }) => file.path);
    expect((await request(app).post(`/api/requests/${item.id}/queue-folder`).set(auth)
      .send({ previewId: preview.body.id, selectedPaths: audioPaths })).status).toBe(202);
    await worker.runOnce();
    expect(transfers).toHaveLength(2);
    transfers[0]!.status = "completed"; transfers[0]!.transferred = 100;
    transfers[1]!.status = "active"; transfers[1]!.transferred = 25;
    await worker.runOnce();
    let downloads = (await request(app).get("/api/downloads").set(auth)).body;
    expect(downloads).toMatchObject({
      active_total: 1, finished_total: 1,
      stats: { completed_count: 1, completed_bytes: 100, active_count: 1, active_transferred_bytes: 25 }
    });
    expect(downloads.finished[0]).toMatchObject({ batch_number: 1, query_text: "Burial - Untrue" });
    expect((await request(app).post("/api/downloads/clear").set({ ...headers, Cookie: auth.Cookie })).status).toBe(403);
    expect((await request(app).post("/api/downloads/clear").set(auth).send({})).body).toEqual({ cleared: 1 });
    downloads = (await request(app).get("/api/downloads").set(auth)).body;
    expect(downloads).toMatchObject({ active_total: 1, finished_total: 0,
      stats: { completed_count: 1, completed_bytes: 100, active_count: 1 } });
    expect(store.batchDetail(created.body.id)?.requests[0]?.transfers).toHaveLength(2);
    expect(port.cancel).not.toHaveBeenCalled();
    expect((await request(app).post("/api/downloads/stats/clear").set(auth).send({})).body.stats)
      .toMatchObject({ completed_count: 0, completed_bytes: 0, active_count: 1, active_transferred_bytes: 25 });
    const reopened = new Store(config.DATABASE_PATH);
    expect(reopened.downloads(10, 10)).toMatchObject({
      active_total: 1, finished_total: 0, stats: { completed_count: 0, completed_bytes: 0 }
    });
    reopened.close();
    transfers[1]!.status = "completed"; transfers[1]!.transferred = 100;
    await worker.runOnce();
    downloads = (await request(app).get("/api/downloads?activeLimit=1&finishedLimit=1").set(auth)).body;
    expect(downloads).toMatchObject({ active_total: 0, finished_total: 1,
      stats: { completed_count: 1, completed_bytes: 100, active_count: 0 } });
    expect(downloads.finished).toHaveLength(1);
    expect((await request(app).get("/api/dashboard").set(auth)).body.downloads.stats.completed_bytes).toBe(100);
    await request(app).post("/api/downloads/stats/clear").set(auth).send({});
    downloads = (await request(app).get("/api/downloads").set(auth)).body;
    expect(downloads).toMatchObject({ finished_total: 1, stats: { completed_count: 0, completed_bytes: 0 } });
    await worker.runOnce();
    expect(port.enqueue).toHaveBeenCalledTimes(2);
  });

  it("sorts downloads before pagination by update date and file size", async () => {
    const { app, store, worker } = setup();
    const auth = await login(app);
    const created = await request(app).post("/api/batches").set(auth).send({
      originalInput: entries[1]!.original, defaultType: "album_folder", mode: "review", entries: [entries[1]]
    });
    await worker.runOnce();
    const item = (await request(app).get(`/api/batches/${created.body.id}`).set(auth)).body.requests[0];
    const preview = await request(app).post(`/api/requests/${item.id}/preview`).set(auth)
      .send({ candidateId: item.candidates[0].id });
    expect((await request(app).post(`/api/requests/${item.id}/queue-folder`).set(auth)
      .send({ previewId: preview.body.id })).status).toBe(202);
    const queued = store.all<{ id: string }>("SELECT id FROM transfers ORDER BY path");
    expect(queued).toHaveLength(4);
    for (const [index, transfer] of queued.entries()) {
      const size = [20, 40, 10, 30][index];
      if (size === undefined) throw new Error("Unexpected transfer count");
      store.run("UPDATE transfers SET size=?,status=?,username=?,updated_at=? WHERE id=?",
        size, ["completed", "failed", "cancelled", "completed"][index]!,
        index === 1 ? "bob" : "alice",
        new Date(Date.UTC(2026, 9, 10 + index)).toISOString(), transfer.id);
    }
    const files = async (sort: string) => {
      const response = await request(app).get(`/api/downloads?sort=${sort}&finishedLimit=2`).set(auth);
      expect(response.status).toBe(200);
      expect(response.body.finished_total).toBe(4);
      return response.body.finished.map((file: { size: number }) => file.size);
    };
    expect(await files("largest")).toEqual([40, 30]);
    expect(await files("smallest")).toEqual([10, 20]);
    expect(await files("newest")).toEqual([30, 10]);
    expect(await files("oldest")).toEqual([20, 40]);
    expect(await files("pathAsc")).toEqual([20, 40]);
    expect(await files("pathDesc")).toEqual([30, 10]);
    expect(await files("peerAsc")).toEqual([30, 10]);
    expect(await files("peerDesc")).toEqual([40, 30]);
    expect(await files("statusAsc")).toEqual([10, 30]);
    expect(await files("statusDesc")).toEqual([40, 30]);
    expect((await request(app).get("/api/downloads?sort=arbitrary").set(auth)).status).toBe(400);
  });

  it("shows active folder files in enqueue order before pagination, while finished files stay newest first", async () => {
    const { app, store, worker, port } = setup();
    const auth = await login(app);
    const created = await request(app).post("/api/batches").set(auth).send({
      originalInput: entries[1]!.original, defaultType: "album_folder", mode: "review", entries: [entries[1]]
    });
    await worker.runOnce();
    const item = (await request(app).get(`/api/batches/${created.body.id}`).set(auth)).body.requests[0];
    const preview = await request(app).post(`/api/requests/${item.id}/preview`).set(auth)
      .send({ candidateId: item.candidates[0].id });
    expect((await request(app).post(`/api/requests/${item.id}/queue-folder`).set(auth)
      .send({ previewId: preview.body.id })).status).toBe(202);
    const queued = store.all<{ id: string; path: string }>("SELECT id,path FROM transfers ORDER BY rowid");
    expect(queued).toHaveLength(4);
    await worker.runOnce();
    expect(vi.mocked(port.enqueue).mock.calls.map(([, file]) => file.path)).toEqual(queued.map(file => file.path));
    for (const [index, transfer] of queued.entries()) {
      store.run("UPDATE transfers SET created_at=?,updated_at=?,status=? WHERE id=?",
        "2026-10-13T00:00:00.000Z", new Date(Date.UTC(2026, 9, 13, 0, 0, index)).toISOString(),
        "active", transfer.id);
    }
    const getDownloads = async (query = "") => {
      const response = await request(app).get(`/api/downloads?activeLimit=2&finishedLimit=2${query}`).set(auth);
      expect(response.status).toBe(200);
      return response.body;
    };
    let downloads = await getDownloads();
    expect(downloads.active_total).toBe(4);
    expect(downloads.active.map((file: { path: string }) => file.path))
      .toEqual(queued.slice(0, 2).map(file => file.path));
    downloads = await getDownloads("&activeSort=queuedDesc");
    expect(downloads.active.map((file: { path: string }) => file.path))
      .toEqual(queued.slice(2).reverse().map(file => file.path));
    store.run("UPDATE transfers SET status='completed' WHERE id IN (?,?)", queued[2]!.id, queued[3]!.id);
    downloads = await getDownloads();
    expect(downloads.active.map((file: { path: string }) => file.path))
      .toEqual(queued.slice(0, 2).map(file => file.path));
    expect(downloads.finished.map((file: { path: string }) => file.path))
      .toEqual(queued.slice(2).reverse().map(file => file.path));
    expect((await request(app).get("/api/downloads?activeSort=arbitrary").set(auth)).status).toBe(400);
  });

  it("restores a hidden failed download to the list when it is explicitly retried", async () => {
    const { app, worker, transfers } = setup();
    const auth = await login(app);
    const created = await request(app).post("/api/batches").set(auth).send({
      originalInput: entries[0]!.original, defaultType: "track", mode: "review", entries: [entries[0]]
    });
    await worker.runOnce();
    const item = (await request(app).get(`/api/batches/${created.body.id}`).set(auth)).body.requests[0];
    expect((await request(app).post(`/api/requests/${item.id}/select`).set(auth)
      .send({ candidateId: item.candidates[0].id })).status).toBe(202);
    await worker.runOnce();
    transfers[0]!.status = "failed";
    await worker.runOnce();
    expect((await request(app).post("/api/downloads/clear").set(auth).send({})).body.cleared).toBe(1);
    const transferId = (await request(app).get(`/api/batches/${created.body.id}`).set(auth)).body.requests[0].transfers[0].id;
    expect((await request(app).post(`/api/transfers/${transferId}/retry`)
      .set(auth).send({})).status).toBe(202);
    expect((await request(app).get("/api/downloads").set(auth)).body.active_total).toBe(1);
  });

  it("protects mutations and stores per-request overrides and activity across restart", async () => {
    const { app, store, worker, config } = setup();
    expect((await request(app).get("/api/health")).status).toBe(200);
    expect((await request(app).post("/api/batches").set(headers).send({})).status).toBe(401);
    expect((await request(app).post("/api/login").set(headers).send({ username: "admin", password: "wrong" })).status).toBe(401);
    const auth = await login(app);
    expect((await request(app).post("/api/batches").set({ ...headers, Cookie: auth.Cookie }).send({})).status).toBe(403);
    const created = await request(app).post("/api/batches").set(auth).send({
      originalInput: entries.map(item => item.original).join("\n"), defaultType: "track",
      mode: "review", entries
    });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    let detail = (await request(app).get(`/api/batches/${id}`).set(auth)).body;
    expect(detail.requests.map((item: MusicRequest) => [item.type, item.quality])).toEqual([["track", "flac"], ["album_folder", "flac"]]);
    expect(detail.batch.name).toBe("Search #1 · Burial - Archangel (+1 more)");
    expect(detail.batch.counts).toEqual({ pending: 2 });
    await worker.runOnce();
    detail = (await request(app).get(`/api/batches/${id}`).set(auth)).body;
    expect(detail.requests.every((item: MusicRequest) => item.status === "review")).toBe(true);
    expect((await request(app).get("/api/activity?category=search&limit=2").set(auth)).body).toHaveLength(2);
    expect((await request(app).get("/api/activity?search=Mixed").set(auth)).status).toBe(200);
    expect((await request(app).get("/api/activity?sort=severity&cursor=99999999").set(auth)).status).toBe(400);
    const noCsrf = await request(app).post(`/api/requests/${detail.requests[0].id}/select`).set({ ...headers, Cookie: auth.Cookie })
      .send({ candidateId: detail.requests[0].candidates[0].id });
    expect(noCsrf.status).toBe(403);
    const selected = await request(app).post(`/api/requests/${detail.requests[0].id}/select`).set(auth)
      .send({ candidateId: detail.requests[0].candidates[0].id });
    expect(selected.status).toBe(202);
    await worker.runOnce();
    detail = (await request(app).get(`/api/batches/${id}`).set(auth)).body;
    expect(detail.requests[0].transfers).toHaveLength(1);
    expect(detail.requests[1].transfers).toHaveLength(0);
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const reopened = new Store(config.DATABASE_PATH);
    stores.push(reopened);
    expect(reopened.activity({ batchId: id }).length).toBeGreaterThan(0);
    expect(reopened.batchDetail(id)?.requests).toHaveLength(2);
  });

  it("inspects all files in the exact folder, queues the chosen audio subset, and preserves partial progress", async () => {
    const { app, store, worker, transfers, port } = setup();
    const auth = await login(app);
    const body = { originalInput: "Burial - Untrue", defaultType: "album_folder",
      mode: "review", entries: [entries[1]] };
    const created = await request(app).post("/api/batches").set(auth).send(body);
    await worker.runOnce();
    const batch = (await request(app).get(`/api/batches/${created.body.id}`).set(auth)).body;
    const item = batch.requests[0];
    const previewResponse = await request(app).post(`/api/requests/${item.id}/preview`).set(auth)
      .send({ candidateId: item.candidates[0].id, recursive: false });
    expect(previewResponse.status).toBe(200);
    expect(previewResponse.body).toMatchObject({ eligible_count: 4, excluded_count: 0,
      audio_bytes: 400, eligible_bytes: 400 });
    expect(previewResponse.body.files).toHaveLength(4);
    expect(previewResponse.body.files.some((file: RemoteFile) => file.path.includes("Sibling"))).toBe(false);
    expect(previewResponse.body.files.some((file: RemoteFile) => file.path.includes("Nested"))).toBe(false);
    const selectedPaths = previewResponse.body.files.filter((file: { path: string }) => file.path.endsWith(".flac"))
      .map((file: { path: string }) => file.path);
    const queued = await request(app).post(`/api/requests/${item.id}/queue-folder`).set(auth)
      .send({ previewId: previewResponse.body.id, selectedPaths });
    expect(queued.status).toBe(202);
    await worker.runOnce();
    expect(port.enqueue).toHaveBeenCalledTimes(2);
    transfers[0]!.status = "completed"; transfers[0]!.transferred = 100;
    transfers[1]!.status = "failed";
    await worker.runOnce();
    const updated = (await request(app).get(`/api/batches/${created.body.id}`).set(auth)).body.requests[0];
    expect(updated.status).toBe("partial");
    expect(updated.jobs[0]).toMatchObject({ eligible_count: 4, excluded_count: 0,
      selected_count: 2, unselected_count: 2, status: "partial" });
    expect(updated.transfers.map((t: { status: string }) => t.status)).toEqual(["completed", "failed"]);
    const failed = updated.transfers.find((t: { status: string }) => t.status === "failed");
    expect((await request(app).post(`/api/transfers/${failed.id}/retry`).set(auth).send({})).status).toBe(202);
    await worker.runOnce();
    expect(port.enqueue).toHaveBeenCalledTimes(3);
    transfers[2]!.status = "completed"; transfers[2]!.transferred = 100;
    await worker.runOnce();
    const recovered = (await request(app).get(`/api/batches/${created.body.id}`).set(auth)).body.requests[0];
    expect(recovered.status).toBe("partial");
    expect(recovered.transfers.every((t: { status: string }) => t.status === "completed")).toBe(true);
    expect(recovered.transfers.find((t: { id: string }) => t.id === failed.id).retries).toBe(1);
  });

  it("queues checked non-audio files, rejects invalid sizes, and records an intentionally partial folder", async () => {
    const { app, worker, store, transfers, port, folderFiles } = setup();
    folderFiles.push({ ...remote("alice\\Burial\\Untrue\\empty.nfo"), size: 0 });
    const auth = await login(app);
    const created = await request(app).post("/api/batches").set(auth).send({
      originalInput: entries[1]!.original, defaultType: "album_folder", mode: "review", entries: [entries[1]]
    });
    await worker.runOnce();
    const item = (await request(app).get(`/api/batches/${created.body.id}`).set(auth)).body.requests[0];
    const inspected = await request(app).post(`/api/requests/${item.id}/preview`).set(auth)
      .send({ candidateId: item.candidates[0].id, recursive: false });
    const previewId = inspected.body.id as string;
    expect(inspected.body).toMatchObject({ eligible_count: 4, excluded_count: 1 });
    const eligiblePath = folderFiles[3]!.path;
    const excludedPath = folderFiles[6]!.path;
    expect(inspected.body.files.find((file: { path: string }) => file.path === eligiblePath)).toMatchObject({ eligible: true });
    for (const paths of [[excludedPath], ["alice\\Burial\\Another\\04 - Sibling.flac"], []]) {
      expect((await request(app).post(`/api/requests/${item.id}/queue-folder`).set(auth)
        .send({ previewId, selectedPaths: paths })).status).toBe(422);
    }
    expect((await request(app).post(`/api/requests/${item.id}/queue-folder`).set(auth)
      .send({ previewId, selectedPaths: [eligiblePath, eligiblePath] })).status).toBe(400);
    expect(store.all("SELECT * FROM transfers")).toHaveLength(0);
    const queued = await request(app).post(`/api/requests/${item.id}/queue-folder`).set(auth)
      .send({ previewId, selectedPaths: [eligiblePath] });
    expect(queued.status).toBe(202);
    await worker.runOnce();
    expect(port.enqueue).toHaveBeenCalledTimes(1);
    expect(transfers[0]?.path).toBe(eligiblePath);
    const job = (await request(app).get(`/api/batches/${created.body.id}`).set(auth)).body.requests[0].jobs[0];
    expect(job).toMatchObject({ discovered_count: 5, eligible_count: 4, excluded_count: 1,
      selected_count: 1, unselected_count: 3, estimated_bytes: 100 });
    transfers[0]!.status = "completed"; transfers[0]!.transferred = 100;
    await worker.runOnce();
    expect((await request(app).get(`/api/batches/${created.body.id}`).set(auth)).body.requests[0].status).toBe("partial");
  });

  it("marks a folder partial when only one of two otherwise eligible files was selected", async () => {
    const { app, worker, folderFiles, transfers } = setup();
    folderFiles.splice(2, 1);
    const auth = await login(app);
    const created = await request(app).post("/api/batches").set(auth).send({
      originalInput: entries[1]!.original, defaultType: "album_folder", mode: "review", entries: [entries[1]]
    });
    await worker.runOnce();
    const item = (await request(app).get(`/api/batches/${created.body.id}`).set(auth)).body.requests[0];
    const inspected = await request(app).post(`/api/requests/${item.id}/preview`).set(auth)
      .send({ candidateId: item.candidates[0].id });
    expect(inspected.body).toMatchObject({ eligible_count: 3, excluded_count: 0, audio_bytes: 300 });
    expect((await request(app).post(`/api/requests/${item.id}/queue-folder`).set(auth).send({
      previewId: inspected.body.id, selectedPaths: [inspected.body.files[0].path]
    })).status).toBe(202);
    await worker.runOnce();
    transfers[0]!.status = "completed"; transfers[0]!.transferred = 100;
    await worker.runOnce();
    const result = (await request(app).get(`/api/batches/${created.body.id}`).set(auth)).body.requests[0];
    expect(result.status).toBe("partial");
    expect(result.jobs[0]).toMatchObject({ excluded_count: 0, selected_count: 1, unselected_count: 2 });
    expect((await request(app).post(`/api/requests/${item.id}/queue-folder`).set(auth)
      .send({ previewId: inspected.body.id, selectedPaths: [inspected.body.files[1].path] })).status).toBe(409);
  });

  it("uses exact search-hit metadata when the peer omits it in a folder browse", async () => {
    const { app, worker, folderFiles, port, setSnapshot } = setup();
    const searched = { ...folderFiles[2]!, path: folderFiles[2]!.path.replace(/\\/g, "/"),
      directory: folderFiles[2]!.directory.replace(/\\/g, "/"),
      metadata: { ...unknownMetadata(), bitrate: 320, vbr: false } };
    setSnapshot({ id: "search-1", state: "Completed", finished: true,
      reportedFileCount: 1, reportedResponseCount: 1, results: [searched] });
    const auth = await login(app);
    const entry = { ...entries[1]!, original: "Burial Song", queryText: "Burial Song", quality: "mp3_320" };
    const created = await request(app).post("/api/batches").set(auth).send({
      originalInput: entry.original, defaultType: "album_folder", mode: "review", entries: [entry]
    });
    await worker.runOnce();
    const item = (await request(app).get(`/api/batches/${created.body.id}`).set(auth)).body.requests[0];
    const inspected = await request(app).post(`/api/requests/${item.id}/preview`).set(auth)
      .send({ candidateId: item.candidates[0].id });
    expect(inspected.status).toBe(200);
    expect(inspected.body).toMatchObject({ eligible_count: 4, excluded_count: 0 });
    const mp3 = inspected.body.files.find((file: { path: string }) => file.path.endsWith(".mp3"));
    expect(mp3).toMatchObject({ eligible: true, metadata: { bitrate: 320, vbr: false } });
    expect((await request(app).post(`/api/requests/${item.id}/queue-folder`).set(auth)
      .send({ previewId: inspected.body.id, selectedPaths: [mp3.path] })).status).toBe(202);
    await worker.runOnce();
    expect(port.enqueue).toHaveBeenCalledTimes(1);
    expect(folderFiles[2]!.metadata.bitrate).toBeNull();
  });

  it("excludes a file when search and browse reports contradict each other", async () => {
    const { app, worker, folderFiles, setSnapshot } = setup();
    folderFiles[2]!.metadata = { ...unknownMetadata(), bitrate: 192, vbr: true };
    setSnapshot({ id: "search-1", state: "Completed", finished: true,
      reportedFileCount: 1, reportedResponseCount: 1,
      results: [{ ...folderFiles[2]!, metadata: { ...unknownMetadata(), bitrate: 320, vbr: false } }] });
    const auth = await login(app);
    const entry = { ...entries[1]!, original: "Burial Song", queryText: "Burial Song", quality: "mp3_320" };
    const created = await request(app).post("/api/batches").set(auth).send({
      originalInput: entry.original, defaultType: "album_folder", mode: "review", entries: [entry]
    });
    await worker.runOnce();
    const item = (await request(app).get(`/api/batches/${created.body.id}`).set(auth)).body.requests[0];
    const inspected = await request(app).post(`/api/requests/${item.id}/preview`).set(auth)
      .send({ candidateId: item.candidates[0].id });
    const mp3 = inspected.body.files.find((file: { path: string }) => file.path.endsWith(".mp3"));
    expect(mp3).toMatchObject({ eligible: true, metadata: { bitrate: null, vbr: null } });
    expect(inspected.body.eligible_count).toBe(4);
  });

  it("rejects changed remote folders and limits recursive scope", async () => {
    const { app, store, worker, folderFiles } = setup();
    const auth = await login(app);
    const created = await request(app).post("/api/batches").set(auth).send({
      originalInput: "Burial - Untrue", defaultType: "album_folder", mode: "review", entries: [entries[1]]
    });
    await worker.runOnce();
    const item = (await request(app).get(`/api/batches/${created.body.id}`).set(auth)).body.requests[0];
    const preview = await request(app).post(`/api/requests/${item.id}/preview`).set(auth)
      .send({ candidateId: item.candidates[0].id, recursive: true });
    expect(preview.body.eligible_count).toBe(5);
    folderFiles[0]!.size = 200;
    expect((await request(app).post(`/api/requests/${item.id}/queue-folder`).set(auth)
      .send({ previewId: preview.body.id })).status).toBe(409);
    expect(store.all("SELECT * FROM transfers")).toHaveLength(0);
  });

  it("shows the failing peer field instead of a generic inspection error", async () => {
    const { app, port, worker } = setup();
    const auth = await login(app);
    const created = await request(app).post("/api/batches").set(auth).send({
      originalInput: entries[1]!.original, defaultType: "album_folder", mode: "review", entries: [entries[1]]
    });
    await worker.runOnce();
    const item = (await request(app).get(`/api/batches/${created.body.id}`).set(auth)).body.requests[0];
    vi.mocked(port.browse).mockRejectedValueOnce(
      new SlskdShapeError("POST directory", "directories.0.files.3.size", "expected nonnegative number"));
    const result = await request(app).post(`/api/requests/${item.id}/preview`).set(auth)
      .send({ candidateId: item.candidates[0].id });
    expect(result.status).toBe(502);
    expect(result.body.error).toContain("directories.0.files.3.size");
    expect(result.body.error).not.toContain("test-api-key");
  });

  it("shows a safe slskd timeout on the folder instead of a generic inspection error", async () => {
    const { app, worker, port } = setup();
    const auth = await login(app);
    const created = await request(app).post("/api/batches").set(auth).send({
      originalInput: entries[1]!.original, defaultType: "album_folder", mode: "review", entries: [entries[1]]
    });
    await worker.runOnce();
    const item = (await request(app).get(`/api/batches/${created.body.id}`).set(auth)).body.requests[0];
    vi.mocked(port.browse).mockRejectedValueOnce(new SlskdRequestError("slskd POST timed out after 45000 ms"));
    const result = await request(app).post(`/api/requests/${item.id}/preview`).set(auth)
      .send({ candidateId: item.candidates[0].id });
    expect(result.status).toBe(502);
    expect(result.body.error).toBe("slskd POST timed out after 45000 ms");
  });

  it("keeps manual downloads selectable while changing the old search quality only after an explicit retry", async () => {
    const { app, worker, store, port } = setup();
    const auth = await login(app);
    const created = await request(app).post("/api/batches").set(auth).send({
      originalInput: entries[0]!.original, defaultType: "track", mode: "review",
      entries: [{ ...entries[0], quality: "mp3_320" }]
    });
    await worker.runOnce();
    let item = (await request(app).get(`/api/batches/${created.body.id}`).set(auth)).body.requests[0];
    expect(item).toMatchObject({ status: "review", quality: "mp3_320" });
    expect(item.candidates[0]).toMatchObject({ eligible: true, reason: "Available for manual download" });
    expect(item.transfers).toHaveLength(0);
    expect(port.enqueue).not.toHaveBeenCalled();
    expect((await request(app).post(`/api/requests/${item.id}/retry`).set(auth).send({ quality: "flac" })).status).toBe(200);
    await worker.runOnce();
    item = (await request(app).get(`/api/batches/${created.body.id}`).set(auth)).body.requests[0];
    expect(item).toMatchObject({ status: "review", quality: "flac", search_window_ms: 5000 });
    expect(item.candidates[0].eligible).toBe(true);
    expect(store.activity({ requestId: item.id, category: "search", search: "Retry requested" })).toHaveLength(1);
    expect((await request(app).post(`/api/requests/${item.id}/retry`).set(auth)
      .send({ quality: "flac", longer: true })).status).toBe(200);
    expect(store.get<MusicRequest>("SELECT * FROM requests WHERE id=?", item.id)?.search_window_ms).toBe(40000);
    await worker.runOnce();
    expect(port.startSearch).toHaveBeenLastCalledWith("burial archangel", 40000);
  });

  it("keeps automatic quality strict even when manual review accepts non-audio files", async () => {
    const { app, worker, port, setSnapshot } = setup();
    setSnapshot({ id: "search-1", state: "Completed", finished: true,
      reportedFileCount: 1, reportedResponseCount: 1,
      results: [remote("alice\\Burial\\Archangel.jpg")] });
    const auth = await login(app);
    const created = await request(app).post("/api/batches").set(auth).send({
      originalInput: "Burial Archangel", defaultType: "track", mode: "automatic",
      entries: [{ original: "Burial Archangel", queryText: "Burial Archangel", type: "track",
        seedKind: "track_seed", quality: "any" }]
    });
    await worker.runOnce();
    const item = (await request(app).get(`/api/batches/${created.body.id}`).set(auth)).body.requests[0];
    expect(item).toMatchObject({ status: "no_results", mode: "automatic" });
    expect(item.candidates[0]).toMatchObject({ eligible: false, reason: "Not a supported audio file" });
    expect(port.enqueue).not.toHaveBeenCalled();
  });

  it("automatically queues only confident tracks and leaves partial folders for review", async () => {
    const { app, store, worker, port } = setup();
    const auth = await login(app);
    const created = await request(app).post("/api/batches").set(auth).send({
      originalInput: `Archangel\n${entries[1]!.original}`, defaultType: "track",
      mode: "automatic", entries: [{ ...entries[0], original: "Archangel", queryText: "Archangel" }, entries[1]]
    });
    await worker.runOnce();
    let detail = (await request(app).get(`/api/batches/${created.body.id}`).set(auth)).body;
    expect(detail.requests[0].status).toBe("queueing");
    expect(detail.requests[1].status).toBe("review");
    await worker.runOnce();
    detail = (await request(app).get(`/api/batches/${created.body.id}`).set(auth)).body;
    expect(detail.requests[0].transfers).toHaveLength(1);
    expect(detail.requests[1].transfers).toHaveLength(0);
    expect(port.enqueue).toHaveBeenCalledTimes(1);
    expect(store.activity({ category: "automatic", search: "manual review" }).length).toBeGreaterThan(0);
  });

  it("automatically queues every file from a uniquely verified complete album", async () => {
    const { app, worker, store, port, folderFiles, transfers, setSnapshot } = setup();
    folderFiles.splice(0, folderFiles.length, ...Array.from({ length: 8 }, (_, i) =>
      remote(`alice\\Burial\\Untrue\\${String(i + 1).padStart(2, "0")} - Song.flac`)));
    folderFiles.push(remote("alice\\Burial\\Untrue\\cover.jpg"));
    setSnapshot({ id: "search-1", state: "Completed", finished: true,
      reportedFileCount: 1, reportedResponseCount: 1, results: [folderFiles[0]!] });
    const auth = await login(app);
    const created = await request(app).post("/api/batches").set(auth).send({
      originalInput: entries[1]!.original,
      defaultType: "album_folder", mode: "automatic", entries: [entries[1]]
    });
    await worker.runOnce();
    let detail = (await request(app).get(`/api/batches/${created.body.id}`).set(auth)).body.requests[0];
    expect(detail.jobs[0]).toMatchObject({ discovered_count: 8, eligible_count: 8, excluded_count: 0 });
    await worker.runOnce();
    expect(port.enqueue).toHaveBeenCalledTimes(8);
    for (const transfer of transfers) { transfer.status = "completed"; transfer.transferred = 100; }
    await worker.runOnce();
    detail = (await request(app).get(`/api/batches/${created.body.id}`).set(auth)).body.requests[0];
    expect(detail.status).toBe("completed");
    expect(detail.transfers).toHaveLength(8);
    expect(store.activity({ category: "automatic", search: "Album selected" })).toHaveLength(1);
  });
});
