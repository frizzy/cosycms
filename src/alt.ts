// Alt text that does no work for someone who can't see the image: empty, a file name, or a placeholder word.
const GENERIC = new Set(["image", "img", "photo", "picture", "pic", "untitled", "screenshot", "banner", "graphic"]);
const norm = (s: string) => s.toLowerCase().replace(/\.(png|jpe?g|gif|webp|avif)$/, "").replace(/[\s_-]+/g, " ").trim();

/** Why this alt text is weak, or undefined when it looks fine. shortcut: a heuristic, English only; it can't tell whether the text describes the picture. */
export function weakAlt(alt: string, fileName = "", slug = ""): string | undefined {
  const t = alt.trim();
  if (!t) return "Missing";
  if (/\.(png|jpe?g|gif|webp|avif)$/i.test(t)) return "Looks like a file name";
  if (t.length < 5) return "Very short";
  const n = norm(t);
  if (GENERIC.has(n) || /^(img|dsc|image|photo|screenshot)[ _-]?\d+$/i.test(n)) return "A placeholder, not a description";
  if (n === norm(fileName) || n === norm(slug)) return "Same as the file name";
  return undefined;
}
