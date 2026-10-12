import { afterEach, describe, expect, it, vi } from "vitest";
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
  it("numbers batches, stores edited full-text lines and permits removing reviewed lines", async () => {
    const { app, store } = setup();
    const auth = await login(app);
    const created = await request(app).post("/api/batches").set(auth).send({
      originalInput: "Pepper - Stone Love\nBurial - Archangel", defaultType: "track",
      mode: "review", entries: [{ ...entries[0], queryText: "burial archangel" }]
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ number: 1, name: expect.stringMatching(/^Batch #1 \[\d{4}-\d{2}-\d{2}\]$/) });
    const detail = (await request(app).get(`/api/batches/${created.body.id}`).set(auth)).body;
    expect(detail.requests).toHaveLength(1);
    expect(detail.requests[0]).toMatchObject({ query_text: "burial archangel", original_input: "Burial - Archangel" });
    const second = await request(app).post("/api/batches").set(auth).send({
      originalInput: "Ben Klock Subzero", defaultType: "track", mode: "review",
      entries: [{ original: "Ben Klock Subzero", queryText: "Ben Klock Subzero", type: "track",
        seedKind: "track_seed", quality: "flac" }]
    });
    expect(second.body).toMatchObject({ number: 2, name: expect.stringMatching(/^Batch #2 \[\d{4}-\d{2}-\d{2}\]$/) });
    expect(store.all("SELECT number FROM batches")).toHaveLength(2);
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
    expect(detail.batch.name).toMatch(/^Batch #1 \[\d{4}-\d{2}-\d{2}\]$/);
    expect(detail.batch.counts).toEqual({ pending: 2 });
    await worker.runOnce();
    detail = (await request(app).get(`/api/batches/${id}`).set(auth)).body;
    expect(detail.requests.every((item: MusicRequest) => item.status === "review")).toBe(true);
    expect((await request(app).get("/api/activity?category=search&limit=2").set(auth)).body).toHaveLength(2);
    expect((await request(app).get("/api/activity?search=Mixed").set(auth)).status).toBe(200);
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

  it("inspects exact folder, queues eligible files only, and preserves partial progress", async () => {
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
    expect(previewResponse.body).toMatchObject({ eligible_count: 2, excluded_count: 1 });
    expect(previewResponse.body.files).toHaveLength(3);
    expect(previewResponse.body.files.some((file: RemoteFile) => file.path.includes("Sibling"))).toBe(false);
    expect(previewResponse.body.files.some((file: RemoteFile) => file.path.includes("Nested"))).toBe(false);
    const queued = await request(app).post(`/api/requests/${item.id}/queue-folder`).set(auth)
      .send({ previewId: previewResponse.body.id });
    expect(queued.status).toBe(202);
    await worker.runOnce();
    expect(port.enqueue).toHaveBeenCalledTimes(2);
    transfers[0]!.status = "completed"; transfers[0]!.transferred = 100;
    transfers[1]!.status = "failed";
    await worker.runOnce();
    const updated = (await request(app).get(`/api/batches/${created.body.id}`).set(auth)).body.requests[0];
    expect(updated.status).toBe("partial");
    expect(updated.jobs[0]).toMatchObject({ eligible_count: 2, excluded_count: 1, status: "partial" });
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
    expect(preview.body.eligible_count).toBe(3);
    folderFiles[0]!.size = 200;
    expect((await request(app).post(`/api/requests/${item.id}/queue-folder`).set(auth)
      .send({ previewId: preview.body.id })).status).toBe(409);
    expect(store.all("SELECT * FROM transfers")).toHaveLength(0);
  });

  it("never relaxes strict quality and only searches at a different quality after an explicit retry", async () => {
    const { app, worker, store, port } = setup();
    const auth = await login(app);
    const created = await request(app).post("/api/batches").set(auth).send({
      originalInput: entries[0]!.original, defaultType: "track", mode: "review",
      entries: [{ ...entries[0], quality: "mp3_320" }]
    });
    await worker.runOnce();
    let item = (await request(app).get(`/api/batches/${created.body.id}`).set(auth)).body.requests[0];
    expect(item).toMatchObject({ status: "no_results", quality: "mp3_320" });
    expect(item.candidates[0]).toMatchObject({ eligible: false, reason: "MP3 required" });
    expect(item.transfers).toHaveLength(0);
    expect(port.enqueue).not.toHaveBeenCalled();
    expect((await request(app).post(`/api/requests/${item.id}/retry`).set(auth).send({ quality: "flac" })).status).toBe(200);
    await worker.runOnce();
    item = (await request(app).get(`/api/batches/${created.body.id}`).set(auth)).body.requests[0];
    expect(item).toMatchObject({ status: "review", quality: "flac" });
    expect(item.candidates[0].eligible).toBe(true);
    expect(store.activity({ requestId: item.id, category: "search", search: "Retry requested" })).toHaveLength(1);
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
    setSnapshot({ id: "search-1", state: "Completed", finished: true,
      reportedFileCount: 1, reportedResponseCount: 1, results: [folderFiles[0]!] });
    const auth = await login(app);
    const created = await request(app).post("/api/batches").set(auth).send({
      originalInput: entries[1]!.original,
      defaultType: "album_folder", mode: "automatic", entries: [entries[1]]
    });
    await worker.runOnce();
    let detail = (await request(app).get(`/api/batches/${created.body.id}`).set(auth)).body.requests[0];
    expect(detail.jobs[0]).toMatchObject({ eligible_count: 8, excluded_count: 0 });
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
