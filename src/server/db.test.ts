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
    expect(b.activity({ cursor: b.activity()[0]?.id, limit: 1 })).toHaveLength(1);
    b.close();
  });
  it("migrates existing v1 transfer and request tables atomically", () => {
    const folder = mkdtempSync(join(tmpdir(), "phonofetch-migrate-")); paths.push(folder);
    const path = join(folder, "db.sqlite");
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE transfers(id TEXT);
      CREATE TABLE batches(id TEXT,created_at TEXT);
      CREATE TABLE requests(id TEXT,norm_artist TEXT,norm_title TEXT,original_input TEXT);
      PRAGMA user_version=1`);
    old.close();
    const store = new Store(path);
    const transfers = store.all<{ name: string }>("PRAGMA table_info(transfers)").map(row => row.name);
    const requests = store.all<{ name: string }>("PRAGMA table_info(requests)").map(row => row.name);
    expect(transfers).toContain("slskd_id");
    expect(transfers).toContain("queue_id");
    expect(requests).toContain("position");
    expect(requests).toContain("query_text");
    expect(store.all<{ name: string }>("PRAGMA table_info(batches)").map(row => row.name)).toContain("number");
    expect(store.get<{ user_version: number }>("PRAGMA user_version")?.user_version).toBe(5);
    store.close();
  });

  it("numbers legacy batches and preserves original search text during v4 migration", () => {
    const folder = mkdtempSync(join(tmpdir(), "phonofetch-v4-")); paths.push(folder);
    const path = join(folder, "db.sqlite");
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE batches(id TEXT PRIMARY KEY,name TEXT,created_at TEXT);
      CREATE TABLE requests(id TEXT PRIMARY KEY,original_input TEXT,norm_artist TEXT,norm_title TEXT);
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
    expect(store.get<{ user_version: number }>("PRAGMA user_version")?.user_version).toBe(5);
    store.close();
  });
});
