import { describe, expect, it } from "vitest";
import { mergeAudioMetadata, normalize, parseLines, parentDirectory, qualityCheck, rankFile, rankFolder, withinDirectory, unknownMetadata } from "./matching";
import type { RemoteFile } from "../shared/types";

const file = (path: string, bitrate: number | null = null, vbr: boolean | null = null): RemoteFile =>
  ({ username: "peer", path, directory: parentDirectory(path), size: 100, metadata: { ...unknownMetadata(), bitrate, vbr } });

describe("request parsing and matching", () => {
  it("retains complete search lines, supports no-dash input and flags normalized duplicates", () => {
    const rows = parseLines("Burial - Archangel\nBURIAL archangel\nNot parsed\n!!!", "album_folder", "flac");
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({ original: "Burial - Archangel", queryText: "Burial - Archangel",
      type: "album_folder", quality: "flac", seedKind: "track_seed" });
    expect(rows[1]?.duplicate).toBe(true);
    expect(rows[2]).toMatchObject({ original: "Not parsed", queryText: "Not parsed" });
    expect(rows[2]?.error).toBeUndefined();
    expect(rows[3]?.error).toBe("Enter searchable text, not only punctuation.");
    expect(normalize("Búrial")).toBe("burial");
    expect(parseLines("ben klock subzero")[0]).toMatchObject({
      queryText: "ben klock subzero", type: "search", seedKind: "track_seed"
    });
  });

  it("rejects unknown or variable bitrate and never trusts filenames", () => {
    expect(qualityCheck(file("album\\song 320.mp3"), "mp3_320").eligible).toBe(false);
    expect(qualityCheck(file("album\\song.mp3", 320, null), "mp3_320").eligible).toBe(false);
    expect(qualityCheck(file("album\\song.mp3", 320, true), "mp3_320").eligible).toBe(false);
    expect(qualityCheck(file("album\\song.mp3", 256, false), "mp3_320").eligible).toBe(false);
    expect(qualityCheck(file("album\\song.mp3", 320, false), "mp3_320").eligible).toBe(true);
    expect(qualityCheck(file("album\\song.flac", 320, false), "mp3_320").eligible).toBe(false);
    expect(qualityCheck(file("album\\song.mp3", 320, false), "flac").eligible).toBe(false);
    expect(qualityCheck(file("album\\song.flac"), "flac").eligible).toBe(true);
    expect(qualityCheck(file("album\\cover.jpg"), "any").eligible).toBe(false);
    expect(qualityCheck({ ...file("album\\song.flac"), size: 0 }, "flac").eligible).toBe(false);
  });

  it("uses matching search metadata when browsing omits it, but rejects conflicting reports", () => {
    const searched = { ...unknownMetadata(), bitrate: 320, vbr: false, sampleRate: 44100 };
    const merged = mergeAudioMetadata(unknownMetadata(), searched);
    expect(merged).toEqual(searched);
    expect(qualityCheck({ ...file("album\\song.mp3"), metadata: merged }, "mp3_320").eligible).toBe(true);
    const conflicting = mergeAudioMetadata({ ...unknownMetadata(), bitrate: 192, vbr: true }, searched);
    expect(conflicting).toMatchObject({ bitrate: null, vbr: null, sampleRate: 44100 });
    expect(qualityCheck({ ...file("album\\song.mp3"), metadata: conflicting }, "mp3_320").eligible).toBe(false);
  });

  it("ranks text relevance ahead of unrelated 320 kbps matches", () => {
    const request = { query_text: "Burial Archangel" };
    expect(rankFile(request, file("Burial\\Untrue\\01 - Archangel.mp3")).score)
      .toBeGreaterThan(rankFile(request, file("Other Artist\\Album\\Unrelated 320.mp3", 320, false)).score);
    expect(rankFolder({ query_text: "Burial Untrue", seed_kind: "album_title" },
      "Burial\\Untrue", Array.from({ length: 8 }, () => file("Burial\\Untrue\\song.flac")), 0.85).score).toBe(1);
  });

  it("does not cross directory boundaries without explicit recursion", () => {
    expect(parentDirectory("Song.flac")).toBe("");
    expect(parentDirectory("Album\\Song.flac")).toBe("Album");
    expect(withinDirectory("peer\\Album\\one.flac", "peer\\Album", false)).toBe(true);
    expect(withinDirectory("peer\\Album\\Disc 2\\two.flac", "peer\\Album", false)).toBe(false);
    expect(withinDirectory("peer\\Album\\Disc 2\\two.flac", "peer\\Album", true)).toBe(true);
    expect(withinDirectory("peer/Album/Disc 2/two.flac", "peer\\Album", true)).toBe(true);
    expect(withinDirectory("peer/Album/two.flac", "peer\\Album", false)).toBe(true);
    expect(withinDirectory("peer\\Album 2\\two.flac", "peer\\Album", true)).toBe(false);
    expect(withinDirectory("peer\\Album\\..\\Sibling\\two.flac", "peer\\Album", true)).toBe(false);
    expect(withinDirectory("peer\\Album\\Disc 2\\..\\two.flac", "peer\\Album", true)).toBe(false);
  });
});
