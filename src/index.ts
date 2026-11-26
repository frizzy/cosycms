import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { getTableColumns } from "drizzle-orm";
import { and, count, desc, eq, inArray, like, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { activity, blocks, collections, entries, templates } from "./schema";
import { TemplateDef } from "./templates";
import { changedKeys, logActivity, type Event } from "./activity";
import { BlockDef, blockLibraries } from "./blocks";
import { CollectionCreate, CollectionDef, dataSchema, entryLabel, fileFieldOf, nextFreeSlug, shapeChanges, slugBase, type Field } from "./fields";
import { bodyLimit } from "hono/body-limit";
import { githubCheck, githubRuns, githubTarget } from "./github";
import { r2Store } from "./blobs";
import { KEY_RE, MAX_IMAGE_BYTES, blobKey, blobUrl, sniffImage } from "./images";
import { docBlockNames, docImageIds, docLinkIds, fillPictures } from "./markdown";
import { sha256 } from "./plan";
import { build, publish } from "./publish";
import { loadGithub, saveGithub } from "./settings";
import { accountRoutes, authRoutes, humanOnly, ownerOnly, requireAuth } from "./auth";
import { mcpHandler } from "./mcp";

type Env = { Bindings: { DB: D1Database; BLOBS: R2Bucket; SETTINGS_KEY?: string; GITHUB_CLIENT_ID?: string; GITHUB_CLIENT_SECRET?: string; GOOGLE_CLIENT_ID?: string; GOOGLE_CLIENT_SECRET?: string; GITHUB_TOKEN?: string; GITHUB_REPO?: string; GITHUB_BRANCH?: string; GITHUB_DIR?: string }; Variables: { user: { id: string; email: string; role: "owner" | "member"; app?: boolean; via?: string } } };
const app = new Hono<Env>().basePath("/api");

const Input = z.object({
  collection: z.string(),
  slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "lowercase letters, numbers and dashes"),
  data: z.record(z.string(), z.unknown()),
});

const db = (c: { env: Env["Bindings"] }) => drizzle(c.env.DB);
// Drizzle wraps the D1 error; the constraint text lives on `cause`.
const isConflict = (e: unknown) => /UNIQUE/.test(String(e) + String((e as Error).cause));
// What the admin sees of an entry: the working draft, plus whether a published version exists and whether the draft has moved on from it.
type Row = typeof entries.$inferSelect;
const shape = ({ live, ...e }: Row) => ({ ...e, published: !!live });
const differs = (live: Row["live"], slug: string, data: Record<string, unknown>) => !!live && (live.slug !== slug || JSON.stringify(live.data) !== JSON.stringify(data));
const log = (c: { env: Env["Bindings"]; get(k: "user"): Env["Variables"]["user"] }, e: Event) => logActivity(c.env.DB, { email: c.get("user").email, via: c.get("user").via }, e);
/** What an entry is called in the history: its title if the collection has one, else its slug. */
async function labelOf(c: { env: Env["Bindings"] }, e: { collection: string; slug: string; data: Record<string, unknown> }) {
  const [col] = await db(c).select().from(collections).where(eq(collections.key, e.collection));
  return col ? entryLabel(col.fields, e.data, e.slug, col.titleField) : e.slug;
}
const flat = (field: string, messages: string[]) => ({ formErrors: [], fieldErrors: { [field]: messages } });

const blocksOf = async (c: { env: Env["Bindings"] }, keys?: string[]) =>
  keys?.length ? await db(c).select().from(blocks).where(inArray(blocks.key, keys)) : [];

/** Validates an entry against its collection's current fields; unknown data keys are stripped. */
async function parseEntry(c: { env: Env["Bindings"] }, raw: unknown, creating: boolean) {
  const base = Input.safeParse(raw);
  if (!base.success) return { error: base.error.flatten() };
  const [col] = await db(c).select().from(collections).where(eq(collections.key, base.data.collection));
  if (!col) return { error: flat("collection", ["unknown collection"]) };
  // Automatic timestamps are filled in before validation, so a required one never blocks the save.
  const given = { ...base.data.data }, now = new Date().toISOString();
  for (const f of col.fields) if (f.type === "datetime" && f.autoSet && (f.autoSet === "save" || (creating && !given[f.key]))) given[f.key] = now;
  const data = dataSchema(col).safeParse(given);
  if (!data.success) return { error: flat("data", data.error.issues.map((i) => `${i.path.join(".") || "value"}: ${i.message}`)) };
  // Uploaded files: the object must exist, and size/type come from storage, not from what the client claims.
  const blobs = r2Store(c.env.BLOBS), out = data.data as Record<string, any>;
  for (const f of col.fields) {
    if (f.type === "reference" && out[f.key] != null) {
      const ids = [...new Set([out[f.key]].flat() as string[])];
      const found = await db(c).select({ id: entries.id }).from(entries).where(and(eq(entries.collection, f.collection), inArray(entries.id, ids)));
      if (found.length !== ids.length) return { error: flat("data", [`${f.key}: refers to an entry that no longer exists in ${f.collection}`]) };
    }
    if (f.type === "richtext" && out[f.key]) {
      const linked = [...new Set(docLinkIds(out[f.key] as never))];
      if (linked.length && (await db(c).select({ id: entries.id }).from(entries).where(inArray(entries.id, linked))).length !== linked.length)
        return { error: flat("data", [`${f.key}: a link points to an entry that no longer exists`]) };
      const allowed = new Set(f.blocks ?? []), names = [...new Set(docBlockNames(out[f.key] as never))].filter((n) => !allowed.has(n));
      if (names.length) return { error: flat("data", [`${f.key}: the block ${names.map((n) => `"${n}"`).join(", ")} isn't allowed in this field`]) };
      const ids = [...new Set(docImageIds(out[f.key] as never))];
      if (ids.length) {
        // pictures may come from the field's own library or from the libraries its blocks use
        const libs = [...new Set([...(f.imageLibrary ? [f.imageLibrary] : []), ...blockLibraries(await blocksOf(c, f.blocks))])];
        if (!libs.length) return { error: flat("data", [`${f.key}: this field has no image library, so it can't contain library images`]) };
        const found = await db(c).select().from(entries).where(and(inArray(entries.collection, libs), inArray(entries.id, ids)));
        if (found.length !== ids.length) return { error: flat("data", [`${f.key}: an image in the text no longer exists in the image library`]) };
        // The editor draws each picture from a copy of its address kept in the text; text that arrived as Markdown doesn't have one yet.
        const libCols = await db(c).select().from(collections).where(inArray(collections.key, libs));
        const addr = new Map(found.map((e) => { const ff = fileFieldOf(libCols.find((l) => l.key === e.collection) ?? { fields: [] }); const k = ff && (e.data[ff.key] as { key?: string } | undefined)?.key; return [e.id, k && blobUrl(k)] as const; }));
        fillPictures(out[f.key] as never, (id) => addr.get(id));
      }
    }
    if (f.type !== "file" || !out[f.key]) continue;
    const head = await blobs.head(out[f.key].key);
    if (!head) return { error: flat("data", [`${f.key}: file not found, upload it again`]) };
    out[f.key] = { ...out[f.key], size: head.size, mime: head.contentType };
  }
  return { value: { ...base.data, data: out as Record<string, unknown> } };
}

app.put("/uploads", bodyLimit({ maxSize: MAX_IMAGE_BYTES, onError: (c) => c.json({ error: "That image is larger than 10 MB." }, 413) }), async (c) => {
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  const mime = sniffImage(bytes);
  if (!mime) return c.json({ error: "Unsupported file. Use a PNG, JPEG, WebP, GIF or AVIF image." }, 415);
  const key = blobKey(await sha256(bytes), mime);
  await r2Store(c.env.BLOBS).put(key, bytes, mime);
  return c.json({ key, name: (c.req.query("name") ?? "").slice(0, 200), size: bytes.length, mime });
});

// Content-addressed, so a URL's bytes never change and can be cached forever. The headers stop an upload being treated as a page.
app.get("/blobs/:file", async (c) => {
  const key = `media/${c.req.param("file")}`;
  const o = KEY_RE.test(key) ? await r2Store(c.env.BLOBS).get(key) : null;
  if (!o) return c.json({ error: "not found" }, 404);
  return new Response(o.body, { headers: {
    "content-type": o.contentType, "content-length": String(o.size),
    "cache-control": "public, max-age=31536000, immutable",
    "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox",
  } });
});

app.get("/collections", async (c) => c.json(await db(c).select().from(collections).orderBy(collections.label)));

const unknownTargets = async (c: { env: Env["Bindings"] }, own: string, fields: Field[]) => {
  const known = new Set((await db(c).select({ key: collections.key }).from(collections)).map((r) => r.key));
  const blockKeys = new Set((await db(c).select({ key: blocks.key }).from(blocks)).map((r) => r.key));
  const tpls = new Map((await db(c).select().from(templates)).map((t) => [t.key, t]));
  return fields.flatMap((f) => {
    const target = f.type === "reference" ? f.collection : f.type === "richtext" ? f.imageLibrary : undefined;
    return [
      ...(target && target !== own && !known.has(target) ? [`"${f.label}" points at "${target}", which doesn't exist`] : []),
      ...(f.type === "richtext" ? (f.blocks ?? []).filter((b) => !blockKeys.has(b)).map((b) => `"${f.label}" allows the block "${b}", which doesn't exist`) : []),
      ...(f.type === "richtext" ? (f.templates ?? []).flatMap((k) => {
        const t = tpls.get(k), bad = t ? [...new Set(docBlockNames(t.body as never))].filter((n) => !f.blocks?.includes(n)) : [];
        return !t ? [`"${f.label}" uses the template "${k}", which doesn't exist`] : bad.length ? [`"${f.label}" uses the template "${t.label}", which contains the block ${bad.map((n) => `"${n}"`).join(", ")}; allow it in this field first`] : [];
      }) : []),
    ];
  });
};

// A thumbnail taken from a reference only makes sense if that reference points at an image library (or at the collection itself).
const thumbProblems = async (c: { env: Env["Bindings"] }, own: string, def: { thumbField?: string | null; fields: Field[] }) => {
  const f = def.thumbField ? def.fields.find((x) => x.key === def.thumbField) : undefined;
  if (f?.type !== "reference") return [];
  const target = f.collection === own ? def : (await db(c).select().from(collections).where(eq(collections.key, f.collection)))[0];
  return target?.fields.some((x) => x.type === "file") ? [] : [`the thumbnail field "${f.label}" must point at an image library`];
};

// ---- content blocks ----
app.get("/blocks", async (c) => c.json(await db(c).select().from(blocks).orderBy(blocks.label)));

const usersOfBlock = async (c: { env: Env["Bindings"] }, key: string) =>
  (await db(c).select().from(collections)).filter((o) => o.fields.some((f) => f.type === "richtext" && f.blocks?.includes(key))).map((o) => o.label);

app.put("/blocks/:key", ownerOnly, async (c) => {
  const key = c.req.param("key");
  const input = BlockDef.safeParse({ ...(await c.req.json().catch(() => ({}))), key });
  if (!input.success) return c.json(input.error.flatten(), 400);
  const cols = await db(c).select().from(collections);
  const badLib = input.data.props.flatMap((p) => (p.type === "images" && !cols.some((o) => o.key === p.library && o.fields.some((f) => f.type === "file")) ? [p.library] : []));
  if (badLib.length) return c.json({ error: `"${badLib[0]}" isn't an image library (a collection with an image field)` }, 400);
  const [old] = await db(c).select().from(blocks).where(eq(blocks.key, key));
  if (old && old.content !== input.data.content) {
    const used = await usersOfBlock(c, key);
    if (used.length) return c.json({ error: `What a block holds can't change while it is allowed in: ${used.join(", ")}` }, 400);
  }
  const row = { ...input.data, updatedAt: new Date() };
  await db(c).insert(blocks).values(row).onConflictDoUpdate({ target: blocks.key, set: { label: row.label, content: row.content, props: row.props, updatedAt: row.updatedAt } });
  await log(c, { action: "block.save", label: row.label, detail: old ? "changed" : "created" });
  return c.json(row, old ? 200 : 201);
});

app.delete("/blocks/:key", ownerOnly, async (c) => {
  const used = await usersOfBlock(c, c.req.param("key"));
  if (used.length) return c.json({ error: `This block is allowed in a field of: ${used.join(", ")}. Remove it there first.` }, 409);
  const [gone] = await db(c).delete(blocks).where(eq(blocks.key, c.req.param("key"))).returning();
  if (gone) await log(c, { action: "block.delete", label: gone.label });
  return c.body(null, 204);
});

// ---- templates ----
app.get("/templates", async (c) => c.json(await db(c).select().from(templates).orderBy(templates.label)));

const usersOfTemplate = async (c: { env: Env["Bindings"] }, key: string) =>
  (await db(c).select().from(collections)).filter((o) => o.fields.some((f) => f.type === "richtext" && f.templates?.includes(key))).map((o) => o.label);

app.put("/templates/:key", ownerOnly, async (c) => {
  const key = c.req.param("key");
  const input = TemplateDef.safeParse({ ...(await c.req.json().catch(() => ({}))), key });
  if (!input.success) return c.json(input.error.flatten(), 400);
  const [old] = await db(c).select().from(templates).where(eq(templates.key, key));
  const row = { ...input.data, updatedAt: new Date() };
  await db(c).insert(templates).values(row).onConflictDoUpdate({ target: templates.key, set: { label: row.label, body: row.body, prompt: row.prompt, updatedAt: row.updatedAt } });
  await log(c, { action: "template.save", label: row.label, detail: old ? "changed" : "created" });
  return c.json(row, old ? 200 : 201);
});

app.delete("/templates/:key", ownerOnly, async (c) => {
  const used = await usersOfTemplate(c, c.req.param("key"));
  if (used.length) return c.json({ error: `This template is used by a field of: ${used.join(", ")}. Remove it there first.` }, 409);
  const [gone] = await db(c).delete(templates).where(eq(templates.key, c.req.param("key"))).returning();
  if (gone) await log(c, { action: "template.delete", label: gone.label });
  return c.body(null, 204);
});

app.post("/collections", ownerOnly, async (c) => {
  const input = CollectionCreate.safeParse(await c.req.json());
  if (!input.success) return c.json(input.error.flatten(), 400);
  const bad = [...await unknownTargets(c, input.data.key, input.data.fields), ...await thumbProblems(c, input.data.key, input.data)];
  if (bad.length) return c.json({ error: bad.join("; ") }, 400);
  const row = { ...input.data, updatedAt: new Date() };
  try { await db(c).insert(collections).values(row); }
  catch (e) { if (isConflict(e)) return c.json({ error: "a collection with that key already exists" }, 409); throw e; }
  await log(c, { action: "collection.save", collection: row.key, label: row.label, detail: "created" });
  return c.json(row, 201);
});

app.put("/collections/:key", ownerOnly, async (c) => {
  const input = CollectionDef.safeParse(await c.req.json());
  if (!input.success) return c.json(input.error.flatten(), 400);
  const [old] = await db(c).select().from(collections).where(eq(collections.key, c.req.param("key")));
  if (!old) return c.json({ error: "not found" }, 404);
  const bad = [...await unknownTargets(c, old.key, input.data.fields), ...await thumbProblems(c, old.key, input.data)];
  if (bad.length) return c.json({ error: bad.join("; ") }, 400);
  const changed = shapeChanges(old.fields, input.data.fields);
  if (changed.length) return c.json({ error: `type or single/multi can't change for: ${changed.join(", ")}. Add a new field instead.` }, 400);
  // Optional settings are set to null, not undefined, so that clearing them actually clears the column.
  const [row] = await db(c).update(collections).set({ ...input.data, slugSource: input.data.slugSource ?? null, titleField: input.data.titleField ?? null, urlTemplate: input.data.urlTemplate ?? null, thumbField: input.data.thumbField ?? null, format: input.data.format ?? null, folder: input.data.folder ?? null, bodyField: input.data.bodyField ?? null, single: input.data.single ?? false, updatedAt: new Date() }).where(eq(collections.key, old.key)).returning();
  await log(c, { action: "collection.save", collection: old.key, label: row.label, detail: "changed" });
  return c.json(row);
});

app.delete("/collections/:key", ownerOnly, async (c) => {
  const key = c.req.param("key");
  const users = (await db(c).select().from(collections)).filter((o) => o.key !== key && o.fields.some((f) => (f.type === "reference" && f.collection === key) || (f.type === "richtext" && f.imageLibrary === key)));
  if (users.length) return c.json({ error: `collection is used by a field in: ${users.map((o) => o.label).join(", ")}` }, 409);
  const [{ n }] = await db(c).select({ n: count() }).from(entries).where(eq(entries.collection, key));
  if (n) return c.json({ error: `collection has ${n} entr${n === 1 ? "y" : "ies"}; delete them first` }, 409);
  const [gone] = await db(c).delete(collections).where(eq(collections.key, key)).returning();
  if (gone) await log(c, { action: "collection.delete", collection: key, label: gone.label });
  return c.body(null, 204);
});

app.get("/entries", async (c) => {
  const collection = c.req.query("collection"), slug = c.req.query("slug"); // slug is unique within a collection, so the pair finds one entry
  return c.json((await db(c).select().from(entries).where(and(collection ? eq(entries.collection, collection) : undefined, slug ? eq(entries.slug, slug) : undefined))).map(shape));
});

// A list row's thumbnail: the storage key of its image, straight from an upload field, or looked up through a reference to an image library.
async function withThumbs(c: { env: Env["Bindings"] }, col: { fields: Field[]; thumbField?: string | null }, rows: Row[]) {
  const items = rows.map(shape);
  const tf = col.thumbField ? col.fields.find((f) => f.key === col.thumbField) : undefined;
  if (!tf || (tf.type !== "file" && tf.type !== "reference")) return items;
  if (tf.type === "file") return items.map((e) => ({ ...e, thumb: (e.data[tf.key] as { key?: string } | undefined)?.key }));
  const first = (e: (typeof items)[number]) => [e.data[tf.key]].flat()[0] as string | undefined;
  const ids = [...new Set(items.flatMap((e) => first(e) ?? []))];
  const [target] = await db(c).select().from(collections).where(eq(collections.key, tf.collection));
  const ff = target?.fields.find((f) => f.type === "file");
  const found = ids.length && ff ? await db(c).select().from(entries).where(inArray(entries.id, ids)) : [];
  const keys = new Map(found.map((r) => [r.id, (r.data[ff!.key] as { key?: string } | undefined)?.key]));
  return items.map((e) => ({ ...e, thumb: keys.get(first(e) ?? "") }));
}

// The admin's list: search, sort and one page at a time, so a collection can grow without the list slowing down.
// Search looks in the slug and every text field; sorting by title uses the collection's title field (falling back to the slug).
app.get("/entries/search", async (c) => {
  const { collection = "", q = "", sort = "updated", dir = "desc", filter = "" } = c.req.query();
  const limit = Math.min(Math.max(parseInt(c.req.query("limit") ?? "") || 25, 1), 100), offset = Math.max(parseInt(c.req.query("offset") ?? "") || 0, 0);
  const [col] = await db(c).select().from(collections).where(eq(collections.key, collection));
  if (!col) return c.json({ error: "unknown collection" }, 400);
  const path = (k: string) => sql`json_extract(${entries.data}, ${`$.${k}`})`; // field keys are validated as letters and digits only
  const term = `%${q.trim().replace(/[\\%_]/g, "\\$&")}%`;
  // filter: draft (never published) | edited (draft differs from published) | attention (either) | empty:<field> (nothing filled in)
  const emptyKey = filter.startsWith("empty:") ? filter.slice(6) : "";
  const filtered = filter === "draft" ? eq(entries.status, "draft") : filter === "edited" ? eq(entries.pending, true) : filter === "attention" ? or(eq(entries.status, "draft"), eq(entries.pending, true))
    : emptyKey && col.fields.some((f) => f.key === emptyKey) ? sql`coalesce(trim(cast(${path(emptyKey)} as text)), '') in ('', '[]')` : undefined;
  const match = (e: ReturnType<typeof sql>) => sql`${e} like ${term} escape '\\'`;
  const where = and(eq(entries.collection, collection), filtered, q.trim()
    ? or(match(sql`${entries.slug}`), ...col.fields.filter((f) => f.type === "text" || f.type === "textarea").map((f) => match(path(f.key))))
    : undefined);
  const key = sort === "slug" ? sql`${entries.slug}` : sort === "status" ? sql`${entries.status}`
    : sort === "title" ? (col.titleField ? sql`lower(coalesce(nullif(trim(${path(col.titleField)}), ''), ${entries.slug}))` : sql`${entries.slug}`)
    : sql`${entries.updatedAt}`;
  const [{ total }] = await db(c).select({ total: count() }).from(entries).where(where);
  const items = await db(c).select().from(entries).where(where).orderBy(dir === "asc" ? sql`${key} asc` : sql`${key} desc`, entries.id).limit(limit).offset(offset);
  return c.json({ items: await withThumbs(c, col, items), total });
});

// Sidebar badges: what still needs a person's attention in each collection (never published, or edited since).
app.get("/entries/counts", async (c) => {
  const rows = await db(c).select({ collection: entries.collection, drafts: sql<number>`sum(${entries.status} = 'draft')`, edited: sql<number>`sum(${entries.pending})` }).from(entries).groupBy(entries.collection);
  return c.json(Object.fromEntries(rows.map((r) => [r.collection, { drafts: r.drafts, edited: r.edited }])));
});

// The history: newest first, everyone signed in can read it. ?entry=<id> narrows it to one entry.
app.get("/activity", async (c) => {
  const entry = c.req.query("entry"), limit = Math.min(Math.max(parseInt(c.req.query("limit") ?? "") || 50, 1), 100), offset = Math.max(parseInt(c.req.query("offset") ?? "") || 0, 0);
  const where = entry ? eq(activity.entryId, entry) : undefined;
  const [{ total }] = await db(c).select({ total: count() }).from(activity).where(where);
  const { before, ...cols } = getTableColumns(activity); // the saved copies stay on the server
  return c.json({ items: await db(c).select({ ...cols, undoable: sql<number>`${activity.before} is not null` }).from(activity).where(where).orderBy(desc(activity.at), desc(activity.id)).limit(limit).offset(offset), total });
});

// Undo: put an entry's draft back the way it was before that change (or bring a deleted entry back). It is itself recorded, so it can be undone too.
app.post("/activity/:id/undo", async (c) => {
  const [a] = await db(c).select().from(activity).where(eq(activity.id, c.req.param("id")));
  if (!a?.before || !a.entryId || !a.collection) return c.json({ error: "That can't be undone." }, 400);
  const ok = await parseEntry(c, { collection: a.collection, slug: a.before.slug, data: a.before.data }, false); // e.g. an image it used may be gone by now
  if (!ok.value) return c.json(ok.error, 400);
  const [cur] = await db(c).select().from(entries).where(eq(entries.id, a.entryId));
  try {
    const [res] = cur
      ? await db(c).update(entries).set({ slug: ok.value.slug, data: ok.value.data, pending: differs(cur.live, ok.value.slug, ok.value.data), updatedAt: new Date() }).where(eq(entries.id, cur.id)).returning()
      : await db(c).insert(entries).values({ id: a.entryId, collection: a.collection, slug: ok.value.slug, data: ok.value.data, updatedAt: new Date() }).returning();
    await log(c, { action: "entry.restore", collection: res.collection, entryId: res.id, label: await labelOf(c, res), detail: cur ? "undid a change" : "brought it back", before: cur && { slug: cur.slug, data: cur.data } });
    return c.json(shape(res));
  } catch (e) { if (isConflict(e)) return c.json({ error: "That slug is now used by another entry." }, 409); throw e; }
});

// Live check for the editor. The unique index still has the final say at save time.
app.get("/slug-available", async (c) => {
  const { collection = "", slug = "", except } = c.req.query();
  const [row] = await db(c).select({ id: entries.id }).from(entries).where(and(eq(entries.collection, collection), eq(entries.slug, slug)));
  if (!row || row.id === except) return c.json({ available: true });
  // Slugs only contain [a-z0-9-], so the base is safe to use in LIKE.
  const near = await db(c).select({ slug: entries.slug }).from(entries)
    .where(and(eq(entries.collection, collection), like(entries.slug, `${slugBase(slug)}-%`)));
  return c.json({ available: false, suggestion: nextFreeSlug(slug, near.map((r) => r.slug)) });
});

app.get("/entries/:id", async (c) => {
  const [row] = await db(c).select().from(entries).where(eq(entries.id, c.req.param("id")));
  return row ? c.json(shape(row)) : c.json({ error: "not found" }, 404);
});

app.post("/entries", async (c) => {
  const input = await parseEntry(c, await c.req.json(), true);
  if (!input.value) return c.json(input.error, 400);
  const row = { ...input.value, id: crypto.randomUUID(), updatedAt: new Date() };
  const [col] = await db(c).select({ single: collections.single }).from(collections).where(eq(collections.key, row.collection));
  if (col?.single && (await db(c).select({ n: count() }).from(entries).where(eq(entries.collection, row.collection)))[0].n) return c.json({ error: "This collection holds a single entry. Edit that one instead." }, 409);
  try { await db(c).insert(entries).values(row); }
  catch (e) { if (isConflict(e)) return c.json({ error: "slug already exists in this collection" }, 409); throw e; }
  await log(c, { action: "entry.create", collection: row.collection, entryId: row.id, label: await labelOf(c, row) });
  return c.json(shape({ ...row, status: "draft", live: null, pending: false }), 201);
});

app.put("/entries/:id", async (c) => {
  const input = await parseEntry(c, await c.req.json(), false);
  if (!input.value) return c.json(input.error, 400);
  const [old] = await db(c).select().from(entries).where(eq(entries.id, c.req.param("id")));
  if (!old) return c.json({ error: "not found" }, 404);
  const row = { ...input.value, updatedAt: new Date(), pending: differs(old.live, input.value.slug, input.value.data) };
  try {
    const [res] = await db(c).update(entries).set(row).where(eq(entries.id, old.id)).returning();
    const changed = [...(old.slug !== res.slug ? ["slug"] : []), ...changedKeys(old.data, res.data)];
    if (changed.length) await log(c, { action: "entry.save", collection: res.collection, entryId: res.id, label: await labelOf(c, res), detail: changed.join(", "), before: { slug: old.slug, data: old.data } });
    return c.json(shape(res));
  } catch (e) { if (isConflict(e)) return c.json({ error: "slug already exists in this collection" }, 409); throw e; }
});

// Publishing is a separate step from saving: it copies the working draft to `live`, which is what the site gets. Both re-check the draft
// first (a file or an entry it points at may have gone since it was saved).
app.post("/entries/:id/publish", humanOnly, async (c) => {
  const [row] = await db(c).select().from(entries).where(eq(entries.id, c.req.param("id")));
  if (!row) return c.json({ error: "not found" }, 404);
  const ok = await parseEntry(c, { collection: row.collection, slug: row.slug, data: row.data }, false);
  if (!ok.value) return c.json(ok.error, 400);
  const [res] = await db(c).update(entries).set({ live: { slug: row.slug, data: ok.value.data }, status: "published", pending: false }).where(eq(entries.id, row.id)).returning();
  await log(c, { action: "entry.publish", collection: res.collection, entryId: res.id, label: await labelOf(c, res), detail: row.live ? "changes" : "first time" });
  return c.json(shape(res));
});

// Takes it off the site at the next deploy; the draft stays.
app.post("/entries/:id/unpublish", humanOnly, async (c) => {
  const [res] = await db(c).update(entries).set({ live: null, status: "draft", pending: false }).where(eq(entries.id, c.req.param("id"))).returning();
  if (!res) return c.json({ error: "not found" }, 404);
  await log(c, { action: "entry.unpublish", collection: res.collection, entryId: res.id, label: await labelOf(c, res) });
  return c.json(shape(res));
});

// Throws the draft away and goes back to the published version.
app.post("/entries/:id/revert", async (c) => {
  const [row] = await db(c).select().from(entries).where(eq(entries.id, c.req.param("id")));
  if (!row?.live) return c.json({ error: row ? "There is no published version to go back to." : "not found" }, row ? 400 : 404);
  try {
    const [res] = await db(c).update(entries).set({ slug: row.live.slug, data: row.live.data, pending: false, updatedAt: new Date() }).where(eq(entries.id, row.id)).returning();
    await log(c, { action: "entry.revert", collection: res.collection, entryId: res.id, label: await labelOf(c, res), detail: changedKeys(row.data, row.live.data).join(", "), before: { slug: row.slug, data: row.data } });
    return c.json(shape(res));
  } catch (e) { if (isConflict(e)) return c.json({ error: "The published slug is now used by another entry." }, 409); throw e; }
});

// Entries that still point at this one (checked through every reference field that targets its collection).
type Use = { id: string; collection: string; slug: string };
async function usedBy(c: { env: Env["Bindings"] }, e: { id: string; collection: string }, limit = 5) {
  const out: Use[] = [];
  // links in other entries' text point at this one by id, in the draft or the published version
  const needle = `cosy:entry/${e.id}`;
  out.push(...await db(c).select({ id: entries.id, collection: entries.collection, slug: entries.slug }).from(entries)
    .where(and(ne(entries.id, e.id), sql`(instr(${entries.data}, ${needle}) > 0 or instr(coalesce(${entries.live}, ''), ${needle}) > 0)`)).limit(limit));
  const defs = await db(c).select().from(blocks);
  for (const col of await db(c).select().from(collections)) for (const f of col.fields) {
    const libs = f.type === "richtext" ? [f.imageLibrary, ...blockLibraries(defs.filter((d) => f.blocks?.includes(d.key)))] : [];
    if (f.type === "richtext" && libs.includes(e.collection)) { // images placed in a body are stored as {"entry":"<id>"}
      const rows = await db(c).select({ id: entries.id, slug: entries.slug }).from(entries)
        .where(and(eq(entries.collection, col.key), ne(entries.id, e.id), sql`(instr(${entries.data}, ${`"entry":"${e.id}"`}) > 0 or instr(coalesce(${entries.live}, ''), ${`"entry":"${e.id}"`}) > 0)`)).limit(limit);
      out.push(...rows.map((r) => ({ ...r, collection: col.key })));
      continue;
    }
    if (f.type !== "reference" || f.collection !== e.collection) continue;
    // the draft and the published version both count: removing this would break whichever still points at it
    const one = (col: typeof entries.data | typeof entries.live, path: string) => f.multiple
      ? sql`exists (select 1 from json_each(json_extract(${col}, ${path})) where value = ${e.id})`
      : sql`json_extract(${col}, ${path}) = ${e.id}`;
    const hit = sql`(${one(entries.data, `$.${f.key}`)} or ${one(entries.live, `$.data.${f.key}`)})`; // field keys are validated as letters and digits only
    const rows = await db(c).select({ id: entries.id, slug: entries.slug }).from(entries).where(and(eq(entries.collection, col.key), ne(entries.id, e.id), hit)).limit(limit);
    out.push(...rows.map((r) => ({ ...r, collection: col.key })));
  }
  return [...new Map(out.map((u) => [u.id, u])).values()];
}

// For the editor's "Used in" list. shortcut: up to 50 per kind of use; a heavily used image shows the first ones.
app.get("/entries/:id/usage", async (c) => {
  const [row] = await db(c).select().from(entries).where(eq(entries.id, c.req.param("id")));
  return row ? c.json({ items: await usedBy(c, row, 50) }) : c.json({ error: "not found" }, 404);
});

app.delete("/entries/:id", async (c) => {
  const [row] = await db(c).select().from(entries).where(eq(entries.id, c.req.param("id")));
  if (row?.live && c.get("user").app) return c.json({ error: "This entry is published. Only a person can take it off the site." }, 403);
  if (row) {
    const users = (await usedBy(c, row)).map((u) => `${u.collection}/${u.slug}`);
    if (users.length) return c.json({ error: `Still used by ${users.join(", ")}. Remove it there first.` }, 409);
    await db(c).delete(entries).where(eq(entries.id, row.id));
    await log(c, { action: "entry.delete", collection: row.collection, entryId: row.id, label: await labelOf(c, row), before: { slug: row.slug, data: row.data } });
  }
  return c.body(null, 204);
});

const Settings = z.object({
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "use owner/name").or(z.literal("")).optional(),
  branch: z.string().optional(),
  dir: z.string().optional(),
  token: z.string().optional(), // omit to keep the stored token
});

// The token is write-only: it is never sent back to the browser.
app.get("/settings", async (c) => {
  const { token, tokenError, ...rest } = await loadGithub(c.env.DB, c.env);
  return c.json({ ...rest, hasToken: !!token || !!tokenError, tokenError });
});

// Tries the saved token and repo, or whatever is typed in the form but not saved yet.
app.post("/settings/check", ownerOnly, async (c) => {
  const body = Settings.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) return c.json(body.error.flatten(), 400);
  const saved = await loadGithub(c.env.DB, c.env);
  if (saved.tokenError && !body.data.token) return c.json({ error: saved.tokenError }, 400);
  const token = body.data.token || saved.token, repo = body.data.repo || saved.repo;
  if (!token || !repo) return c.json({ error: "Add a repository and a token first." }, 400);
  return c.json({ checks: await githubCheck({ token, repo, branch: body.data.branch || saved.branch }) });
});

app.put("/settings", ownerOnly, async (c) => {
  const input = Settings.safeParse(await c.req.json());
  if (!input.success) return c.json(input.error.flatten(), 400);
  try { await saveGithub(c.env.DB, input.data, c.env); } catch (e) { return c.json({ error: (e as Error).message }, 400); }
  await log(c, { action: "settings.save", label: "Deploy target" });
  return c.body(null, 204);
});

app.post("/build", humanOnly, async (c) => c.json(await build(c.env.DB, "github")));

app.post("/publish", humanOnly, async (c) => {
  const { token, tokenError, repo, branch, dir } = await loadGithub(c.env.DB, c.env);
  if (tokenError) return c.json({ error: tokenError }, 500);
  if (!token || !repo) return c.json({ error: "GitHub target not configured — add a repo and token in Settings" }, 400);
  try {
    const r = await publish(c.env.DB, githubTarget({ token, repo, branch, dir }, fetch, r2Store(c.env.BLOBS)));
    await log(c, { action: "deploy", detail: r.changed ? `${r.changed} file${r.changed === 1 ? "" : "s"}` : "nothing new" });
    return c.json(r);
  }
  catch (e) { return c.json({ error: (e as Error).message }, 424); }
});

// What the site's CI did for a commit we pushed (the Deploy dialog polls this).
app.get("/ci", humanOnly, async (c) => {
  const sha = c.req.query("sha") ?? "";
  if (!/^[0-9a-f]{40}$/.test(sha)) return c.json({ error: "sha must be a full commit id" }, 400);
  const { token, tokenError, repo, branch, dir } = await loadGithub(c.env.DB, c.env);
  if (tokenError || !token || !repo) return c.json({ error: tokenError ?? "GitHub target not configured" }, 400);
  try { return c.json(await githubRuns({ token, repo, branch, dir }, sha)); }
  catch (e) {
    const s = (e as { status?: number }).status, why = (e as Error).message.match(/"message":\s*"([^"]*)"/)?.[1];
    return c.json({ error: s === 403 || s === 404 ? `GitHub refused the request${why ? ` (${why})` : ""}. The token needs Actions: read on ${repo}.` : (e as Error).message }, 424);
  }
});

// Sign-in and OAuth routes come first (reachable signed out); everything else under /api needs a session or an access token.
const root = new Hono<Env>();
root.route("/", authRoutes);
root.use("/api/*", requireAuth);
root.route("/", accountRoutes);
root.route("/", app);
root.all("/mcp", (c, next) => (c.req.method === "POST" ? next() : c.body(null, 405, { allow: "POST" })), requireAuth, mcpHandler(root));
export default root;
