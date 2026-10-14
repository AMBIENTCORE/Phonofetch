import type { DownloadItem } from "../shared/types";

export function groupDownloads(items: DownloadItem[]): Array<{
  batchId: string; label: string; files: DownloadItem[]; multipleQueries: boolean;
}> {
  const groups = new Map<string, DownloadItem[]>();
  for (const item of items) {
    const files = groups.get(item.batch_id) ?? [];
    files.push(item);
    groups.set(item.batch_id, files);
  }
  return [...groups].map(([batchId, files]) => {
    const queries = new Set(files.map(file => file.query_text));
    return {
      batchId, files, multipleQueries: new Set(files.map(file => file.request_id)).size > 1,
      label: `Search #${files[0]!.batch_number} · ${queries.size === 1 ?
        files[0]!.query_text : `${queries.size} queries`}`
    };
  });
}
