import { fitWithin, isAnimated, outputType, sniffImage, type ImageOptions } from "../src/images";

export type Optimised = { file: File; from?: { width: number; height: number }; note?: string };

const EXT = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" } as const;

/**
 * Resizes and re-encodes in the browser according to the field's options. Anything it can't do safely
 * (animated images, AVIF, a browser without the encoder) is uploaded untouched, with a note.
 * shortcut: transparency is flattened onto white when converting to JPEG; add an alpha check if that surprises people.
 */
export async function optimise(file: File, o: ImageOptions): Promise<Optimised> {
  const head = new Uint8Array(await file.slice(0, 4096).arrayBuffer());
  const mime = sniffImage(head);
  if (!mime) return { file }; // the server explains what's wrong with it
  if (isAnimated(head, mime)) return { file, note: "Animated images are uploaded as they are." };
  const target = outputType(mime, o.format);
  if (!target) return { file, note: "AVIF images are uploaded as they are." };

  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file, { imageOrientation: "from-image" }); } // bakes in EXIF rotation before metadata is dropped
  catch { return { file, note: "This browser couldn't read the image to optimise it, so it was uploaded as is." }; }

  const { width, height } = fitWithin(bitmap.width, bitmap.height, o.maxSize);
  const resized = width !== bitmap.width;
  const from = { width: bitmap.width, height: bitmap.height };
  if (!resized && target === mime && !o.strip) { bitmap.close(); return { file }; } // nothing to change

  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  if (target === "image/jpeg") { ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, width, height); }
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, target, o.quality / 100));
  // Browsers fall back to PNG when they can't encode the requested type.
  if (!blob || blob.type !== target) return { file, note: `This browser can't convert to ${EXT[target as keyof typeof EXT]?.toUpperCase()}, so the image was uploaded as is.` };
  // A lossless re-encode that came out bigger helps nobody (JPEG still wins on privacy, so it always keeps the stripped copy).
  if (!resized && target === mime && mime === "image/png" && blob.size >= file.size) return { file };

  const name = file.name.replace(/\.[^.]*$/, "") + "." + EXT[target as keyof typeof EXT];
  return { file: new File([blob], name, { type: target }), from };
}
