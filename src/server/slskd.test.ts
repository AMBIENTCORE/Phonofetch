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
      if (url.endsWith("/api/v0/server")) return json({ isConnected: true, isLoggedIn: true, state: "Connected, LoggedIn" });
      if (url.endsWith("/api/v0/searches") && init?.method === "POST") {
        expect(JSON.parse(String(init.body))).toMatchObject({ searchText: "Burial Archangel", fileLimit: 5, searchTimeout: 40000 });
        return json({ id: "search-id", state: "InProgress", fileCount: 0, responseCount: 0, searchText: "Burial Archangel" });
      }
      if (url.endsWith("/api/v0/searches/search-id")) return json({
        id: "search-id", state: "Completed", endedAt: "2026-10-13T08:00:00Z", fileCount: 2, responseCount: 1
      });
      if (url.endsWith("/api/v0/searches/search-id/responses")) return json([
        { username: "alice", files: [{ ...file("Burial\\Untrue\\01 Archangel.mp3"),
          attributes: [{ type: "BitRate", value: 320 }, { type: "VariableBitRate", value: 0 }] },
          { filename: "Burial\\Untrue\\02 Missing.mp3", size: 100, code: 1 }] }
      ]);
      throw new Error(`Unexpected request ${url}`);
    });
    const adapter = new SlskdAdapter("http://slskd:5030", "secret", 45000, 5, fetcher);
    await adapter.check();
    expect(await adapter.startSearch("Burial Archangel")).toBe("search-id");
    const snapshot = await adapter.getSearch("search-id");
    expect(snapshot).toMatchObject({ finished: true, state: "Completed", reportedFileCount: 2, reportedResponseCount: 1 });
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
      const directories = [
        { name: "Burial\\Untrue", fileCount: 2, files: [
          { ...file("Burial\\Untrue\\01 Archangel.mp3"),
            attributes: [{ type: "BitRate", value: 320 }, { type: "VariableBitRate", value: 0 }] },
          { filename: "Burial\\Untrue\\02 Ghost.flac", size: 1234, sampleRate: 96000, bitDepth: 24 }] },
        { name: "Burial\\Another", files: [file("Burial\\Another\\03 Sibling.mp3")] },
        { name: "Burial\\Untrue\\CD2", files: [file("Burial\\Untrue\\CD2\\04 Nested.mp3")] }
      ];
      return json(init?.method === "GET" ? { directories, lockedDirectories: [] } : directories);
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

  it("expands basename-only folder responses without crossing into sibling directories", async () => {
    const fetcher = vi.fn(async () => json([
      { name: "Music/Album", files: [
        { filename: "01 Track.flac", size: 500 },
        { filename: "02 Track.mp3", size: 250 },
        { filename: "../Sibling/03 Track.flac", size: 100 }] },
      { name: "Music/Sibling", files: [{ filename: "04 Sibling.flac", size: 100 }] },
      { name: "Music/Album/Disc 2", files: [{ filename: "05 Nested.flac", size: 150 }] }
    ]));
    const adapter = new SlskdAdapter("http://slskd:5030", "secret", 5000, 10, fetcher);
    expect((await adapter.browse("alice", "Music\\Album", false)).map(f => f.path))
      .toEqual(["Music/Album/01 Track.flac", "Music/Album/02 Track.mp3"]);
    expect((await adapter.browse("alice", "Music\\Album", true)).map(f => f.path))
      .toEqual(["Music/Album/01 Track.flac", "Music/Album/02 Track.mp3", "Music/Album/Disc 2/05 Nested.flac"]);
  });

  it("falls back to a bounded full-share browse when a peer returns an empty targeted folder", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith("/directory") ?
      json([{ name: "Music\\Album", files: [] }]) :
      json([{ name: "Music\\Album", files: [{ filename: "Song.flac", size: 100 }] },
        { name: "Music\\Sibling", files: [{ filename: "Other.flac", size: 200 }] }]));
    const adapter = new SlskdAdapter("http://slskd:5030", "secret", 5000, 10, fetcher);
    expect((await adapter.browse("alice", "Music\\Album", false)).map(file => file.path))
      .toEqual(["Music\\Album\\Song.flac"]);
    expect(fetcher.mock.calls.map(call => String(call[0]))).toEqual([
      "http://slskd:5030/api/v0/users/alice/directory",
      "http://slskd:5030/api/v0/users/alice/browse"
    ]);
  });

  it("does not reject the selected folder because a sibling contains an invalid file", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetcher = vi.fn(async () => json([
      { name: "Music\\Sibling", files: null },
      { name: "Music\\Other", files: [{ filename: "bad.jpg", size: -1 }] },
      { name: "Music\\Album", files: [{ filename: "Song.flac", size: 100 }] }
    ]));
    try {
      const adapter = new SlskdAdapter("http://slskd:5030", "secret", 5000, 10, fetcher);
      expect((await adapter.browse("alice", "Music\\Album", false)).map(item => item.path))
        .toEqual(["Music\\Album\\Song.flac"]);
      expect(fetcher).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith("slskd POST directory ignored 1 malformed entries outside the selected folder");
    } finally { warn.mockRestore(); }
  });

  it("uses a full-share browse if the targeted directory response has an invalid selected file", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith("/directory") ?
      json([{ name: "Music\\Album", files: [{ filename: "Music\\Album\\bad.mp3", size: -1 }] }]) :
      json([{ name: "Music\\Album", files: [{ filename: "Song.flac", size: 100 }] }]));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const adapter = new SlskdAdapter("http://slskd:5030", "secret", 5000, 10, fetcher);
      expect((await adapter.browse("alice", "Music\\Album", false)).map(item => item.path))
        .toEqual(["Music\\Album\\Song.flac"]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("directories.0.files.0.size"));
      expect(fetcher.mock.calls.map(call => String(call[0]))).toEqual([
        "http://slskd:5030/api/v0/users/alice/directory",
        "http://slskd:5030/api/v0/users/alice/browse"
      ]);
    } finally { warn.mockRestore(); }
  });

  it("reports the invalid field if both targeted and full-share responses are unusable", async () => {
    const invalid = [{ name: "Music\\Album", files: [{ filename: "Music\\Album\\bad.mp3", size: -1 }] }];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const adapter = new SlskdAdapter("http://slskd:5030", "secret", 5000, 10, vi.fn(async () => json(invalid)));
      await expect(adapter.browse("alice", "Music\\Album", false))
        .rejects.toThrow("GET browse returned unexpected response shape at directories.0.files.0.size");
    } finally { warn.mockRestore(); }
  });

  it("accepts slskd's full-share browse object when the targeted response is malformed", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith("/directory") ?
      json({ name: "Music\\Album", files: [file("Music\\Album\\Song.flac")] }) :
      json({ directories: [{ name: "Music\\Album", files: [{ filename: "Song.flac", size: 100 }] }],
        lockedDirectories: [{ name: "Music\\Private", files: [file("Music\\Private\\Hidden.flac")] }] }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const adapter = new SlskdAdapter("http://slskd:5030", "secret", 5000, 10, fetcher);
      expect((await adapter.browse("alice", "Music\\Album", false)).map(item => item.path))
        .toEqual(["Music\\Album\\Song.flac"]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("root"));
    } finally { warn.mockRestore(); }
  });

  it("inspects a folder late in a full-share browse with string-valued audio attribute types", async () => {
    const directories = Array.from({ length: 723 }, (_, index) => ({
      name: `Music\\Unrelated-${index}`,
      files: [{ filename: `Other-${index}.mp3`, size: 100, attributes: [{ type: "unknown", value: 320 }] }]
    }));
    directories.push({
      name: "Music\\Album",
      files: [{ filename: "Track.mp3", size: 3828401,
        attributes: [{ type: "BitRate", value: 320 }, { type: "VariableBitRate", value: 0 }] }]
    });
    const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith("/directory") ?
      json({ name: "Music\\Album", files: [] }) : json({ directories, lockedDirectories: [] }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const adapter = new SlskdAdapter("http://slskd:5030", "secret", 5000, 10, fetcher);
      expect(await adapter.browse("alice", "Music\\Album", false)).toMatchObject([
        { path: "Music\\Album\\Track.mp3", metadata: { bitrate: 320, vbr: false } }
      ]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("POST directory returned unexpected response shape"));
    } finally { warn.mockRestore(); }
  });

  it("still reports an unknown attribute type in the selected folder", async () => {
    const invalid = [{ name: "Music\\Album", files: [{
      filename: "Track.mp3", size: 100, attributes: [{ type: "NotAnAudioAttribute", value: 320 }]
    }] }];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const adapter = new SlskdAdapter("http://slskd:5030", "secret", 5000, 10,
        vi.fn(async () => json(invalid)));
      await expect(adapter.browse("alice", "Music\\Album", false))
        .rejects.toThrow("GET browse returned unexpected response shape at directories.0.files.0.attributes.0.type");
    } finally { warn.mockRestore(); }
  });

  it("rejects a full-share object without a directory list instead of treating it as an empty folder", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith("/directory") ?
      json([]) : json({ error: "No share available" }));
    const adapter = new SlskdAdapter("http://slskd:5030", "secret", 5000, 10, fetcher);
    await expect(adapter.browse("alice", "Music\\Album", false))
      .rejects.toThrow("GET browse returned unexpected response shape at directories");
  });

  it("reports a directory response with files that do not match the selected folder", async () => {
    const adapter = new SlskdAdapter("http://slskd:5030", "secret", 5000, 10,
      vi.fn(async () => json([{ name: "Music/Sibling", files: [{ filename: "song.flac", size: 100 }] }])));
    await expect(adapter.browse("alice", "Music/Album", false)).rejects.toThrow("none had paths within the selected folder");
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

  it("does not treat an authenticated but disconnected Soulseek client as search-ready", async () => {
    const adapter = new SlskdAdapter("http://slskd:5030", "secret", 5000, 10,
      vi.fn(async (input: RequestInfo | URL) => String(input).endsWith("/session") ?
        new Response(null, { status: 200 }) : json({ isConnected: false, isLoggedIn: false, state: "Disconnected" })));
    await expect(adapter.check()).rejects.toThrow("Soulseek is disconnected and not logged in");
  });

  it("does not treat an empty responses endpoint as zero results when slskd reports files", async () => {
    const adapter = new SlskdAdapter("http://slskd:5030", "secret", 5000, 10,
      vi.fn(async (input: RequestInfo | URL) => String(input).endsWith("/responses") ? json([]) :
        json({ id: "search-id", state: "Completed", endedAt: "2026-10-13T08:00:00Z", fileCount: 12, responseCount: 2 })));
    await expect(adapter.getSearch("search-id")).rejects.toThrow("reports 12 search files");
  });

  it("stops searches on request and reads partial files and peer speed after cancellation", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        expect(JSON.parse(String(init.body)).searchTimeout).toBe(5000);
        return json({ id: "search-id", state: "InProgress", fileCount: 0, responseCount: 0 });
      }
      if (init?.method === "PUT") return new Response(null, { status: 200 });
      if (String(input).endsWith("/responses")) return json([
        { username: "alice", uploadSpeed: 4096, queueLength: 2, hasFreeUploadSlot: true,
          files: [file("Burial\\Untrue\\01 Archangel.mp3")] }
      ]);
      return json({ id: "search-id", state: "Completed, Cancelled", endedAt: "2026-10-13T08:00:00Z", fileCount: 1, responseCount: 1 });
    });
    const adapter = new SlskdAdapter("http://slskd:5030", "secret", 45000, 120, fetcher);
    expect(await adapter.startSearch("burial archangel", 5000)).toBe("search-id");
    await adapter.stopSearch("search-id");
    expect(fetcher.mock.calls[1]?.[1]?.method).toBe("PUT");
    expect(await adapter.getSearch("search-id")).toMatchObject({ finished: true, state: "Completed, Cancelled",
      results: [{ upload_speed: 4096, queue_length: 2, free_slot: true }] });
  });

  it("waits for slskd to persist early-stopped files before treating cancellation as final", async () => {
    const fetcher = vi.fn(async () => json({
      id: "search-id", state: "Completed, Cancelled", endedAt: null, fileCount: 1, responseCount: 1
    }));
    const adapter = new SlskdAdapter("http://slskd:5030", "secret", 5000, 10, fetcher);
    expect(await adapter.getSearch("search-id")).toMatchObject({ finished: false, results: [] });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("preserves errored search state without fetching potentially absent responses", async () => {
    const fetcher = vi.fn(async () => json({
      id: "search-id", state: "Completed, Errored", endedAt: "2026-10-13T08:00:00Z", fileCount: 0, responseCount: 0
    }));
    const adapter = new SlskdAdapter("http://slskd:5030", "secret", 5000, 10, fetcher);
    expect(await adapter.getSearch("search-id")).toMatchObject({ finished: true, state: "Completed, Errored", results: [] });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
