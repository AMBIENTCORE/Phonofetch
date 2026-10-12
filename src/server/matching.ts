import type { AudioMetadata, MusicRequest, Quality, RemoteFile, RequestType, SeedKind } from "../shared/types";

export function normalize(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}

export interface ParsedLine {
  original: string;
  queryText: string;
  type: RequestType;
  seedKind: SeedKind;
  quality: Quality;
  error?: string;
  duplicate?: boolean;
}

export function parseLines(input: string, type: RequestType = "track", quality: Quality = "mp3_320"): ParsedLine[] {
  const seen = new Set<string>();
  return input.split(/\r?\n/).filter(line => line.trim()).map(line => {
    const queryText = line.trim();
    const result: ParsedLine = { original: line.slice(0, 256), queryText, type, seedKind: "track_seed", quality };
    if (line.length > 256) result.error = "A search line must be 256 characters or fewer.";
    else if (!normalize(queryText)) result.error = "Enter searchable text, not only punctuation.";
    else {
      const key = `${normalize(queryText)}|${type}|${result.seedKind}`;
      result.duplicate = seen.has(key);
      seen.add(key);
    }
    return result;
  });
}

export function parentDirectory(path: string): string {
  return path.slice(0, Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/")));
}

export function fileName(path: string): string {
  return path.slice(Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/")) + 1);
}

export function withinDirectory(path: string, directory: string, recursive: boolean): boolean {
  const selected = directory.replace(/\\/g, "/").replace(/\/+$/, "");
  const filename = path.replace(/\\/g, "/");
  if (!selected || selected.split("/").some(part => part === "." || part === "..") ||
    !filename.startsWith(`${selected}/`)) return false;
  const name = filename.slice(selected.length + 1);
  return Boolean(name) && !name.split(/[\\/]/).some(part => !part || part === "." || part === "..") &&
    (recursive || !/[\\/]/.test(name));
}

export function qualityCheck(file: Pick<RemoteFile, "path" | "metadata" | "size">, quality: Quality): { eligible: boolean; reason: string } {
  if (!Number.isSafeInteger(file.size) || file.size <= 0) return { eligible: false, reason: "File size is missing or invalid" };
  const extension = /\.([^.\\/]+)$/.exec(file.path)?.[1]?.toLowerCase() ?? "";
  const supported = ["mp3", "flac", "m4a", "ogg", "opus", "wav", "aac"];
  if (!supported.includes(extension)) return { eligible: false, reason: "Not a supported audio file" };
  if (quality === "flac")
    return extension === "flac" ? { eligible: true, reason: "FLAC extension (source provenance unverified)" }
      : { eligible: false, reason: "FLAC required" };
  if (quality === "any") return { eligible: true, reason: "Any quality explicitly selected" };
  if (extension !== "mp3") return { eligible: false, reason: "MP3 required" };
  if (file.metadata.bitrate !== 320) return {
    eligible: false, reason: file.metadata.bitrate === null ? "Bitrate metadata missing or ambiguous" : `Bitrate is ${file.metadata.bitrate} kbps, not 320 kbps`
  };
  if (file.metadata.vbr !== false) return { eligible: false,
    reason: file.metadata.vbr === true ? "Variable bitrate does not establish strict 320 kbps" : "Constant bitrate cannot be verified" };
  return { eligible: true, reason: "Metadata reports 320 kbps constant bitrate" };
}

function similarity(target: string, actual: string): number {
  const a = normalize(target).split(" ").filter(Boolean);
  const b = normalize(actual).split(" ").filter(Boolean);
  if (!a.length || !b.length) return 0;
  if (normalize(target) === normalize(actual)) return 1;
  const matches = a.filter(token => b.includes(token)).length;
  return 2 * matches / (a.length + b.length);
}

function coverage(target: string, text: string): number {
  const expected = new Set(normalize(target).split(" ").filter(Boolean));
  const actual = new Set(normalize(text).split(" ").filter(Boolean));
  return expected.size ? [...expected].filter(word => actual.has(word)).length / expected.size : 0;
}

export function rankFile(request: Pick<MusicRequest, "query_text">, file: RemoteFile): { score: number; explanation: string } {
  const stem = fileName(file.path).replace(/\.[^.]+$/, "").replace(/^\d{1,3}[ ._-]+/, "");
  const filename = similarity(request.query_text, stem);
  const path = coverage(request.query_text, `${file.directory}\\${stem}`);
  const score = Math.max(filename, 0.85 * path + 0.15 * filename);
  return { score: Math.round(score * 1000) / 1000,
    explanation: `Text in filename ${Math.round(filename * 100)}%, query words in path ${Math.round(path * 100)}%` };
}

export function rankFolder(request: Pick<MusicRequest, "query_text" | "seed_kind">,
  directory: string, files: RemoteFile[], seedScore: number): { score: number; explanation: string } {
  const directoryCoverage = coverage(request.query_text, directory);
  const folderCoverage = coverage(fileName(directory), request.query_text);
  const evidence = request.seed_kind === "album_title" ? directoryCoverage : Math.max(directoryCoverage, seedScore);
  const score = Math.min(1, Math.round((0.65 * evidence + 0.2 * folderCoverage + 0.15 * Math.min(1, files.length / 8)) * 1000) / 1000);
  return { score, explanation: `${files.length} files inspected; query words in directory ${Math.round(directoryCoverage * 100)}%, folder words in query ${Math.round(folderCoverage * 100)}%, seed ${Math.round(seedScore * 100)}%` };
}

export const unknownMetadata = (): AudioMetadata => ({ bitrate: null, sampleRate: null, bitDepth: null, vbr: null });
