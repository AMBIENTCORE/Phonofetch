import type { RemoteFile, TransferStatus } from "../shared/types";

export interface SearchSnapshot {
  id: string;
  state: string;
  finished: boolean;
  reportedFileCount: number;
  reportedResponseCount: number;
  results: RemoteFile[];
}

export interface RemoteTransfer {
  id: string;
  batchId: string | null;
  username: string;
  path: string;
  size: number;
  transferred: number;
  status: Exclude<TransferStatus, "ready" | "queueing" | "uncertain">;
}

export interface SlskdPort {
  check(): Promise<void>;
  startSearch(query: string, idleTimeoutMs?: number): Promise<string>;
  getSearch(id: string): Promise<SearchSnapshot>;
  stopSearch(id: string): Promise<void>;
  browse(username: string, directory: string, recursive: boolean): Promise<RemoteFile[]>;
  enqueue(username: string, file: RemoteFile, batchId: string): Promise<string | null>;
  transfers(): Promise<RemoteTransfer[]>;
  cancel(username: string, transferId: string): Promise<void>;
}
