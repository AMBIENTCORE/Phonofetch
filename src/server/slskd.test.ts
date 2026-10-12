import { describe, expect, it, vi } from "vitest";
import { SlskdAdapter, SlskdError } from "./slskd";
import { qualityCheck } from "./matching";

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json" }
});
const file = (filename: string) => ({
  filename, size: 3828401, extension: ".mp3", code: 1,
  bitRate: 320, sampleRate: 44100, isVariableBitRate: false
});

describe("slskd 0.26.1 REST adapter", () => {
  it("authenticates with X-API-Key, searches, reads flattened search responses", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      expect(init?.headers).toMatchObject({ "X-API-Key": "secret" });
      const url = String(input);
      if (url.endsWith("/api/v0/session")) return new Response(null, { status: 200 });
      if (url.endsWith("/api/v0/searches") && init?.method === "POST") {
        expect(JSON.parse(String(init.body))).toMatchObject({ searchText: "Burial Archangel", fileLimit: 5, searchTimeout: 5 });
        return json({ id: "search-id", state: "InProgress", searchText: "Burial Archangel" });
      }
      if (url.endsWith("/api/v0/searches/search-id")) return json({ id: "search-id", state: "Completed" });
      if (url.endsWith("/api/v0/searches/search-id/responses")) return json([
        { username: "alice", files: [file("Burial\\Untrue\\01 Archangel.mp3"),
          { filename: "Burial\\Untrue\\02 Missing.mp3", size: 100, code: 1 }] }
      ]);
      throw new Error(`Unexpected request ${url}`);
    });
    const adapter = new SlskdAdapter("http://slskd:5030", "secret", 5000, 5, fetcher);
    await adapter.check();
    expect(await adapter.startSearch("Burial Archangel")).toBe("search-id");
    const snapshot = await adapter.getSearch("search-id");
    expect(snapshot.finished).toBe(true);
    expect(snapshot.results).toHaveLength(2);
    expect(snapshot.results[0]).toMatchObject({
      username: "alice", path: "Burial\\Untrue\\01 Archangel.mp3", directory: "Burial\\Untrue",
      metadata: { bitrate: 320, vbr: false, sampleRate: 44100 }
    });
    expect(snapshot.results[1]?.metadata).toMatchObject({ bitrate: null, vbr: null });
  });

  it("browses one directory by POST and the flat share only for explicit recursion", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (String(input).endsWith("/directory")) {
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toEqual({ directory: "Burial\\Untrue" });
      }
      return json([
        { name: "Burial\\Untrue", fileCount: 2, files: [
          { ...file("Burial\\Untrue\\01 Archangel.mp3"), attributes: [{ type: 0, value: 320 }, { type: 2, value: 0 }] },
          { filename: "Burial\\Untrue\\02 Ghost.flac", size: 1234, sampleRate: 96000, bitDepth: 24 }] },
        { name: "Burial\\Another", files: [file("Burial\\Another\\03 Sibling.mp3")] },
        { name: "Burial\\Untrue\\CD2", files: [file("Burial\\Untrue\\CD2\\04 Nested.mp3")] }
      ]);
    });

    const adapter = new SlskdAdapter("http://slskd:5030", "secret", 5000, 10, fetcher);
    const direct = await adapter.browse("alice", "Burial\\Untrue", false);
    expect(direct.map(item => item.path)).toEqual(["Burial\\Untrue\\01 Archangel.mp3", "Burial\\Untrue\\02 Ghost.flac"]);
    expect(direct[0]?.metadata.vbr).toBe(false);
    const recursive = await adapter.browse("alice", "Burial\\Untrue", true);
    expect(recursive).toHaveLength(3);
    expect(recursive.some(item => item.path.includes("Sibling"))).toBe(false);
    expect(fetcher.mock.calls[1]?.[0]).toBe("http://slskd:5030/api/v0/users/alice/browse");
  });

  it("does not accept contradictory raw and flattened audio metadata", async () => {
    const adapter = new SlskdAdapter("http://slskd:5030", "secret", 5000, 10,
      vi.fn(async () => json([{ name: "Album", files: [{
        filename: "Album\\song.mp3", size: 100, bitRate: 320, isVariableBitRate: false,
        attributes: [{ type: 0, value: 192 }, { type: 2, value: 1 }]
      }] }])));
    const [candidate] = await adapter.browse("peer", "Album", false);
    expect(candidate?.metadata).toMatchObject({ bitrate: null, vbr: null });
    expect(qualityCheck(candidate!, "mp3_320").eligible).toBe(false);
  });

  it("enqueues one file with a stable batch id and reconciles/cancels by slskd transfer id", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url.endsWith("/downloads/batches")) {
        expect(JSON.parse(String(init?.body))).toEqual({
          id: "batch-id", username: "alice",
          files: [{ filename: "Burial\\Untrue\\01 Archangel.mp3", size: 3828401 }],
          options: { externalId: "batch-id" }
        });
        return json({ batch: { id: "batch-id",
          transfers: [{ id: "slskd-transfer-id", filename: "Burial\\Untrue\\01 Archangel.mp3" }] }, failures: [] }, 201);
      }
      if (url.endsWith("/downloads") && init?.method === "GET") return json([
        { username: "alice", directories: [{ directory: "Burial\\Untrue", files: [
          { id: "slskd-transfer-id", batchId: "batch-id", username: "alice", filename: "Burial\\Untrue\\01 Archangel.mp3",
            size: 3828401, bytesTransferred: 3828401, state: "Completed, Succeeded" }
        ] }] }
      ]);
      if (url.endsWith("/downloads/alice/slskd-transfer-id")) return new Response(null, { status: 204 });
      throw new Error(`Unexpected ${url}`);
    });
    const adapter = new SlskdAdapter("http://slskd:5030", "secret", 5000, 10, fetcher);
    expect(await adapter.enqueue("alice", { username: "alice", path: "Burial\\Untrue\\01 Archangel.mp3",
      directory: "Burial\\Untrue", size: 3828401, metadata: { bitrate: 320, sampleRate: null, bitDepth: null, vbr: false } },
    "batch-id")).toBe("slskd-transfer-id");
    expect(await adapter.transfers()).toMatchObject([{ id: "slskd-transfer-id", batchId: "batch-id", status: "completed" }]);
    await adapter.cancel("alice", "slskd-transfer-id");
  });

  it("reports API errors, partial enqueue and abort timeouts explicitly", async () => {
    const bad = new SlskdAdapter("http://slskd:5030", "secret", 5000, 10,
      vi.fn(async () => new Response(null, { status: 401 })));
    await expect(bad.check()).rejects.toBeInstanceOf(SlskdError);
    const partial = new SlskdAdapter("http://slskd:5030", "secret", 5000, 10,
      vi.fn(async () => json({ batch: { transfers: [] }, failures: [{ filename: "song.flac", message: "Peer offline" }] }, 200)));
    await expect(partial.enqueue("alice", { username: "alice", path: "song.flac", directory: "",
      size: 100, metadata: { bitrate: null, sampleRate: null, bitDepth: null, vbr: null } }, "batch-id"))
      .rejects.toThrow("failed file enqueue");
    const timed = new SlskdAdapter("http://slskd:5030", "secret", 10, 10,
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("Timed out", "TimeoutError"))))));
    await expect(timed.check()).rejects.toThrow("timed out");
    await expect(timed.startSearch("Artist Title")).rejects.toThrow("timed out");
    await expect(timed.browse("alice", "Album", false)).rejects.toThrow("timed out");
  });
});
