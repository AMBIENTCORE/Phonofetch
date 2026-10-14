import { describe, expect, it } from "vitest";
import type { DownloadItem } from "../shared/types";
import { groupDownloadPeers, groupDownloads } from "./download-groups";

const file = (id: string, batchId: string, query: string, requestId = batchId): DownloadItem => ({
  id, batch_id: batchId, batch_number: batchId === "one" ? 1 : 2,
  query_text: query, request_id: requestId, queue_id: null, slskd_id: null, folder_job_id: null,
  username: "alice", path: `album/${id}.flac`, size: 100, status: "active", transferred: 10,
  progress: 10, error: null, retries: 0, created_at: "2026-10-13T00:00:00Z",
  updated_at: "2026-10-13T00:00:01Z"
});

describe("download search groups", () => {
  it("groups non-adjacent files by search, preserving the API sort order within each group", () => {
    const first = file("1", "one", "Album");
    const second = file("2", "two", "Single");
    const third = file("3", "one", "Album");
    const groups = groupDownloads([first, second, third]);
    expect(groups.map(group => [group.batchId, group.label, group.files.map(item => item.id)]))
      .toEqual([["one", "Search #1 · Album", ["1", "3"]],
        ["two", "Search #2 · Single", ["2"]]]);
  });

  it("identifies multi-query searches for links to individual query results", () => {
    const groups = groupDownloads([file("1", "one", "Album", "query-1"),
      file("2", "one", "Single", "query-2")]);
    expect(groups[0]).toMatchObject({ label: "Search #1 · 2 queries", multipleQueries: true });
  });

  it("nests files under their peer and full folder path without changing their sorted order", () => {
    const files = [
      { ...file("3", "one", "Album"), path: "Music\\Album B\\03.flac" },
      { ...file("1", "one", "Album"), path: "Music\\Album A\\01.flac" },
      { ...file("2", "one", "Album"), path: "Music\\Album B\\02.flac" },
      { ...file("4", "one", "Album"), username: "bob", path: "Music\\Album B\\04.flac" }
    ];
    const peers = groupDownloadPeers(files);
    expect(peers.map(peer => [peer.username, peer.folders.map(folder =>
      [folder.directory, folder.files.map(item => item.id)])])).toEqual([
      ["alice", [["Music\\Album B", ["3", "2"]], ["Music\\Album A", ["1"]]]],
      ["bob", [["Music\\Album B", ["4"]]]]
    ]);
  });
});
