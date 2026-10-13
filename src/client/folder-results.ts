import type { Candidate, FolderPreview, RequestStatus, RequestType } from "../shared/types";

export const AUTO_FOLDER_PREVIEW_LIMIT = 5;

export const folderKey = (requestId: string, username: string, directory: string, recursive: boolean): string =>
  JSON.stringify([requestId, username, directory, recursive]);

export function searchHitQueueReason(request: { type: RequestType; status: RequestStatus; transfers: readonly unknown[] },
  candidate: Pick<Candidate, "eligible" | "reason">): string | null {
  if (!candidate.eligible) return candidate.reason;
  if (request.type !== "search") return "Inspect to download";
  if (request.transfers.length) return "Already queued; search again";
  if (request.status !== "review") return "Search not ready";
  return null;
}

interface PreviewRequest {
  id: string;
  type: RequestType;
  status: RequestStatus;
  jobs: readonly unknown[];
  previews: readonly Pick<FolderPreview, "username" | "directory" | "recursive">[];
  candidates: readonly Pick<Candidate, "id" | "username" | "directory" | "score" | "eligible">[];
}

export function autoFolderPreviews(requests: readonly PreviewRequest[], attempted: ReadonlySet<string>): Array<{
  key: string; requestId: string; candidateId: string;
}> {
  const known = new Set(requests.flatMap(request => request.previews.filter(preview => !preview.recursive)
    .map(preview => folderKey(request.id, preview.username, preview.directory, false))));
  const groups = new Map<string, { requestId: string; candidateId: string; score: number; eligible: boolean }>();
  for (const request of requests) {
    if (!["album_folder", "search"].includes(request.type) ||
      !["review", "no_results"].includes(request.status) || request.jobs.length) continue;
    for (const candidate of request.candidates) {
      if (!candidate.directory) continue;
      const key = folderKey(request.id, candidate.username, candidate.directory, false);
      if (known.has(key) || attempted.has(key)) continue;
      const existing = groups.get(key);
      if (!existing) groups.set(key, { requestId: request.id, candidateId: candidate.id,
        score: candidate.score, eligible: candidate.eligible });
      else if (candidate.eligible) existing.eligible = true;
    }
  }
  return [...groups].sort((a, b) => Number(b[1].eligible) - Number(a[1].eligible) || b[1].score - a[1].score)
    .slice(0, Math.max(0, AUTO_FOLDER_PREVIEW_LIMIT - attempted.size))
    .map(([key, item]) => ({ key, requestId: item.requestId, candidateId: item.candidateId }));
}
