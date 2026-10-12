import type { Candidate, FolderPreview, RequestStatus, RequestType } from "../shared/types";

export const AUTO_FOLDER_PREVIEW_LIMIT = 5;

export const folderKey = (requestId: string, username: string, directory: string, recursive: boolean): string =>
  JSON.stringify([requestId, username, directory, recursive]);

interface PreviewRequest {
  id: string;
  type: RequestType;
  status: RequestStatus;
  jobs: readonly unknown[];
  previews: readonly Pick<FolderPreview, "username" | "directory" | "recursive">[];
  candidates: readonly Pick<Candidate, "id" | "username" | "directory" | "score">[];
}

export function autoFolderPreviews(requests: readonly PreviewRequest[], attempted: ReadonlySet<string>): Array<{
  key: string; requestId: string; candidateId: string;
}> {
  const known = new Set(requests.flatMap(request => request.previews.filter(preview => !preview.recursive)
    .map(preview => folderKey(request.id, preview.username, preview.directory, false))));
  const groups = new Map<string, { requestId: string; candidateId: string; score: number }>();
  for (const request of requests) {
    if (request.type !== "album_folder" || !["review", "no_results"].includes(request.status) || request.jobs.length) continue;
    for (const candidate of request.candidates) {
      const key = folderKey(request.id, candidate.username, candidate.directory, false);
      if (!groups.has(key) && !known.has(key) && !attempted.has(key))
        groups.set(key, { requestId: request.id, candidateId: candidate.id, score: candidate.score });
    }
  }
  return [...groups].sort((a, b) => b[1].score - a[1].score)
    .slice(0, Math.max(0, AUTO_FOLDER_PREVIEW_LIMIT - attempted.size))
    .map(([key, item]) => ({ key, requestId: item.requestId, candidateId: item.candidateId }));
}
