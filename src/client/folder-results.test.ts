import { describe, expect, it } from "vitest";
import type { RequestStatus } from "../shared/types";
import { AUTO_FOLDER_PREVIEW_LIMIT, autoFolderPreviews, folderKey } from "./folder-results";

const request = (status: RequestStatus = "review") => ({
  id: "request-1", type: "album_folder" as const, status,
  jobs: [], previews: [],
  candidates: Array.from({ length: 8 }, (_, index) => ({
    id: `candidate-${index}`, username: `peer-${index}`, directory: `Music\\Album-${index}`,
    score: 1 - index / 10, eligible: true
  }))
});

describe("bounded folder inspection", () => {
  it("inspects at most five top-ranked distinct folders per batch", () => {
    const item = request();
    item.candidates.push({ ...item.candidates[0]!, id: "duplicate-search-hit" });
    const picked = autoFolderPreviews([item], new Set());
    expect(picked).toHaveLength(AUTO_FOLDER_PREVIEW_LIMIT);
    expect(picked.map(candidate => candidate.candidateId)).toEqual([
      "candidate-0", "candidate-1", "candidate-2", "candidate-3", "candidate-4"
    ]);
  });

  it("skips already inspected or attempted folders, other request types and completed jobs", () => {
    const item = request();
    const attempted = new Set([folderKey(item.id, "peer-1", "Music\\Album-1", false)]);
    const inspected = { ...item, previews: [
      { username: "peer-0", directory: "Music\\Album-0", recursive: false }
    ] };
    const picked = autoFolderPreviews([inspected, { ...request(), id: "track", type: "track" },
      { ...request(), id: "job", jobs: [{}] }, { ...request("active"), id: "active" }], attempted);
    expect(picked.map(candidate => candidate.candidateId)).toEqual([
      "candidate-2", "candidate-3", "candidate-4", "candidate-5"
    ]);
    expect(autoFolderPreviews([item], new Set(Array.from({ length: 5 }, (_, index) =>
      folderKey(item.id, `peer-${index}`, `Music\\Album-${index}`, false))))).toHaveLength(0);
  });

  it("inspects quality-eligible search-hit folders ahead of format-excluded folders", () => {
    const item = request();
    item.candidates[0]!.eligible = false;
    item.candidates[1]!.eligible = false;
    expect(autoFolderPreviews([item], new Set()).map(folder => folder.candidateId))
      .toEqual(["candidate-2", "candidate-3", "candidate-4", "candidate-5", "candidate-6"]);
  });

  it("inspects folders discovered by an untyped manual search", () => {
    const item = { ...request(), type: "search" as const };
    expect(autoFolderPreviews([item], new Set()).map(folder => folder.candidateId))
      .toEqual(["candidate-0", "candidate-1", "candidate-2", "candidate-3", "candidate-4"]);
  });

  it("leaves root-level search hits available as files without attempting an empty-directory browse", () => {
    const item = { ...request(), type: "search" as const };
    item.candidates[0]!.directory = "";
    expect(autoFolderPreviews([item], new Set()).map(folder => folder.candidateId))
      .toEqual(["candidate-1", "candidate-2", "candidate-3", "candidate-4", "candidate-5"]);
  });
});
