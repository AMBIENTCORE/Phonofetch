import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "./db";

describe("SQLite persistence and activity", () => {
  const paths: string[] = [];
  afterEach(() => { for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true }); });
  it("survives reopening, paginates and redacts secrets", () => {
    const folder = mkdtempSync(join(tmpdir(), "phonofetch-test-")); paths.push(folder);
    const path = join(folder, "db.sqlite");
    const a = new Store(path, ["sensitive"]);
    a.event("info", "search", "started", "sensitive query");
    a.event("error", "api", "failure", "X-API-Key: anothersecret", {}, { apiKey: "sensitive" });
    a.close();
    const b = new Store(path, ["sensitive"]);
    expect(b.activity()).toHaveLength(2);
    expect(b.activity()[0]?.message).not.toContain("anothersecret");
    expect(b.activity()[1]?.message).not.toContain("sensitive");
    expect(b.activity()[0]?.metadata).not.toContain("sensitive");
    expect(b.activity({ category: "search", search: "query" })).toHaveLength(1);
    b.event("info", "batch", "created", "Legacy search");
    expect(b.activity({ category: "search" })).toHaveLength(2);
    b.event("info", "quality", "folder_file_excluded", "Old per-file quality event");
    expect(b.activity({ hideFileDetails: true }).map(event => event.event_type))
      .not.toContain("folder_file_excluded");
    expect(b.activity({ cursor: b.activity()[0]?.id, limit: 1 })).toHaveLength(1);
    const oldest = b.activity({ order: "asc", limit: 1 })[0]!;
    expect(b.activity({ order: "asc", cursor: oldest.id, limit: 2 }).map(event => event.id))
      .toEqual(b.activity({ order: "asc" }).slice(1, 3).map(event => event.id));
    for (const sort of ["severity", "category", "message"] as const) {
      for (const order of ["asc", "desc"] as const) {
        const all = b.activity({ sort, order }).map(event => event.id);
        const first = b.activity({ sort, order, limit: 2 });
        const rest = b.activity({ sort, order, cursor: first[1]!.id });
        expect([...first, ...rest].map(event => event.id)).toEqual(all);
      }
    }
    b.close();
  });
  it("migrates existing v1 transfer and request tables atomically", () => {
    const folder = mkdtempSync(join(tmpdir(), "phonofetch-migrate-")); paths.push(folder);
    const path = join(folder, "db.sqlite");
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE transfers(id TEXT);
      CREATE TABLE batches(id TEXT,created_at TEXT);
      CREATE TABLE requests(id TEXT,norm_artist TEXT,norm_title TEXT,original_input TEXT);
      CREATE TABLE candidates(id TEXT);
      CREATE TABLE folder_jobs(id TEXT,eligible_count INTEGER);
      PRAGMA user_version=1`);
    old.close();
    const store = new Store(path);
    const transfers = store.all<{ name: string }>("PRAGMA table_info(transfers)").map(row => row.name);
    const requests = store.all<{ name: string }>("PRAGMA table_info(requests)").map(row => row.name);
    expect(transfers).toContain("slskd_id");
    expect(transfers).toContain("queue_id");
    expect(transfers).toContain("hidden_from_downloads");
    expect(requests).toContain("position");
    expect(requests).toContain("query_text");
    expect(store.all<{ name: string }>("PRAGMA table_info(batches)").map(row => row.name)).toContain("number");
    expect(store.all<{ name: string }>("PRAGMA table_info(folder_jobs)").map(row => row.name)).toContain("selected_count");
    expect(requests).toContain("search_window_ms");
    expect(store.all<{ name: string }>("PRAGMA table_info(candidates)").map(row => row.name)).toContain("upload_speed");
    expect(store.get<{ user_version: number }>("PRAGMA user_version")?.user_version).toBe(8);
    store.close();
  });

  it("numbers legacy batches and preserves original search text during v4 migration", () => {
    const folder = mkdtempSync(join(tmpdir(), "phonofetch-v4-")); paths.push(folder);
    const path = join(folder, "db.sqlite");
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE batches(id TEXT PRIMARY KEY,name TEXT,created_at TEXT);
      CREATE TABLE requests(id TEXT PRIMARY KEY,original_input TEXT,norm_artist TEXT,norm_title TEXT);
      CREATE TABLE candidates(id TEXT PRIMARY KEY);
      CREATE TABLE transfers(id TEXT PRIMARY KEY);
      CREATE TABLE folder_jobs(id TEXT,eligible_count INTEGER);
      INSERT INTO batches VALUES('b2','Later','2026-10-12T12:00:00Z');
      INSERT INTO batches VALUES('b1','Earlier','2026-10-11T12:00:00Z');
      INSERT INTO requests VALUES('r1','Burial - Archangel','burial','archangel');
      PRAGMA user_version=4`);
    old.close();
    const store = new Store(path);
    expect(store.all<{ id: string; number: number }>("SELECT id,number FROM batches ORDER BY number"))
      .toEqual([{ id: "b1", number: 1 }, { id: "b2", number: 2 }]);
    expect(store.get<{ query_text: string }>("SELECT query_text FROM requests WHERE id='r1'")?.query_text)
      .toBe("Burial - Archangel");
    expect(store.get<{ user_version: number }>("PRAGMA user_version")?.user_version).toBe(8);
    store.close();
  });

  it("preserves planned file counts on the existing v5 album jobs", () => {
    const folder = mkdtempSync(join(tmpdir(), "phonofetch-v5-")); paths.push(folder);
    const path = join(folder, "db.sqlite");
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE folder_jobs(id TEXT PRIMARY KEY,eligible_count INTEGER NOT NULL);
      CREATE TABLE requests(id TEXT PRIMARY KEY);
      CREATE TABLE candidates(id TEXT PRIMARY KEY);
      CREATE TABLE transfers(id TEXT PRIMARY KEY);
      INSERT INTO folder_jobs VALUES('job-one', 8);
      PRAGMA user_version=5`);
    old.close();
    const store = new Store(path);
    expect(store.get<{ selected_count: number; unselected_count: number }>(
      "SELECT selected_count,unselected_count FROM folder_jobs WHERE id='job-one'"))
      .toEqual({ selected_count: 8, unselected_count: 0 });
    expect(store.get<{ user_version: number }>("PRAGMA user_version")?.user_version).toBe(8);
    store.close();
  });

  it("migrates an in-progress v6 search without changing its existing window", () => {
    const folder = mkdtempSync(join(tmpdir(), "phonofetch-v6-")); paths.push(folder);
    const path = join(folder, "db.sqlite");
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE requests(id TEXT PRIMARY KEY);
      CREATE TABLE candidates(id TEXT PRIMARY KEY);
      CREATE TABLE transfers(id TEXT PRIMARY KEY);
      INSERT INTO requests VALUES('in-progress');
      PRAGMA user_version=6`);
    old.close();
    const store = new Store(path);
    expect(store.get<{ search_window_ms: number; search_stop_requested_at: string | null }>(
      "SELECT search_window_ms,search_stop_requested_at FROM requests WHERE id='in-progress'"))
      .toEqual({ search_window_ms: 40000, search_stop_requested_at: null });
    expect(store.get<{ user_version: number }>("PRAGMA user_version")?.user_version).toBe(8);
    store.close();
  });

  it("retains completed bytes and visible entries when migrating existing v7 downloads", () => {
    const folder = mkdtempSync(join(tmpdir(), "phonofetch-v7-")); paths.push(folder);
    const path = join(folder, "db.sqlite");
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE transfers(id TEXT PRIMARY KEY,status TEXT,size INTEGER,transferred INTEGER);
      INSERT INTO transfers VALUES('completed','completed',1234,1234);
      PRAGMA user_version=7`);
    old.close();
    const store = new Store(path);
    expect(store.downloadStats()).toMatchObject({ completed_count: 1, completed_bytes: 1234 });
    expect(store.get<{ hidden_from_downloads: number }>(
      "SELECT hidden_from_downloads FROM transfers WHERE id='completed'")?.hidden_from_downloads).toBe(0);
    expect(store.get<{ user_version: number }>("PRAGMA user_version")?.user_version).toBe(8);
    store.close();
  });
});
