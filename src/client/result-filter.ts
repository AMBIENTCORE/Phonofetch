import type { RemoteFile } from "../shared/types";
import { qualityCheck } from "../server/matching";

export type ResultPreset = "all" | "flac" | "mp3_320";

interface Criteria {
  include: string[];
  exclude: string[];
  minBitrate: number | null;
  bitrateMode: "cbr" | "vbr" | null;
}

export function parseResultFilter(input: string): { value: Criteria | null; error: string | null } {
  const value: Criteria = { include: [], exclude: [], minBitrate: null, bitrateMode: null };
  for (const token of input.trim().split(/\s+/).filter(Boolean)) {
    const min = /^(?:minbr|minbitrate):(\d+)$/i.exec(token);
    if (min) {
      const bitrate = Number(min[1]);
      if (!Number.isSafeInteger(bitrate) || bitrate > 10000)
        return { value: null, error: "Bitrate filter must be 0 to 10000 kbps." };
      value.minBitrate = bitrate;
    } else if (/^iscbr$|^isvbr$/i.test(token)) {
      const mode = token.toLowerCase() === "iscbr" ? "cbr" : "vbr";
      if (value.bitrateMode && value.bitrateMode !== mode)
        return { value: null, error: "Choose either iscbr or isvbr, not both." };
      value.bitrateMode = mode;
    } else if (token.includes(":") || token === "-") {
      return { value: null, error: `Unsupported filter: ${token}. Use words, -word, minbr:320 or iscbr/isvbr.` };
    } else if (token.startsWith("-")) {
      value.exclude.push(token.slice(1).toLowerCase());
    } else {
      value.include.push(token.toLowerCase());
    }
  }
  return { value, error: null };
}

export function matchesResult(file: Pick<RemoteFile, "path" | "size" | "metadata">,
  preset: ResultPreset, criteria: Criteria): boolean {
  if (preset === "flac" && !qualityCheck(file, "flac").eligible) return false;
  if (preset === "mp3_320" && (!qualityCheck(file, "any").eligible ||
    !/\.mp3$/i.test(file.path) || file.metadata.bitrate !== 320)) return false;
  const path = file.path.toLowerCase();
  if (criteria.include.some(term => !path.includes(term)) || criteria.exclude.some(term => path.includes(term))) return false;
  if (criteria.minBitrate !== null && (file.metadata.bitrate === null || file.metadata.bitrate < criteria.minBitrate))
    return false;
  if (criteria.bitrateMode === "cbr" && file.metadata.vbr !== false) return false;
  if (criteria.bitrateMode === "vbr" && file.metadata.vbr !== true) return false;
  return true;
}
