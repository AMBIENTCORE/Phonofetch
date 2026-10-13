import { z } from "zod";
import type { AudioMetadata, RemoteFile } from "../shared/types";
import { parentDirectory, withinDirectory, unknownMetadata } from "./matching";
import type { RemoteTransfer, SearchSnapshot, SlskdPort } from "./port";

const finiteSize = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const remoteFile = z.object({
  filename: z.string().min(1),
  size: finiteSize,
  bitRate: z.number().nullable().optional(),
  bitDepth: z.number().nullable().optional(),
  sampleRate: z.number().nullable().optional(),
  isVariableBitRate: z.boolean().nullable().optional(),
  attributes: z.array(z.object({ type: z.number(), value: z.number() })).optional()
});
const directory = z.object({ name: z.string().min(1), files: z.array(remoteFile) });
const search = z.object({
  id: z.string(), state: z.string(),
  fileCount: z.number().int().nonnegative(), responseCount: z.number().int().nonnegative(),
  endedAt: z.string().nullable().optional()
});
const response = z.object({
  username: z.string().min(1), files: z.array(remoteFile),
  uploadSpeed: z.number().int().nonnegative().nullable().optional(),
  queueLength: z.number().int().nonnegative().nullable().optional(),
  hasFreeUploadSlot: z.boolean().nullable().optional()
});
const transfer = z.object({
  id: z.string().min(1), batchId: z.string().nullable().optional(),
  filename: z.string().min(1), username: z.string().min(1), size: finiteSize,
  bytesTransferred: z.number().nonnegative().default(0),
  state: z.string(), removed: z.boolean().optional()
});
const userTransfers = z.array(z.object({
  username: z.string(), directories: z.array(z.object({ directory: z.string(), files: z.array(transfer) }))
}));
const batchResponse = z.object({
  batch: z.object({ transfers: z.array(z.object({ id: z.string().min(1), filename: z.string() })) }),
  failures: z.array(z.object({ filename: z.string(), message: z.string() })).default([])
});

export class SlskdError extends Error {
  constructor(readonly status: number, operation: string) {
    super(`slskd ${operation} failed (HTTP ${status})`);
  }
}

export class SlskdAdapter implements SlskdPort {
  private readonly base: string;
  constructor(baseURL: string, private readonly apiKey: string, private readonly timeoutMs: number,
    private readonly resultLimit = 120, private readonly fetcher: typeof fetch = fetch) {
    this.base = baseURL.replace(/\/$/, "");
  }

  private async call<T>(method: string, path: string, schema: z.ZodType<T>, body?: object): Promise<T> {
    const url = `${this.base}${path}`;
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method, headers: { "X-API-Key": this.apiKey, ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (error) {
      if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))
        throw new Error(`slskd ${method} timed out after ${this.timeoutMs} ms`);
      throw new Error(`slskd ${method} network error`, { cause: error });
    }
    if (!response.ok) throw new SlskdError(response.status, `${method} ${path.split("?")[0]}`);
    if (response.status === 204) return schema.parse(null);
    if (!response.body) return schema.parse(null);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > 24 * 1024 * 1024) throw new Error("slskd response exceeds 24 MiB safety limit");
        text += decoder.decode(value, { stream: true });
      }
    } finally { reader.releaseLock(); }
    text += decoder.decode();
    if (!text.trim()) return schema.parse(null);
    try { return schema.parse(JSON.parse(text) as unknown); }
    catch { throw new Error(`slskd ${method} returned unexpected response shape`); }
  }

  private meta(file: z.infer<typeof remoteFile>): AudioMetadata {
    const numeric = (value: number | null | undefined): number | null =>
      typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
    const bitrateAttribute = file.attributes?.find(attribute => attribute.type === 0);
    const reportedBitrate = numeric(file.bitRate);
    const rawBitrate = numeric(bitrateAttribute?.value);
    const bitrate = bitrateAttribute && (rawBitrate === null || reportedBitrate !== null && rawBitrate !== reportedBitrate) ?
      null : rawBitrate ?? reportedBitrate;
    const vbrAttribute = file.attributes?.find(attribute => attribute.type === 2);
    const reportedVbr = typeof file.isVariableBitRate === "boolean" ? file.isVariableBitRate : null;
    const rawVbr = vbrAttribute ? vbrAttribute.value !== 0 : null;
    const vbr = rawVbr !== null && reportedVbr !== null && rawVbr !== reportedVbr ?
      null : rawVbr ?? reportedVbr;
    return { ...unknownMetadata(), bitrate, bitDepth: numeric(file.bitDepth),
      sampleRate: numeric(file.sampleRate), vbr };
  }

  async check(): Promise<void> {
    await this.call("GET", "/api/v0/session", z.unknown());
    const server = await this.call("GET", "/api/v0/server",
      z.object({ isConnected: z.boolean(), isLoggedIn: z.boolean() }));
    if (!server.isConnected || !server.isLoggedIn)
      throw new Error(`slskd API reachable, but Soulseek is ${server.isConnected ? "connected" : "disconnected"} and ${server.isLoggedIn ? "logged in" : "not logged in"}`);
  }

  async startSearch(query: string, idleTimeoutMs = Math.max(5000, this.timeoutMs - 5000)): Promise<string> {
    const created = await this.call("POST", "/api/v0/searches", search,
      { searchText: query, fileLimit: this.resultLimit, searchTimeout: idleTimeoutMs });
    return created.id;
  }

  async stopSearch(id: string): Promise<void> {
    await this.call("PUT", `/api/v0/searches/${encodeURIComponent(id)}`, z.unknown());
  }

  async getSearch(id: string): Promise<SearchSnapshot> {
    const state = await this.call("GET", `/api/v0/searches/${encodeURIComponent(id)}`, search);
    const finished = /\bCompleted\b/i.test(state.state) && Boolean(state.endedAt);
    const snapshot = { id: state.id, state: state.state, finished,
      reportedFileCount: state.fileCount, reportedResponseCount: state.responseCount };
    if (!finished || /\bErrored\b/i.test(state.state)) return { ...snapshot, results: [] };
    const responses = await this.call("GET", `/api/v0/searches/${encodeURIComponent(id)}/responses`, z.array(response));
    const files: RemoteFile[] = [];
    for (const item of responses) for (const file of item.files) {
      if (files.length >= this.resultLimit * 10) break;
      files.push({ username: item.username, path: file.filename, directory: parentDirectory(file.filename),
        size: file.size, metadata: this.meta(file), upload_speed: item.uploadSpeed ?? null,
        queue_length: item.queueLength ?? null, free_slot: item.hasFreeUploadSlot ?? null });
    }
    if (state.fileCount > 0 && files.length === 0)
      throw new Error(`slskd reports ${state.fileCount} search files, but its responses endpoint returned none`);
    return { ...snapshot, results: files };
  }

  async browse(username: string, selectedDirectory: string, recursive: boolean): Promise<RemoteFile[]> {
    const endpoint = `/api/v0/users/${encodeURIComponent(username)}`;
    const normalizeDirectory = (path: string): string => path.replace(/\\/g, "/").replace(/\/+$/, "");
    const collect = (directories: z.infer<typeof directory>[]): { files: RemoteFile[]; returnedFiles: number } => {
      const files: RemoteFile[] = [];
      let returnedFiles = 0;
      for (const item of directories) {
        for (const file of item.files) {
          returnedFiles++;
          const sameDirectory = normalizeDirectory(item.name) === normalizeDirectory(selectedDirectory);
          const separator = item.name.includes("\\") ? "\\" : "/";
          const fullPath = withinDirectory(file.filename, selectedDirectory, recursive) ? file.filename :
            (sameDirectory || recursive) && !/[\\/]/.test(file.filename) ?
              `${item.name.replace(/[\\/]$/, "")}${separator}${file.filename}` : "";
          if (!withinDirectory(fullPath, selectedDirectory, recursive)) continue;
          files.push({ username, path: fullPath, directory: parentDirectory(fullPath),
            size: file.size, metadata: this.meta(file) });
        }
      }
      return { files, returnedFiles };
    };
    if (recursive) {
      const result = collect(await this.call("GET", `${endpoint}/browse`, z.array(directory)));
      if (result.returnedFiles && !result.files.length)
        throw new Error(`slskd returned ${result.returnedFiles} remote files, but none had paths within the selected folder`);
      return result.files;
    }
    const direct = collect(await this.call("POST", `${endpoint}/directory`, z.array(directory), { directory: selectedDirectory }));
    if (direct.files.length) return direct.files;
    const fullShare = collect(await this.call("GET", `${endpoint}/browse`, z.array(directory)));
    if (fullShare.files.length) return fullShare.files;
    if (direct.returnedFiles || fullShare.returnedFiles)
      throw new Error(`slskd returned ${direct.returnedFiles} files from the selected directory and ${fullShare.returnedFiles} from the share, but none had paths within the selected folder`);
    return [];
  }

  async enqueue(username: string, file: RemoteFile, batchId: string): Promise<string | null> {
    const result = await this.call("POST", "/api/v0/transfers/downloads/batches", batchResponse, {
      id: batchId, username, files: [{ filename: file.path, size: file.size }],
      options: { externalId: batchId }
    });
    if (result.failures.length || !result.batch.transfers.length)
      throw new Error("slskd reported a failed file enqueue; inspect its transfer list");
    return result.batch.transfers.find(item => item.filename === file.path)?.id ?? null;
  }

  async transfers(): Promise<RemoteTransfer[]> {
    const users = await this.call("GET", "/api/v0/transfers/downloads", userTransfers);
    const result: RemoteTransfer[] = [];
    for (const user of users) for (const directory of user.directories) for (const item of directory.files) {
      if (item.removed) continue;
      const status: RemoteTransfer["status"] = /Completed.*Succeeded/i.test(item.state) ? "completed" :
        /Cancelled|Canceled/i.test(item.state) ? "cancelled" :
          /Completed|Failed|TimedOut|Rejected/i.test(item.state) ? "failed" :
            /InProgress|Downloading|Initializing/i.test(item.state) ? "active" : "queued";
      result.push({ id: item.id, batchId: item.batchId ?? null, username: item.username || user.username,
        path: item.filename, size: item.size, transferred: Math.min(item.bytesTransferred, item.size), status });
    }
    return result;
  }

  async cancel(username: string, transferId: string): Promise<void> {
    await this.call("DELETE", `/api/v0/transfers/downloads/${encodeURIComponent(username)}/${encodeURIComponent(transferId)}`, z.null());
  }
}
