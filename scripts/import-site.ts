// TEMPORARY: imports an existing Astro-style content folder (posts/pages as .mdx plus their images) into the LOCAL cosycms database.
//   node scripts/import-site.ts ../cosy2 --dry     parse and validate only; writes nothing
//   node scripts/import-site.ts ../cosy2           import (stop `pnpm dev` first: both use the same local database files)
// Writes straight into the local D1 + R2 through wrangler's platform proxy, so it needs no login. Safe to re-run: it only touches
// the three collections it creates (media, posts, pages) and replaces their entries. Delete this file when done.
import { getPlatformProxy } from "wrangler";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fromMarkdown } from "../src/markdown-import.ts";
import { CollectionCreate, dataSchema, nextFreeSlug, slugify } from "../src/fields.ts";
import { BlockDef } from "../src/blocks.ts";
import { blobKey, blobUrl, sniffImage } from "../src/images.ts";

const root = path.resolve(process.argv[2] ?? "../cosy2"), dry = process.argv.includes("--dry");
const warn: string[] = [];

// ---- collection definitions, matching the site's own schema (keystatic.shared.ts) -------------------------------------
const CATEGORIES = ["design", "holistic-home", "mindful-living", "projects-diy", "sustainability"];
const defs = [
  { key: "media", label: "Media", slugSource: "alt", titleField: "alt", thumbField: "image", format: null, folder: null, bodyField: null, fields: [
    { key: "image", label: "Image", type: "file", required: true, folder: "src/assets/library", keepName: true },
    { key: "alt", label: "Alt text", type: "text", required: true },
    { key: "link", label: "Credit link", type: "url" },
  ] },
  { key: "posts", label: "Posts", slugSource: "title", titleField: "title", thumbField: "cover", format: "mdx", folder: "src/content/posts", bodyField: "content", fields: [
    { key: "title", label: "Title", type: "text", required: true },
    { key: "description", label: "Description (SEO + card excerpt)", type: "textarea" },
    { key: "pubDate", label: "Published", type: "datetime", autoSet: "create" },
    { key: "updatedDate", label: "Updated", type: "datetime", autoSet: "save" },
    { key: "categories", label: "Categories", type: "select", options: CATEGORIES, multiple: true },
    { key: "tags", label: "Tags", type: "select", options: [], multiple: true, allowCustom: true },
    { key: "cover", label: "Cover image", type: "file", folder: "src/assets/posts/{slug}", keepName: true, publishAs: "path" },
    { key: "coverAlt", label: "Cover alt text", type: "text" },
    { key: "content", label: "Content", type: "richtext", imageLibrary: "media", blocks: ["Caption", "Callout", "LinkButton", "Gallery"] },
  ] },
  { key: "pages", label: "Pages", slugSource: "title", titleField: "title", thumbField: "cover", format: "mdx", folder: "src/content/pages", bodyField: "content", fields: [
    { key: "title", label: "Title", type: "text", required: true },
    { key: "description", label: "Description (SEO)", type: "textarea" },
    { key: "shortTitle", label: "Short title", type: "text" },
    { key: "cover", label: "Cover image", type: "file", folder: "src/assets/pages/{slug}", keepName: true, publishAs: "path" },
    { key: "content", label: "Content", type: "richtext", imageLibrary: "media", blocks: ["Caption", "Callout", "LinkButton", "Gallery"] },
  ] },
].map((d) => CollectionCreate.parse(d));
const col = (k: string) => defs.find((d) => d.key === k)!;

// The site's four components, as content blocks (matches keystatic.shared.ts).
const blockDefs = [
  { key: "Caption", label: "Image caption", content: "inline", props: [] },
  { key: "Callout", label: "Call-out box", content: "blocks", props: [] },
  { key: "LinkButton", label: "Button link", content: "none", props: [{ key: "label", label: "Button text", type: "text" }, { key: "href", label: "Link (e.g. /contact)", type: "text" }] },
  { key: "Gallery", label: "Gallery", content: "none", props: [
    { key: "columns", label: "Columns", type: "number" }, { key: "aspect", label: "Image shape (1 = square, 3/2 = landscape)", type: "text" },
    { key: "images", label: "Images", type: "images", library: "media", rooted: true }] },
].map((b) => BlockDef.parse(b));

// ---- reading the site -------------------------------------------------------------------------------------------------
function frontmatter(file: string) {
  const t = readFileSync(file, "utf8"), m = t.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) { warn.push(`${path.basename(file)}: no frontmatter`); return { fm: {} as Record<string, unknown>, body: t }; }
  const fm: Record<string, unknown> = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (!kv) { warn.push(`${path.basename(file)}: frontmatter line not understood: ${line.slice(0, 60)}`); continue; }
    const v = kv[2].trim();
    try { fm[kv[1]] = v.startsWith('"') || v.startsWith("[") ? JSON.parse(v) : v; }
    catch { warn.push(`${path.basename(file)}: couldn't read ${kv[1]}`); fm[kv[1]] = v; }
  }
  return { fm, body: m[2] };
}

const sizeOf = (file: string) => {
  const out = execFileSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", file], { encoding: "utf8" });
  return { width: Number(out.match(/pixelWidth: (\d+)/)?.[1]), height: Number(out.match(/pixelHeight: (\d+)/)?.[1]) };
};

// ---- main -------------------------------------------------------------------------------------------------------------
const proxy = await getPlatformProxy<{ DB: D1Database; BLOBS: R2Bucket }>({ configPath: path.resolve("wrangler.jsonc") });
const { DB, BLOBS } = proxy.env;
const now = Date.now();
let bytesIn = 0, newBlobs = 0;

type FileValue = { key: string; name: string; size: number; mime: string; width?: number; height?: number };
const files = new Map<string, FileValue | null>();
async function ingest(abs: string): Promise<FileValue | null> {
  if (files.has(abs)) return files.get(abs)!;
  let v: FileValue | null = null;
  if (!existsSync(abs)) warn.push(`missing image: ${path.relative(root, abs)}`);
  else {
    const bytes = new Uint8Array(readFileSync(abs)), mime = sniffImage(bytes);
    if (!mime) warn.push(`not a supported image: ${path.relative(root, abs)}`);
    else {
      const key = blobKey(createHash("sha256").update(bytes).digest("hex"), mime);
      if (!dry && !(await BLOBS.head(key))) { await BLOBS.put(key, bytes, { httpMetadata: { contentType: mime } }); newBlobs++; }
      bytesIn += bytes.length;
      v = { key, name: path.basename(abs), size: bytes.length, mime, ...sizeOf(abs) };
    }
  }
  files.set(abs, v);
  return v;
}

// One library entry per distinct image (by content), made as the body images are met.
const library = new Map<string, string>(), usedSlugs = new Set<string>(), entries: { id: string; collection: string; slug: string; data: Record<string, unknown>; at: number }[] = [];
async function libraryImage(abs: string, alt: string, link?: string) {
  const f = await ingest(abs);
  if (!f) return undefined;
  let id = library.get(f.key);
  if (!id) {
    id = randomUUID(); library.set(f.key, id);
    const label = alt.trim() || path.basename(abs, path.extname(abs)).replace(/^[0-9a-f]{6}-/, "").replace(/[-_]+/g, " ");
    const base = slugify(label).split("-").slice(0, 8).join("-") || "image";
    const slug = usedSlugs.has(base) ? nextFreeSlug(base, usedSlugs) : base;
    usedSlugs.add(slug);
    entries.push({ id, collection: "media", slug, at: now, data: { image: f, alt: label, ...(link ? { link } : {}) } });
  }
  return { id, f };
}

const LINKED = /^\[!\[([^\]]*)\]\(([^)\s]+)\)\]\((https?:[^)\s]+)\)$/;
let inline = 0, converted = 0;
async function convertBody(md: string, from: string) {
  const resolve = (src: string) => path.resolve(src.startsWith("/") ? root : path.dirname(from), src.startsWith("/") ? "." + src : src);
  const content = fromMarkdown(md, { mdx: true, blocks: blockDefs }) as any[];
  const out: any[] = [];
  for (const n of content) {
    const only = n.type === "paragraph" && n.content?.length === 1 ? n.content[0] : null;
    let hit: { src: string; alt: string; link?: string } | null = null;
    if (only?.type === "image") hit = { src: only.attrs.src, alt: only.attrs.alt ?? "" };
    else if (only?.type === "rawInline") { const m = String(only.attrs?.source ?? "").match(LINKED); if (m) hit = { src: m[2], alt: m[1], link: m[3] }; }
    const lib = hit && (await libraryImage(resolve(hit.src), hit.alt.replace(/\\(.)/g, "$1"), hit.link));
    if (lib) { converted++; out.push({ type: "libraryImage", attrs: { entry: lib.id, src: blobUrl(lib.f.key), alt: hit!.alt } }); }
    else {
      if (n.content?.some((c: any) => c.type === "image")) inline++;
      out.push(n);
    }
  }
  // Gallery-style blocks carry image paths; match each to a library entry.
  const fix = async (nodes: any[]) => {
    for (const n of nodes) {
      if (String(n.type).startsWith("block")) for (const [k, v] of Object.entries<any>(n.attrs?.props ?? {})) if (Array.isArray(v)) {
        n.attrs.props[k] = await Promise.all(v.map(async (it: any) => {
          const lib = it.src && (await libraryImage(resolve(it.src), String(it.alt ?? "")));
          return lib ? { entry: lib.id, src: blobUrl(lib.f.key), alt: String(it.alt ?? "") } : it;
        }));
      }
      if (n.content) await fix(n.content);
    }
  };
  await fix(out);
  return { type: "doc", content: out };
}

const when = (v: unknown) => { const d = new Date(String(v)); return isNaN(+d) ? undefined : d.toISOString(); };
const list = (v: unknown) => (Array.isArray(v) && v.length ? v : undefined);
const clean = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== ""));

async function importCollection(key: "posts" | "pages", dir: string) {
  const c = col(key);
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".mdx")).sort()) {
    const file = path.join(dir, name), slug = name.replace(/\.mdx$/, ""), { fm, body } = frontmatter(file);
    const cover = typeof fm.cover === "string" && fm.cover ? await ingest(path.resolve(path.dirname(file), fm.cover)) : undefined;
    const data = clean({
      title: fm.title, description: fm.description, shortTitle: fm.shortTitle,
      pubDate: fm.pubDate && when(fm.pubDate), updatedDate: fm.updatedDate && when(fm.updatedDate),
      categories: list(fm.categories), tags: list(fm.tags), cover: cover ?? undefined, coverAlt: fm.coverAlt,
      content: await convertBody(body, file),
    });
    const ok = dataSchema(c).safeParse(data);
    if (!ok.success) { warn.push(`${key}/${slug}: ${ok.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`); continue; }
    entries.push({ id: randomUUID(), collection: key, slug, data: ok.data as Record<string, unknown>, at: (data.updatedDate ?? data.pubDate) ? +new Date(String(data.updatedDate ?? data.pubDate)) : now });
  }
}

await importCollection("posts", path.join(root, "src/content/posts"));
await importCollection("pages", path.join(root, "src/content/pages"));
for (const e of entries.filter((e) => e.collection === "media")) { // the library entries must validate too
  const ok = dataSchema(col("media")).safeParse(e.data);
  if (!ok.success) warn.push(`media/${e.slug}: ${ok.error.issues.map((i) => i.message).join("; ")}`);
}

const count = (k: string) => entries.filter((e) => e.collection === k).length;
console.log(`${dry ? "DRY RUN — nothing written. " : ""}${count("posts")} posts, ${count("pages")} pages, ${count("media")} library images`);
console.log(`${converted} body images became library images; ${inline} paragraphs keep an inline image; ${(bytesIn / 1e6).toFixed(0)} MB of images read, ${newBlobs} newly stored`);
console.log(warn.length ? `${warn.length} warnings:\n  ${warn.slice(0, 25).join("\n  ")}` : "no warnings");

if (!dry) {
  await DB.batch([
    DB.prepare("DELETE FROM blocks WHERE key IN (?,?,?,?)").bind(...blockDefs.map((b) => b.key)),
    ...blockDefs.map((b) => DB.prepare("INSERT INTO blocks (key, label, content, props, updatedAt) VALUES (?,?,?,?,?)").bind(b.key, b.label, b.content, JSON.stringify(b.props), now)),
  ]);
  await DB.batch(defs.flatMap((d) => [
    DB.prepare("DELETE FROM entries WHERE collection = ?").bind(d.key),
    DB.prepare("DELETE FROM collections WHERE key = ?").bind(d.key),
    DB.prepare("INSERT INTO collections (key, label, slugSource, titleField, thumbField, format, folder, bodyField, fields, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .bind(d.key, d.label, d.slugSource ?? null, d.titleField ?? null, d.thumbField ?? null, d.format ?? null, d.folder ?? null, d.bodyField ?? null, JSON.stringify(d.fields), now),
  ]));
  for (let i = 0; i < entries.length; i += 25)
    await DB.batch(entries.slice(i, i + 25).map((e) => DB.prepare("INSERT INTO entries (id, collection, slug, status, data, updatedAt) VALUES (?,?,?,?,?,?)")
      .bind(e.id, e.collection, e.slug, "published", JSON.stringify(e.data), e.at)));
  console.log("written.");
}
await proxy.dispose();
