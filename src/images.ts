// Shared by the API (upload + validation) and the admin (picker + previews). No dependencies, so Node can run it in tests.
// shortcut: images only (no SVG: it can carry scripts). Add an `accept` option to the file field when other files are needed.
export const IMAGE_TYPES = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/avif": "avif" } as const;
export type ImageMime = keyof typeof IMAGE_TYPES;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export type FileValue = { key: string; name: string; size: number; mime: ImageMime; width?: number; height?: number };

// Keys are content-addressed ("media/<sha256>.<ext>"), so identical uploads share one object and URLs never change.
export const KEY_RE = /^media\/[0-9a-f]{64}\.(png|jpg|webp|gif|avif)$/;
export const blobKey = (hash: string, mime: ImageMime) => `media/${hash}.${IMAGE_TYPES[mime]}`;
export const blobUrl = (key: string) => `/api/blobs/${key.slice("media/".length)}`;

const at = (b: Uint8Array, o: number, t: string) => [...t].every((ch, i) => b[o + i] === ch.charCodeAt(0));

/** The real type, from the file's magic bytes. The client's content-type and file name are never trusted. */
export function sniffImage(b: Uint8Array): ImageMime | undefined {
  if (b[0] === 0x89 && at(b, 1, "PNG")) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (at(b, 0, "GIF87a") || at(b, 0, "GIF89a")) return "image/gif";
  if (at(b, 0, "RIFF") && at(b, 8, "WEBP")) return "image/webp";
  if (at(b, 4, "ftyp") && (at(b, 8, "avif") || at(b, 8, "avis"))) return "image/avif";
}

// Optimisation runs in the browser when a file is chosen (so it works hosted and local, with no server CPU).
// Options live on the image field; unset ones fall back to these defaults.
export type ImageOptions = { maxSize: number; format: "keep" | "webp" | "jpeg"; quality: number; strip: boolean };
export const IMAGE_DEFAULTS: ImageOptions = { maxSize: 2400, format: "keep", quality: 82, strip: true };
export const MAX_INPUT_BYTES = 60 * 1024 * 1024; // what the browser will try to process; the stored file is still capped at MAX_IMAGE_BYTES

export const imageOptions = (f: { maxSize?: number; format?: ImageOptions["format"]; quality?: number; stripMetadata?: boolean }): ImageOptions => ({
  maxSize: f.maxSize ?? IMAGE_DEFAULTS.maxSize, format: f.format ?? IMAGE_DEFAULTS.format,
  quality: f.quality ?? IMAGE_DEFAULTS.quality, strip: f.stripMetadata ?? IMAGE_DEFAULTS.strip,
});

/** Scales down to fit `max` on the longest side; never enlarges. max 0 means no limit. */
export function fitWithin(width: number, height: number, max: number) {
  const longest = Math.max(width, height);
  if (!max || longest <= max) return { width, height };
  return { width: Math.max(1, Math.round((width * max) / longest)), height: Math.max(1, Math.round((height * max) / longest)) };
}

/** The type to encode to, or undefined if browsers can't produce it (AVIF can't be encoded). */
export function outputType(mime: ImageMime, format: ImageOptions["format"]): ImageMime | undefined {
  if (format === "webp") return "image/webp";
  if (format === "jpeg") return "image/jpeg";
  return mime === "image/avif" ? undefined : mime;
}

/** Re-encoding through a canvas keeps only the first frame, so animated files must be left alone. `head` = first few KB. */
export function isAnimated(head: Uint8Array, mime: ImageMime) {
  if (mime === "image/gif") return true; // can't tell cheaply; treat every GIF as possibly animated
  if (mime === "image/webp") return at(head, 12, "VP8X") && (head[20] & 0x02) !== 0;
  if (mime === "image/avif") return at(head, 8, "avis");
  if (mime === "image/png") return String.fromCharCode(...head.subarray(0, 4096)).includes("acTL"); // APNG
  return false;
}
