import type { DownloadItem } from "../shared/types";
import { parentDirectory } from "../server/matching";

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

export function groupDownloadPeers(items: DownloadItem[]): Array<{
  username: string; files: DownloadItem[];
  folders: Array<{ directory: string; files: DownloadItem[] }>;
}> {
  const peers = new Map<string, { files: DownloadItem[]; folders: Map<string, DownloadItem[]> }>();
  for (const item of items) {
    let peer = peers.get(item.username);
    if (!peer) {
      peer = { files: [], folders: new Map() };
      peers.set(item.username, peer);
    }
    peer.files.push(item);
    const directory = parentDirectory(item.path);
    const files = peer.folders.get(directory) ?? [];
    files.push(item);
    peer.folders.set(directory, files);
  }
  return [...peers].map(([username, peer]) => ({
    username, files: peer.files,
    folders: [...peer.folders].map(([directory, files]) => ({ directory, files }))
  }));
}
