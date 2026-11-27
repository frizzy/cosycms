import { entryLabel, fileFieldOf, type Field } from "./fields.ts";
import { frontmatter } from "./frontmatter.ts";
import type { FileValue } from "./images.ts";
import { docImageIds, docLinkIds, resolveDoc, resolveLinks, toMarkdown, type ImageResolver } from "./markdown.ts";
import type { BlockDef } from "./blocks.ts";
import type { Change } from "./targets.ts";
import { STAT_KEYS, entryStats } from "./stats.ts";

export type PublishedEntry = { id: string; collection: string; slug: string; data: Record<string, unknown> };
export type State = { entryId: string; path: string; hash: string };

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
export const sha256 = async (d: string | BufferSource) =>
  hex(await crypto.subtle.digest("SHA-256", typeof d === "string" ? new TextEncoder().encode(d) : d));

// What rendering needs to know: every collection's definition, and every entry (to resolve references to paths and slugs).
export type CollectionInfo = { fields: Field[]; format?: string | null; bodyField?: string | null; folder?: string | null; urlTemplate?: string | null; dates?: boolean; stats?: boolean };
export type RenderCtx = { collections: Map<string, CollectionInfo>; entries: Map<string, Omit<PublishedEntry, "id">>; blocks?: Map<string, BlockDef> };

// ---- paths -----------------------------------------------------------------------------------------------------------
const ext = (key: string) => key.slice(key.lastIndexOf(".") + 1);

/** A file name made safe for a path: lowercase, no accents, only letters, digits, dots and dashes. */
const safeName = (name: string) =>
  name.replace(/\.[^.]*$/, "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "") || "image";

/** Where an uploaded image is published. With a folder set: `<folder>/<name>`, where {slug} and {collection} fill in and the name is
 *  the uploaded file's own (if kept) or the entry's slug. Without one: next to its entry. With several image fields, the field key keeps them apart. */
export function filePath(e: { collection: string; slug: string }, fields: Field[], f: Field, file: { key: string; name: string }) {
  const single = fields.filter((x) => x.type === "file").length === 1, tail = ext(file.key);
  if (f.type === "file" && f.folder) {
    const dir = f.folder.replace(/\{slug\}/g, e.slug).replace(/\{collection\}/g, e.collection);
    return `${dir}/${f.keepName ? safeName(file.name) : e.slug + (single ? "" : "." + f.key)}.${tail}`;
  }
  return `${e.collection}/${e.slug}${single ? "" : "." + f.key}.${tail}`;
}

/** A relative link from one published file to another ("./a.webp", "../images/a.webp"). */
export function relative(from: string, to: string) {
  const f = from.split("/").slice(0, -1), t = to.split("/");
  let i = 0;
  while (i < f.length && i < t.length - 1 && f[i] === t[i]) i++;
  return (f.length - i ? "../".repeat(f.length - i) : "./") + t.slice(i).join("/");
}

const isMd = (col?: CollectionInfo) => col?.format === "markdown" || col?.format === "mdx";
const outPath = (e: { collection: string; slug: string }, col?: CollectionInfo) => `${col?.folder || e.collection}/${e.slug}.${col?.format === "mdx" ? "mdx" : col?.format === "markdown" ? "md" : "json"}`;

// ---- rendering -------------------------------------------------------------------------------------------------------
/** A reference to an image-library entry, resolved to what a site needs: slug, file path, size, and the entry's own fields. */
function media(id: string, fromPath: string, ctx: RenderCtx) {
  const t = ctx.entries.get(id), col = t && ctx.collections.get(t.collection), ff = col && fileFieldOf(col);
  const file = ff && (t!.data[ff.key] as FileValue | undefined);
  if (!t || !col || !ff || !file) return undefined;
  const out: Record<string, unknown> = { slug: t.slug, src: relative(fromPath, filePath(t, col.fields, ff, file)), ...(file.width ? { width: file.width, height: file.height } : {}) };
  for (const f of col.fields) if (!["file", "richtext", "reference"].includes(f.type) && t.data[f.key] != null && !(f.key in out)) out[f.key] = t.data[f.key];
  return out;
}

/** JSON collections publish <collection>/<slug>.json; Markdown ones publish <collection>/<slug>.md (YAML frontmatter + body). */
const imageTag = (f?: Field) => (f?.type === "richtext" ? f.imageComponent : undefined);

// The two dates a collection with publish dates adds to what it publishes.
const STAT_FIELDS = STAT_KEYS.map((key) => ({ key, label: key, type: "number" as const })) as unknown as Field[];
const DATE_FIELDS = (["publishedAt", "revisedAt"] as const).map((key) => ({ key, label: key, type: "datetime" as const })) as unknown as Field[];

export function render(e: PublishedEntry, ctx?: RenderCtx) {
  const col = ctx?.collections.get(e.collection), path = outPath(e, col);
  const image: ImageResolver = (id) => {
    const m = ctx && media(id, path, ctx), t = ctx?.entries.get(id);
    if (!m || !t) return undefined;
    const tc = ctx!.collections.get(t.collection)!, ff = fileFieldOf(tc)!;
    return { src: String(m.src), alt: entryLabel(tc.fields, t.data, t.slug), path: filePath(t, tc.fields, ff, t.data[ff.key] as FileValue) };
  };
  const blocks = ctx?.blocks;
  // A link to another entry becomes that entry's page address (its collection's urlTemplate with the slug filled in).
  const href = (id: string) => { const t = ctx?.entries.get(id), tc = t && ctx!.collections.get(t.collection); return t && tc?.urlTemplate ? tc.urlTemplate.replace("{slug}", t.slug) : undefined; };
  // Counted from the entry as written, before links and images are turned into paths.
  let data = col?.stats ? { ...e.data, ...entryStats(col.fields, e.data, col.bodyField) } : e.data;
  const fields = [...(col?.fields ?? []), ...(col?.dates ? DATE_FIELDS : []), ...(col?.stats ? STAT_FIELDS : [])];
  for (const f of fields) {
    const v = data[f.key];
    if (v == null) continue;
    if (f.type === "reference") {
      // image libraries resolve to a file path and metadata; anything else to the target's slug
      const one = (id: string) => (ctx && media(id, path, ctx)) ?? ctx?.entries.get(id)?.slug ?? id;
      data = { ...data, [f.key]: Array.isArray(v) ? v.map(one) : one(v as string) };
    } else if (f.type === "file") {
      const file = v as FileValue;
      const src = relative(path, filePath(e, col!.fields, f, file));
      data = { ...data, [f.key]: f.publishAs === "path" ? src : { src, ...(file.width ? { width: file.width, height: file.height } : {}) } };
    } else if (f.type === "richtext") { const linked = resolveLinks(v as never, href); data = { ...data, [f.key]: isMd(col) ? linked : resolveDoc(linked, image, blocks) }; }
  }
  if (isMd(col)) {
    const mdx = col!.format === "mdx";
    const body = col!.bodyField ? toMarkdown(data[col!.bodyField] as never, image, { mdx, blocks, imageComponent: imageTag(col!.fields.find((f) => f.key === col!.bodyField)) }) : "";
    const fm = frontmatter(fields, data, col!.bodyField, image, mdx, blocks);
    return { path, content: fm && body ? `${fm}\n${body}` : fm || body || "\n" };
  }
  return { path, content: JSON.stringify(data, null, 2) + "\n" };
}

/** The image files an entry owns, each published next to it. Keyed "<entry id>#<field>" so each has its own publish state. */
export function entryFiles(e: PublishedEntry, ctx?: RenderCtx) {
  const fields = ctx?.collections.get(e.collection)?.fields ?? [];
  return fields.flatMap((f) => {
    const file = f.type === "file" ? (e.data[f.key] as FileValue | undefined) : undefined;
    return file ? [{ id: `${e.id}#${f.key}`, path: filePath(e, fields, f, file), key: file.key }] : [];
  });
}

/** A published entry that points at a draft would publish a link to something that isn't there. */
export function draftWarnings(published: PublishedEntry[], all: Map<string, { collection: string; slug: string; status: string }>, ctx: RenderCtx) {
  return published.flatMap((e) => (ctx.collections.get(e.collection)?.fields ?? []).flatMap((f) => {
    const ids = f.type === "reference" ? [e.data[f.key]].flat().filter(Boolean) : f.type === "richtext" ? [...docImageIds(e.data[f.key] as never), ...docLinkIds(e.data[f.key] as never)] : [];
    const links = f.type === "richtext" ? docLinkIds(e.data[f.key] as never).map((id) => all.get(id)).filter((t) => t && !ctx.collections.get(t.collection)?.urlTemplate) : [];
    return [...ids.map((id) => all.get(id as string)).filter((t) => t && t.status !== "published")
      .map((t) => `${e.collection}/${e.slug} uses ${t!.collection}/${t!.slug}, which is still a draft`),
      ...links.map((t) => `${e.collection}/${e.slug} links to ${t!.collection}/${t!.slug}, but ${t!.collection} has no page address, so the link is left as plain text`)];
  }));
}

// ---- diffing ---------------------------------------------------------------------------------------------------------
/** Diff published entries (and their image files) against what each target last received. Pure, so it's easy to test. */
export async function plan(entries: PublishedEntry[], state: State[], ctx?: RenderCtx) {
  const prev = new Map(state.map((s) => [s.entryId, s]));
  const changes: Change[] = [];
  const upserts: State[] = [];

  // Text files are compared by content hash; image files by their blob key, which already is a content hash.
  const items: { id: string; path: string; hash: string; change: Change }[] = [];
  for (const e of entries) {
    const { path, content } = render(e, ctx);
    items.push({ id: e.id, path, hash: await sha256(content), change: { type: "upsert", id: e.id, path, content } });
    for (const f of entryFiles(e, ctx)) items.push({ id: f.id, path: f.path, hash: f.key, change: { type: "upsert", id: f.id, path: f.path, file: f.key } });
  }

  // Two different things published to one path would silently overwrite each other.
  const byPath = new Map<string, string>(), conflicts = new Set<string>();
  for (const it of items) { if (byPath.has(it.path) && byPath.get(it.path) !== it.id) conflicts.add(it.path); byPath.set(it.path, it.id); }

  for (const it of items) {
    const old = prev.get(it.id);
    prev.delete(it.id);
    if (old?.hash === it.hash && old.path === it.path) continue;
    if (old && old.path !== it.path) changes.push({ type: "delete", id: it.id, path: old.path }); // slug/collection renamed
    changes.push(it.change);
    upserts.push({ entryId: it.id, path: it.path, hash: it.hash });
  }

  // Whatever is left was published before but is now a draft, deleted or replaced.
  const removed = [...prev.values()];
  for (const s of removed) changes.push({ type: "delete", id: s.entryId, path: s.path });

  return { changes, upserts, removed: removed.map((s) => s.entryId), conflicts: [...conflicts] };
}
