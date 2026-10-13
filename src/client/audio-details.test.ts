import { describe, expect, it } from "vitest";
import { audioDetails, fileFormat } from "./audio-details";

describe("peer-reported audio details", () => {
  it("does not describe missing FLAC bitrate as unknown VBR", () => {
    const metadata = { bitrate: null, sampleRate: null, bitDepth: null, vbr: null };
    expect(audioDetails(metadata, "Album\\01 - Song.flac")).toBe("FLAC");
    expect(audioDetails({ ...metadata, sampleRate: 44100, bitDepth: 16 }, "Album\\02 - Song.flac"))
      .toBe("FLAC · 44100 Hz · 16-bit");
    expect(audioDetails({ ...metadata, bitrate: 1200, vbr: true }, "Album\\03 - Song.FLAC"))
      .toContain("1200 kbps (peer reported)");
  });

  it("keeps missing MP3 bitrate and VBR metadata explicit for strict filtering", () => {
    expect(audioDetails({ bitrate: 320, sampleRate: null, bitDepth: null, vbr: null }, "Song.mp3"))
      .toBe("320 kbps · VBR not reported");
    expect(audioDetails({ bitrate: null, sampleRate: null, bitDepth: null, vbr: null }, "Song.mp3"))
      .toBe("bitrate not reported · VBR not reported");
  });

  it("shows peer-reported bitrate and file type without guessing from names or size", () => {
    const missing = { bitrate: null, sampleRate: null, bitDepth: null, vbr: null };
    expect(fileFormat(missing, "Album\\320 kbps.mp3")).toBe("MP3 · ? kbps");
    expect(fileFormat({ ...missing, bitrate: 320, vbr: false }, "Album\\song.MP3")).toBe("MP3 · 320 kbps CBR");
    expect(fileFormat({ ...missing, bitrate: 192, vbr: true }, "Album/song.mp3")).toBe("MP3 · 192 kbps VBR");
    expect(fileFormat(missing, "Album/song.flac")).toBe("FLAC");
    expect(fileFormat({ ...missing, sampleRate: 96000, bitDepth: 24 }, "Album/song.flac"))
      .toBe("FLAC · 96 kHz · 24-bit");
    expect(fileFormat({ ...missing, bitrate: 256 }, "Album/song.m4a")).toBe("M4A · 256 kbps");
  });
});
