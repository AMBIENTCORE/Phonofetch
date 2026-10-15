import type { Mode, RequestStatus, RequestType } from "./types";

type SearchState = { type: RequestType; mode: Mode; status: RequestStatus };

const folderPreviewTtlMs = 10 * 60 * 1000;

export function isFolderPreviewExpired(createdAt: string, now = Date.now()): boolean {
  const created = Date.parse(createdAt);
  return !Number.isFinite(created) || now - created > folderPreviewTtlMs;
}

export function canAppendManualSearch(request: SearchState): boolean {
  return request.type === "search" && request.mode === "review" &&
    ["queueing", "active", "completed", "partial", "failed", "cancelled", "uncertain"].includes(request.status);
}

export function canQueueSearchHits(request: SearchState): boolean {
  return request.status === "review" || request.status === "no_results" && request.mode === "review" ||
    canAppendManualSearch(request);
}

export function canInspectFolder(request: SearchState): boolean {
  return ["review", "no_results"].includes(request.status) || canAppendManualSearch(request);
}

export function remoteFileKey(file: { username: string; path: string }): string {
  return JSON.stringify([file.username, file.path.replace(/\\/g, "/")]);
}
