import type { AudioMetadata } from "../shared/types";

export function audioDetails(metadata: AudioMetadata, path: string): string {
  const properties = [
    metadata.sampleRate === null ? null : `${metadata.sampleRate} Hz`,
    metadata.bitDepth === null ? null : `${metadata.bitDepth}-bit`
  ];
  if (/\.flac$/i.test(path)) return [
    "FLAC",
    ...properties,
    metadata.bitrate === null ? null : `${metadata.bitrate} kbps (peer reported)`
  ].filter(Boolean).join(" · ");
  return [
    metadata.bitrate === null ? "bitrate not reported" : `${metadata.bitrate} kbps`,
    ...properties,
    metadata.vbr === null ? "VBR not reported" : metadata.vbr ? "VBR reported" : "CBR reported"
  ].filter(Boolean).join(" · ");
}

export function fileFormat(metadata: AudioMetadata, path: string): string {
  const extension = /\.([^.\\/]+)$/.exec(path)?.[1]?.toUpperCase() ?? "FILE";
  if (extension === "MP3") return `MP3 · ${metadata.bitrate === null ? "?" : metadata.bitrate} kbps${
    metadata.vbr === null ? "" : metadata.vbr ? " VBR" : " CBR"}`;
  if (extension === "FLAC") return [
    "FLAC",
    metadata.sampleRate === null ? null : `${metadata.sampleRate / 1000} kHz`,
    metadata.bitDepth === null ? null : `${metadata.bitDepth}-bit`,
    metadata.bitrate === null ? null : `${metadata.bitrate} kbps`
  ].filter(Boolean).join(" · ");
  return metadata.bitrate === null ? extension : `${extension} · ${metadata.bitrate} kbps`;
}
