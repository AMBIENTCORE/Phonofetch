import { describe, expect, it } from "vitest";
import type { RemoteFile } from "../shared/types";
import { matchesResult, parseResultFilter } from "./result-filter";

const file = (path: string, bitrate: number | null, vbr: boolean | null): RemoteFile =>
  ({ path, username: "peer", directory: "Album", size: 100,
    metadata: { bitrate, vbr, sampleRate: null, bitDepth: null } });

function criteria(input = "") {
  const parsed = parseResultFilter(input);
  if (!parsed.value) throw new Error(parsed.error ?? "Could not parse result filter");
  return parsed.value;
}

describe("post-search result filters", () => {
  it("keeps missing-bitrate audio visible in All and filters MP3s by reported 320 kbps", () => {
    const mp3Unknown = file("Album\\Song 320.mp3", null, null);
    const mp3Cbr = file("Album\\Song.mp3", 320, false);
    const mp3Vbr = file("Album\\Song.mp3", 320, true);
    const mp3UnknownMode = file("Album\\Song.mp3", 320, null);
    const flac = file("Album\\Song.flac", null, null);
    expect(matchesResult(mp3Unknown, "all", criteria())).toBe(true);
    expect(matchesResult(flac, "all", criteria())).toBe(true);
    expect(matchesResult(mp3Unknown, "mp3_320", criteria())).toBe(false);
    expect(matchesResult(mp3Cbr, "mp3_320", criteria())).toBe(true);
    expect(matchesResult(mp3Vbr, "mp3_320", criteria())).toBe(true);
    expect(matchesResult(mp3UnknownMode, "mp3_320", criteria())).toBe(true);
    expect(matchesResult({ ...mp3Cbr, size: 0 }, "mp3_320", criteria())).toBe(false);
    expect(matchesResult(mp3UnknownMode, "mp3_320", criteria("iscbr"))).toBe(false);
    expect(matchesResult(flac, "flac", criteria())).toBe(true);
    expect(matchesResult(mp3Cbr, "flac", criteria())).toBe(false);
  });

  it("supports filename terms, exclusions, minimum bitrate and CBR/VBR terms", () => {
    expect(matchesResult(file("Music\\Live.flac", null, null), "all", criteria("-live"))).toBe(false);
    expect(matchesResult(file("Music\\Studio.flac", null, null), "all", criteria("studio -live"))).toBe(true);
    expect(matchesResult(file("Music\\Studio.mp3", null, null), "all", criteria("minbr:320"))).toBe(false);
    expect(matchesResult(file("Music\\Studio.mp3", 192, false), "all", criteria("minbitrate:320"))).toBe(false);
    expect(matchesResult(file("Music\\Studio.mp3", 320, false), "all", criteria("minbr:320 iscbr"))).toBe(true);
    expect(matchesResult(file("Music\\Studio.mp3", 320, null), "all", criteria("iscbr"))).toBe(false);
    expect(matchesResult(file("Music\\Studio.mp3", 320, true), "all", criteria("isvbr"))).toBe(true);
  });

  it("reports unsupported syntax instead of silently misfiltering files", () => {
    expect(parseResultFilter("minbr:abc").error).toContain("Unsupported filter");
    expect(parseResultFilter("iscbr isvbr").error).toContain("either iscbr or isvbr");
    expect(parseResultFilter("-").value).toBeNull();
    expect(parseResultFilter("minbr:999999").error).toContain("0 to 10000");
  });
});
