import { describe, expect, it } from "vitest";
import type { Candidate, FolderPreview, RequestStatus } from "../shared/types";
import { isFolderPreviewExpired } from "../shared/search-selection";
import { AUTO_FOLDER_PREVIEW_LIMIT, autoFolderPreviews, folderKey, searchHitSelectionReason, searchHitsOutsidePreview } from "./folder-results";

const request = (status: RequestStatus = "review") => ({
  id: "request-1", type: "album_folder" as const, status,
  jobs: [], previews: [],
  candidates: Array.from({ length: 8 }, (_, index) => ({
    id: `candidate-${index}`, username: `peer-${index}`, directory: `Music\\Album-${index}`,
    score: 1 - index / 10, eligible: true
  }))
});

describe("bounded folder inspection", () => {
  it("treats previews as current through ten minutes, then expires them", () => {
    const now = Date.parse("2026-10-15T12:49:23.000Z");
    const createdAt = new Date(now - 10 * 60 * 1000).toISOString();
    expect(isFolderPreviewExpired(createdAt, now)).toBe(false);
    expect(isFolderPreviewExpired(createdAt, now + 1)).toBe(true);
    expect(isFolderPreviewExpired("not-a-timestamp", now)).toBe(true);
  });

  it("inspects at most five top-ranked distinct folders per batch", () => {
    const item = request();
    item.candidates.push({ ...item.candidates[0]!, id: "duplicate-search-hit" });
    const picked = autoFolderPreviews([item], new Set());
    expect(picked).toHaveLength(AUTO_FOLDER_PREVIEW_LIMIT);
    expect(picked.map(candidate => candidate.candidateId)).toEqual([
      "candidate-0", "candidate-1", "candidate-2", "candidate-3", "candidate-4"
    ]);
  });

  describe("search-hit queue availability", () => {
    const hit = { username: "peer", path: "Music\\Album\\Track.flac",
      eligible: true, reason: "Any quality explicitly selected" };

    it("keeps search-hit selection available when folder inspection fails or is busy", () => {
      const search = { type: "search" as const, mode: "review" as const,
        status: "review" as const, transfers: [] };
      expect(searchHitSelectionReason(search, hit)).toBeNull();
      expect(searchHitSelectionReason({ ...search, type: "album_folder" }, hit)).toBeNull();
      expect(searchHitSelectionReason(search, { ...hit, eligible: false, reason: "Not a supported audio file" }))
        .toBe("Not a supported audio file");
    });

    it("keeps non-audio hits absent from an older audio-only preview visible for selection", () => {
      const hit = (id: string, path: string): Candidate => ({
        id, request_id: "request-1", username: "peer", path, directory: "Music\\Album",
        size: 100, metadata: { bitrate: null, sampleRate: null, bitDepth: null, vbr: null },
        eligible: true, reason: "Available for manual download", score: 0.9, explanation: "",
        selected: false
      });
      const audio = hit("audio", "Music\\Album\\Track.mp3");
      const cover = hit("cover", "Music\\Album\\cover.jpg");
      const preview: FolderPreview = {
        id: "preview", request_id: "request-1", username: "peer", directory: "Music\\Album",
        recursive: false, files: [{ ...audio, path: "Music/Album/Track.mp3" }],
        created_at: new Date().toISOString(), eligible_count: 1, excluded_count: 0,
        audio_bytes: 100, eligible_bytes: 100
      };
      expect(searchHitsOutsidePreview([audio, cover], preview, new Set()).map(item => item.id)).toEqual(["cover"]);
      expect(searchHitsOutsidePreview([audio, cover], preview, new Set(["audio"])).map(item => item.id))
        .toEqual(["audio", "cover"]);
    });

    it("explains why a saved result cannot be selected for download", () => {
      expect(searchHitSelectionReason({ type: "track", mode: "review", status: "review", transfers: [] }, hit))
        .toBe("Select one track");
      expect(searchHitSelectionReason({ type: "search", mode: "review", status: "queueing",
        transfers: [{ username: "peer", path: "Music\\Album\\Track.flac" }] }, hit))
        .toBe("Already queued");
      expect(searchHitSelectionReason({ type: "search", mode: "automatic", status: "no_results", transfers: [] }, hit))
        .toBe("Search not ready");
    });

    it("marks only the queued file, not the other albums in a manual search", () => {
      const first = { ...hit, username: "peer", path: "Music\\Album A\\Track.flac" };
      const other = { ...hit, username: "peer", path: "Music\\Album B\\Track.flac" };
      const request = { type: "search" as const, mode: "review" as const, status: "active" as const,
        transfers: [{ username: "peer", path: "Music/Album A/Track.flac" }] };
      expect(searchHitSelectionReason(request, first)).toBe("Already queued");
      expect(searchHitSelectionReason(request, other)).toBeNull();
      expect(searchHitSelectionReason({ ...request, status: "completed" }, other)).toBeNull();
    });
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
