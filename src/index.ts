import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { getTableColumns } from "drizzle-orm";
import { and, count, desc, eq, inArray, isNull, like, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { activity, blocks, collections, entries, notifications, schedule, settings, templates } from "./schema";
import { notify, successWanted } from "./notifications";
import { unitsOf } from "./casing";
import { INDEX_VERSION, type Indexable, ftsQuery, rebuild as rebuildAll, reindex, reindexTemplate, searchIndex, unindex, unindexTemplate } from "./search";
import { futureTime, runDue, setJob, type Job } from "./schedule";
import { TemplateDef } from "./templates";
import { changedKeys, historyLimits, logActivity, pruneHistory, type Event } from "./activity";
import { fieldChanges } from "./diff";
import { BlockDef, blockLibraries } from "./blocks";
import { CollectionCreate, CollectionDef, dataSchema, entryLabel, fileFieldOf, nextFreeSlug, shapeChanges, slugBase, type Field } from "./fields";
import { bodyLimit } from "hono/body-limit";
import { githubCheck, githubFailedStep, githubRuns, githubTarget } from "./github";
import { r2Store } from "./blobs";
import { KEY_RE, MAX_IMAGE_BYTES, blobKey, blobUrl, sniffImage } from "./images";
import { docBlockNames, docImageIds, docLinkIds, fillPictures } from "./markdown";
import { sha256 } from "./plan";
import { build, publish } from "./publish";
import { loadGithub, saveGithub } from "./settings";
import { accountRoutes, authRoutes, humanOnly, ownerOnly, requireAuth } from "./auth";
import { mcpHandler } from "./mcp";

type Env = { Bindings: { DB: D1Database; BLOBS: R2Bucket; SETTINGS_KEY?: string; GITHUB_CLIENT_ID?: string; GITHUB_CLIENT_SECRET?: string; GOOGLE_CLIENT_ID?: string; GOOGLE_CLIENT_SECRET?: string; GITHUB_TOKEN?: string; GITHUB_REPO?: string; GITHUB_BRANCH?: string; GITHUB_DIR?: string; TICK_TOKEN?: string }; Variables: { user: { id: string; email: string; role: "owner" | "member"; app?: boolean; via?: string } } };
const app = new Hono<Env>().basePath("/api");

const Input = z.object({
  collection: z.string(),
  slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "lowercase letters, numbers and dashes"),
  data: z.record(z.string(), z.unknown()),
  publishAt: z.iso.datetime().nullish(), // go-live time (collections with dates); absent = leave as is, null = clear
  unpublishAt: z.iso.datetime().nullish(), // the time it comes off the site again; same rules
  keepCase: z.record(z.string(), z.array(z.string())).optional(), // per field, text the person chose to leave as typed (see casing.ts); absent = use what is remembered
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
async function parseEntry(c: { env: Env["Bindings"] }, raw: unknown, creating: boolean, remembered?: Record<string, string[]> | null) {
  const base = Input.safeParse(raw);
  if (!base.success) return { error: base.error.flatten() };
  const [col] = await db(c).select().from(collections).where(eq(collections.key, base.data.collection));
  if (!col) return { error: flat("collection", ["unknown collection"]) };
  // Automatic timestamps are filled in before validation, so a required one never blocks the save.
  const given = { ...base.data.data }, now = new Date().toISOString();
  for (const f of col.fields) if (f.type === "datetime" && f.autoSet && (f.autoSet === "save" || (creating && !given[f.key]))) given[f.key] = now;
  const keep = base.data.keepCase ?? remembered ?? {}, data = dataSchema(col, keep).safeParse(given);
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
  // What is remembered is only what still exists in the entry as typed, so an edited heading is asked about afresh.
  const kept: Record<string, string[]> = {};
  for (const f of col.fields) if ("casing" in f && f.casing) { const u = unitsOf(f.type, given[f.key]), k = (keep[f.key] ?? []).filter((t) => u.includes(t)); if (k.length) kept[f.key] = k; }
  const { keepCase: _, ...rest } = base.data;
  return { value: { ...rest, keepCase: Object.keys(kept).length ? kept : null, data: out as Record<string, unknown> } };
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
  await reindexTemplate(c.env.DB, key, row.body);
  await log(c, { action: "template.save", label: row.label, detail: old ? "changed" : "created" });
  return c.json(row, old ? 200 : 201);
});

app.delete("/templates/:key", ownerOnly, async (c) => {
  const used = await usersOfTemplate(c, c.req.param("key"));
  if (used.length) return c.json({ error: `This template is used by a field of: ${used.join(", ")}. Remove it there first.` }, 409);
  const [gone] = await db(c).delete(templates).where(eq(templates.key, c.req.param("key"))).returning();
  if (gone) { await unindexTemplate(c.env.DB, gone.key); await log(c, { action: "template.delete", label: gone.label }); }
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
  const [row] = await db(c).update(collections).set({ ...input.data, slugSource: input.data.slugSource ?? null, titleField: input.data.titleField ?? null, urlTemplate: input.data.urlTemplate ?? null, thumbField: input.data.thumbField ?? null, dates: input.data.dates ?? false, format: input.data.format ?? null, folder: input.data.folder ?? null, bodyField: input.data.bodyField ?? null, single: input.data.single ?? false, updatedAt: new Date() }).where(eq(collections.key, old.key)).returning();
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

// What is scheduled for each entry, so lists and the editor can show it: when it goes live, and whether the attempt failed.
async function attach<T extends { id: string }>(c: { env: Env["Bindings"] }, items: T[]) {
  const jobs = items.length ? (await db(c).select().from(schedule).where(and(inArray(schedule.kind, ["entry.publish", "entry.unpublish"]), inArray(schedule.ref, items.map((e) => e.id))))).filter((j) => j.status !== "done") : [];
  const pick = (kind: string) => new Map(jobs.filter((j) => j.kind === kind).map((j) => [j.ref, { at: j.runAt.toISOString(), failed: j.status === "failed", error: j.error ?? undefined }]));
  const up = pick("entry.publish"), down = pick("entry.unpublish");
  return items.map((e) => ({ ...e, schedule: up.get(e.id), takeDown: down.get(e.id) }));
}

// Search and "where used" indexes (see search.ts): updated after every write, built on first use.
async function indexEntry(c: { env: Env["Bindings"] }, e: Indexable) {
  const [col] = await db(c).select().from(collections).where(eq(collections.key, e.collection));
  await reindex(c.env.DB, col, e);
}
async function rebuildIndex(c: { env: Env["Bindings"] }) {
  const cols = await db(c).select().from(collections);
  await rebuildAll(c.env.DB, new Map(cols.map((k) => [k.key, k])), await db(c).select().from(entries), await db(c).select().from(templates));
  await db(c).insert(settings).values({ key: "index.ready", value: INDEX_VERSION }).onConflictDoUpdate({ target: settings.key, set: { value: INDEX_VERSION } });
}
async function ensureIndex(c: { env: Env["Bindings"] }) {
  const [r] = await db(c).select().from(settings).where(eq(settings.key, "index.ready"));
  if (r?.value !== INDEX_VERSION) await rebuildIndex(c);
}

/** Keeps the entry's job in step with its go-live time: a draft with a future time is scheduled; a published entry or any other time is not. */
const syncSchedule = async (c: { env: Env["Bindings"] }, e: { id: string; publishAt: Date | null; unpublishAt?: Date | null; live: unknown }) => {
  await setJob(c.env.DB, "entry.publish", e.id, e.live ? null : futureTime(e.publishAt));
  await setJob(c.env.DB, "entry.unpublish", e.id, futureTime(e.unpublishAt)); // runs whether or not it is live yet: a draft that goes live later still comes down
};

// A list row's thumbnail: the storage key of its image, straight from an upload field, or looked up through a reference to an image library.
async function withThumbs(c: { env: Env["Bindings"] }, col: { fields: Field[]; thumbField?: string | null }, rows: Row[]) {
  return attach(c, await thumbsOf(c, col, rows));
}
async function thumbsOf(c: { env: Env["Bindings"] }, col: { fields: Field[]; thumbField?: string | null }, rows: Row[]) {
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
// Search uses the full-text index (slug, tags, text fields and bodies; whole words and word beginnings); sorting by title uses the collection's title field (falling back to the slug), and `relevance` ranks the matches.
app.get("/entries/search", async (c) => {
  const { collection = "", q = "", sort = "updated", dir = "desc", filter = "" } = c.req.query();
  const limit = Math.min(Math.max(parseInt(c.req.query("limit") ?? "") || 25, 1), 100), offset = Math.max(parseInt(c.req.query("offset") ?? "") || 0, 0);
  const [col] = await db(c).select().from(collections).where(eq(collections.key, collection));
  if (!col) return c.json({ error: "unknown collection" }, 400);
  const path = (k: string) => sql`json_extract(${entries.data}, ${`$.${k}`})`; // field keys are validated as letters and digits only
  const fts = ftsQuery(q);
  if (q.trim()) await ensureIndex(c);
  // filter: draft (never published) | edited (draft differs from published) | attention (either) | empty:<field> (nothing filled in)
  const emptyKey = filter.startsWith("empty:") ? filter.slice(6) : "";
  const filtered = filter === "draft" ? eq(entries.status, "draft") : filter === "edited" ? eq(entries.pending, true) : filter === "attention" ? or(eq(entries.status, "draft"), eq(entries.pending, true))
    : filter === "scheduled" ? sql`${entries.id} in (select ref from schedule where kind in ('entry.publish', 'entry.unpublish') and status != 'done')`
    : emptyKey && col.fields.some((f) => f.key === emptyKey) ? sql`coalesce(trim(cast(${path(emptyKey)} as text)), '') in ('', '[]')` : undefined;
  const where = and(eq(entries.collection, collection), filtered, q.trim()
    ? (fts ? sql`${entries.id} in (select d.entry from search join search_doc d on d.id = search.rowid where search match ${fts} and d.collection = ${collection})` : sql`0`) // only punctuation: nothing to match
    : undefined);
  const rank = fts ? sql`(select bm25(search, 10.0, 6.0, 1.0, 3.0) from search join search_doc d on d.id = search.rowid where search match ${fts} and d.entry = ${entries.id})` : sql`${entries.updatedAt}`;
  const key = sort === "relevance" ? rank : sort === "slug" ? sql`${entries.slug}` : sort === "status" ? sql`${entries.status}`
    : sort === "title" ? (col.titleField ? sql`lower(coalesce(nullif(trim(${path(col.titleField)}), ''), ${entries.slug}))` : sql`${entries.slug}`)
    : sql`${entries.updatedAt}`;
  const [{ total }] = await db(c).select({ total: count() }).from(entries).where(where);
  const items = await db(c).select().from(entries).where(where).orderBy(sort === "relevance" ? sql`${key} asc` : dir === "asc" ? sql`${key} asc` : sql`${key} desc`, entries.id).limit(limit).offset(offset); // bm25 is lower for better matches
  return c.json({ items: await withThumbs(c, col, items), total });
});

// Rows from any collections, shaped like the list's (thumbnail, schedule), in the order given.
async function shapeMixed(c: { env: Env["Bindings"] }, rows: Row[]) {
  const cols = await db(c).select().from(collections), by = new Map<string, Row[]>();
  for (const r of rows) by.set(r.collection, [...(by.get(r.collection) ?? []), r]);
  const shaped = new Map((await Promise.all([...by].map(([k, rs]) => withThumbs(c, cols.find((x) => x.key === k) ?? { fields: [] }, rs)))).flat().map((e) => [e.id, e]));
  return rows.flatMap((r) => (shaped.has(r.id) ? [shaped.get(r.id)!] : []));
}

// The latest changes across every collection (the Overview page).
app.get("/entries/recent", async (c) => {
  const limit = Math.min(Math.max(parseInt(c.req.query("limit") ?? "") || 10, 1), 50);
  return c.json({ items: await shapeMixed(c, await db(c).select().from(entries).orderBy(desc(entries.updatedAt)).limit(limit)) });
});

// Full-text search over every entry's draft, bodies included, best matches first. `match` carries the matched words marked with \u0001 \u0002.
app.get("/search", async (c) => {
  await ensureIndex(c);
  const limit = Math.min(Math.max(parseInt(c.req.query("limit") ?? "") || 20, 1), 50);
  const libraries = (await db(c).select().from(collections)).filter((k) => fileFieldOf(k)).map((k) => k.key);
  const r = await searchIndex(c.env.DB, c.req.query("q") ?? "", limit, libraries);
  const rows = r.hits.length ? await db(c).select().from(entries).where(inArray(entries.id, r.hits.map((h) => h.entry))) : [];
  const order = new Map(r.hits.map((h, i) => [h.entry, i]));
  const items = await shapeMixed(c, rows.sort((a, b) => order.get(a.id)! - order.get(b.id)!));
  return c.json({ total: r.total, items: items.map((e) => ({ ...e, match: { title: r.hits[order.get(e.id)!].title, snippet: r.hits[order.get(e.id)!].snip } })) });
});
app.get("/search/status", ownerOnly, async (c) => {
  await ensureIndex(c);
  const n = (t: string) => c.env.DB.prepare(`select count(*) n from ${t}`).first<{ n: number }>().then((r) => r?.n ?? 0);
  return c.json({ entries: await n("entries"), indexed: await n("search_doc"), links: await n("refs") });
});
app.get("/backup/status", ownerOnly, async (c) => {
  const [r] = await db(c).select().from(settings).where(eq(settings.key, "backup.last"));
  return c.json({ last: r ? (JSON.parse(r.value) as { at: string; detail: string }) : null });
});
app.post("/search/rebuild", ownerOnly, async (c) => { await rebuildIndex(c); return c.body(null, 204); });

// Sidebar badges: what still needs a person's attention in each collection (never published, or edited since).
app.get("/entries/counts", async (c) => {
  const rows = await db(c).select({ collection: entries.collection, drafts: sql<number>`sum(${entries.status} = 'draft')`, edited: sql<number>`sum(${entries.pending})` }).from(entries).groupBy(entries.collection);
  return c.json(Object.fromEntries(rows.map((r) => [r.collection, { drafts: r.drafts, edited: r.edited }])));
});

// The history: newest first, everyone signed in can read it. ?entry=<id> narrows it to one entry.
app.get("/activity", async (c) => {
  const entry = c.req.query("entry"), limit = Math.min(Math.max(parseInt(c.req.query("limit") ?? "") || 50, 1), 100), offset = Math.max(parseInt(c.req.query("offset") ?? "") || 0, 0);
  const where = entry ? eq(activity.entryId, entry) : c.req.query("scheduled") ? like(activity.detail, "%(scheduled)%") : undefined; // scheduled: only what the scheduler did
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
    await indexEntry(c, res);
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
  // `live` (the published version) only on request: the editor compares against it, while agents reading an entry don't need it twice.
  return row ? c.json((await attach(c, [c.req.query("live") ? { ...shape(row), live: row.live } : shape(row)]))[0]) : c.json({ error: "not found" }, 404);
});

app.post("/entries", async (c) => {
  const input = await parseEntry(c, await c.req.json(), true);
  if (!input.value) return c.json(input.error, 400);
  const [col] = await db(c).select({ single: collections.single, dates: collections.dates }).from(collections).where(eq(collections.key, input.value.collection));
  const row = { ...input.value, id: crypto.randomUUID(), updatedAt: new Date(), publishAt: col?.dates && input.value.publishAt ? new Date(input.value.publishAt) : null, unpublishAt: col?.dates && input.value.unpublishAt ? new Date(input.value.unpublishAt) : null };
  if (col?.single && (await db(c).select({ n: count() }).from(entries).where(eq(entries.collection, row.collection)))[0].n) return c.json({ error: "This collection holds a single entry. Edit that one instead." }, 409);
  try { await db(c).insert(entries).values(row); }
  catch (e) { if (isConflict(e)) return c.json({ error: "slug already exists in this collection" }, 409); throw e; }
  await log(c, { action: "entry.create", collection: row.collection, entryId: row.id, label: await labelOf(c, row) });
  await syncSchedule(c, { ...row, live: null });
  await indexEntry(c, { ...row, live: null });
  return c.json((await attach(c, [shape({ ...row, status: "draft", live: null, pending: false, publishedAt: null, revisedAt: null })]))[0], 201);
});

app.put("/entries/:id", async (c) => {
  const [old] = await db(c).select().from(entries).where(eq(entries.id, c.req.param("id")));
  if (!old) return c.json({ error: "not found" }, 404);
  const input = await parseEntry(c, await c.req.json(), false, old.keepCase);
  if (!input.value) return c.json(input.error, 400);
  const [col] = await db(c).select({ dates: collections.dates }).from(collections).where(eq(collections.key, old.collection));
  const given = input.value.publishAt, publishAt = !col?.dates ? null : given === undefined ? old.publishAt : given ? new Date(given) : null;
  if (old.live && publishAt?.getTime() !== old.publishAt?.getTime()) return c.json({ error: "The go-live time is locked while the entry is published. Unpublish it first to change it." }, 409);
  const givenOff = input.value.unpublishAt, unpublishAt = !col?.dates ? null : givenOff === undefined ? old.unpublishAt : givenOff ? new Date(givenOff) : null;
  if (publishAt && unpublishAt && unpublishAt <= publishAt) return c.json({ error: "The take-down time must be after the go-live time." }, 400);
  const row = { ...input.value, publishAt, unpublishAt, updatedAt: new Date(), pending: differs(old.live, input.value.slug, input.value.data) };
  try {
    const [res] = await db(c).update(entries).set(row).where(eq(entries.id, old.id)).returning();
    const changed = [...(old.slug !== res.slug ? ["slug"] : []), ...changedKeys(old.data, res.data)];
    if (changed.length) await log(c, { action: "entry.save", collection: res.collection, entryId: res.id, label: await labelOf(c, res), detail: changed.join(", "), before: { slug: old.slug, data: old.data } });
    await syncSchedule(c, res);
    await indexEntry(c, res);
    return c.json((await attach(c, [shape(res)]))[0]);
  } catch (e) { if (isConflict(e)) return c.json({ error: "slug already exists in this collection" }, 409); throw e; }
});

// Publishing is a separate step from saving: it copies the working draft to `live`, which is what the site gets. Both re-check the draft
// first (a file or an entry it points at may have gone since it was saved).
async function publishRow(c: { env: Env["Bindings"] }, row: Row, who: { email: string; via?: string }, via = "") {
  const now = new Date();
  if (row.publishAt && row.publishAt > now) return { error: { error: `This entry is set to go live ${row.publishAt.toISOString().replace("T", " ").slice(0, 16)} UTC, so it can't be published yet. It publishes itself then; to publish now, set the go-live time to now or clear it.` } };
  const ok = await parseEntry(c, { collection: row.collection, slug: row.slug, data: row.data }, false);
  if (!ok.value) return { error: ok.error };
  const [res] = await db(c).update(entries).set({ live: { slug: row.slug, data: ok.value.data }, status: "published", pending: false, publishedAt: row.publishedAt ?? row.publishAt ?? now, revisedAt: now }).where(eq(entries.id, row.id)).returning();
  await indexEntry(c, res); // the published version counts as a use of what it points at
  await logActivity(c.env.DB, who, { action: "entry.publish", collection: res.collection, entryId: res.id, label: await labelOf(c, res), detail: (row.live ? "changes" : "first time") + via });
  return { res };
}

app.post("/entries/:id/publish", humanOnly, async (c) => {
  const [row] = await db(c).select().from(entries).where(eq(entries.id, c.req.param("id")));
  if (!row) return c.json({ error: "not found" }, 404);
  const r = await publishRow(c, row, { email: c.get("user").email, via: c.get("user").via });
  return r.res ? c.json((await attach(c, [shape(r.res)]))[0]) : c.json(r.error, 400);
});

// Takes it off the site at the next deploy; the draft stays.
type Ctx = Parameters<typeof log>[0];
async function unpublishRow(c: Ctx, id: string) {
  const [res] = await db(c).update(entries).set({ live: null, status: "draft", pending: false }).where(eq(entries.id, id)).returning();
  if (!res) return null;
  // A go-live time that has passed is spent; left in place, the picker would offer that old date and a new time on it would still be in the past.
  if (res.publishAt && res.publishAt <= new Date()) { await db(c).update(entries).set({ publishAt: null }).where(eq(entries.id, id)); res.publishAt = null; }
  await log(c, { action: "entry.unpublish", collection: res.collection, entryId: res.id, label: await labelOf(c, res) });
  await syncSchedule(c, res); // a draft with a future go-live time is scheduled again
  await indexEntry(c, res);
  return res;
}
app.post("/entries/:id/unpublish", humanOnly, async (c) => {
  const res = await unpublishRow(c, c.req.param("id"));
  return res ? c.json((await attach(c, [shape(res)]))[0]) : c.json({ error: "not found" }, 404);
});

// Many entries at once (the list's selection). Each one is done on its own, so one that can't be (still used, bad data) doesn't stop the rest.
app.post("/entries/bulk", humanOnly, async (c) => {
  const b = z.object({ ids: z.array(z.string()).min(1).max(200), action: z.enum(["publish", "unpublish", "delete"]) }).safeParse(await c.req.json().catch(() => null));
  if (!b.success) return c.json(b.error.flatten(), 400);
  const rows = await db(c).select().from(entries).where(inArray(entries.id, b.data.ids));
  const who = { email: c.get("user").email, via: c.get("user").via };
  let done = 0;
  const failed: { id: string; label: string; error: string }[] = [];
  for (const row of rows) {
    let error = "";
    if (b.data.action === "publish") {
      const r = row.live && !row.pending ? null : await publishRow(c, row, who, " (bulk)");
      if (r?.error) error = "error" in r.error && typeof r.error.error === "string" ? r.error.error : "Its fields need fixing first. Open it to see what.";
    }
    else if (b.data.action === "unpublish") await unpublishRow(c, row.id);
    else error = (await deleteRow(c, row)) ?? "";
    if (error) failed.push({ id: row.id, label: await labelOf(c, row), error }); else done++;
  }
  return c.json({ done, failed });
});

// Throws the draft away and goes back to the published version.
app.post("/entries/:id/revert", async (c) => {
  const [row] = await db(c).select().from(entries).where(eq(entries.id, c.req.param("id")));
  if (!row?.live) return c.json({ error: row ? "There is no published version to go back to." : "not found" }, row ? 400 : 404);
  try {
    const [res] = await db(c).update(entries).set({ slug: row.live.slug, data: row.live.data, pending: false, updatedAt: new Date() }).where(eq(entries.id, row.id)).returning();
    await indexEntry(c, res);
    await log(c, { action: "entry.revert", collection: res.collection, entryId: res.id, label: await labelOf(c, res), detail: changedKeys(row.data, row.live.data).join(", "), before: { slug: row.slug, data: row.data } });
    return c.json(shape(res));
  } catch (e) { if (isConflict(e)) return c.json({ error: "The published slug is now used by another entry." }, 409); throw e; }
});

// The values a select field already holds across the collection, most used first: what a tag input suggests, and what the collection editor can add to the options.
app.get("/collections/:key/values/:field", async (c) => {
  const [col] = await db(c).select().from(collections).where(eq(collections.key, c.req.param("key")));
  const f = col?.fields.find((x) => x.key === c.req.param("field"));
  if (!col || f?.type !== "select") return c.json({ error: "not a select field" }, 404);
  const { results } = await c.env.DB.prepare("select value v, count(*) n from entries, json_each(entries.data, ?) where collection = ? and typeof(value) = 'text' and value != '' group by value order by n desc, v limit 500").bind(`$.${f.key}`, col.key).all<{ v: string }>();
  return c.json(results.map((r) => r.v));
});

// Entries that still point at this one (checked through every reference field that targets its collection).
type Use = { id: string; collection: string; slug: string };
async function usedBy(c: { env: Env["Bindings"] }, e: { id: string }, limit = 5): Promise<Use[]> {
  await ensureIndex(c);
  const { results } = await c.env.DB.prepare("select e.id, e.collection, e.slug from refs r join entries e on e.id = r.src where r.dst = ? order by e.updatedAt desc limit ?").bind(e.id, limit).all<Use>();
  return results;
}

// A manual, owner-only scan: which entries of a collection nothing points at. It reads every entry once and collects each id that appears
// anywhere (reference fields, images and links in text, blocks, templates, draft or published), so it is heavy and only runs when asked.
// shortcut: returns the 200 most recently updated; a person clears those and scans again.
app.post("/collections/:key/unused", ownerOnly, async (c) => {
  const [col] = await db(c).select().from(collections).where(eq(collections.key, c.req.param("key")));
  if (!col) return c.json({ error: "unknown collection" }, 404);
  await ensureIndex(c);
  const all = await db(c).select().from(entries).where(eq(entries.collection, col.key)).orderBy(desc(entries.updatedAt));
  const used = new Set((await c.env.DB.prepare("select distinct dst from refs").all<{ dst: string }>()).results.map((r) => r.dst));
  const unused = all.filter((e) => !used.has(e.id));
  return c.json({ items: await withThumbs(c, col, unused.slice(0, 200)), total: unused.length, scanned: all.length });
});

/** Entries that point at this one, with their display title (title field, else slug), split by how: `used` (a reference field, an image, a block) and `linked` (a hyperlink in text, written "cosy:entry/<id>"). One entry can be both. */
async function pointingAt(c: { env: Env["Bindings"] }, id: string) {
  const rows = await usedBy(c, { id }, 50);
  if (!rows.length) return { items: [], links: [] };
  const full = new Map((await db(c).select().from(entries).where(inArray(entries.id, rows.map((r) => r.id)))).map((e) => [e.id, e]));
  const cols = new Map((await db(c).select().from(collections)).map((k) => [k.key, k]));
  const items: (Use & { title: string })[] = [], links: (Use & { title: string })[] = [];
  for (const r of rows) {
    const e = full.get(r.id), col = cols.get(r.collection);
    const row = { ...r, title: e && col ? entryLabel(col.fields, e.data, e.slug, col.titleField) : r.slug };
    const json = e ? JSON.stringify([e.data, e.live?.data]) : "", link = `cosy:entry/${id}`;
    if (json.includes(link)) links.push(row);
    if (!e || json.replaceAll(link, "").includes(id)) items.push(row);
  }
  return { items, links };
}

// For the editor: "Used in" (referenced by a field, image or block) and "Linked to" (hyperlinked from text). shortcut: up to 50 sources in all; a heavily used image shows the first ones.
app.get("/entries/:id/usage", async (c) => {
  const [row] = await db(c).select().from(entries).where(eq(entries.id, c.req.param("id")));
  return row ? c.json(await pointingAt(c, row.id)) : c.json({ error: "not found" }, 404);
});

/** Deletes an entry unless something still points at it; a message says why not. The copy in the history is what the trash restores. */
async function deleteRow(c: Ctx, row: Row): Promise<string | null> {
  const users = (await usedBy(c, row)).map((u) => `${u.collection}/${u.slug}`);
  if (users.length) return `Still used by ${users.join(", ")}. Remove it there first.`;
  await db(c).delete(entries).where(eq(entries.id, row.id));
  await db(c).delete(schedule).where(eq(schedule.ref, row.id));
  await unindex(c.env.DB, row.id);
  await log(c, { action: "entry.delete", collection: row.collection, entryId: row.id, label: await labelOf(c, row), before: { slug: row.slug, data: row.data } });
  return null;
}

app.delete("/entries/:id", async (c) => {
  const [row] = await db(c).select().from(entries).where(eq(entries.id, c.req.param("id")));
  if (row?.live && c.get("user").app) return c.json({ error: "This entry is published. Only a person can take it off the site." }, 403);
  const why = row ? await deleteRow(c, row) : null;
  return why ? c.json({ error: why }, 409) : c.body(null, 204);
});

// Deleted entries still in the trash: the delete's saved copy exists and nothing has taken the entry's place. Restoring is the activity undo.
app.get("/trash", async (c) => {
  const { trashDays } = await historyLimits(c.env.DB);
  await pruneHistory(c.env.DB);
  const { results } = await c.env.DB.prepare("select a.id, a.at, a.actor, a.collection, a.label, a.entryId from activity a where a.action = 'entry.delete' and a.before is not null and not exists (select 1 from entries e where e.id = a.entryId) order by a.at desc limit 200").all();
  return c.json({ items: results, days: trashDays });
});

// What restoring a saved version would change in the entry as it is now (everything, for a deleted entry).
app.get("/activity/:id/changes", async (c) => {
  const [a] = await db(c).select().from(activity).where(eq(activity.id, c.req.param("id")));
  if (!a?.before || !a.entryId || !a.collection) return c.json({ error: "No saved copy of that version." }, 404);
  const [col] = await db(c).select().from(collections).where(eq(collections.key, a.collection));
  const [cur] = await db(c).select().from(entries).where(eq(entries.id, a.entryId));
  const changes = col ? fieldChanges(col.fields, cur?.data ?? {}, a.before.data) : [];
  return c.json({ changes, slug: cur && cur.slug !== a.before.slug ? { from: cur.slug, to: a.before.slug } : null, gone: !cur });
});

// History settings: how many saved versions each entry keeps, and how long a deleted entry stays in the trash.
app.get("/settings/history", ownerOnly, async (c) => c.json(await historyLimits(c.env.DB)));
app.put("/settings/history", ownerOnly, async (c) => {
  const b = z.object({ keep: z.number().int().min(1).max(500), trashDays: z.number().int().min(0).max(3650) }).safeParse(await c.req.json().catch(() => null));
  if (!b.success) return c.json(b.error.flatten(), 400);
  for (const [k, v] of [["history.keep", b.data.keep], ["history.trashDays", b.data.trashDays]] as const)
    await db(c).insert(settings).values({ key: k, value: String(v) }).onConflictDoUpdate({ target: settings.key, set: { value: String(v) } });
  await pruneHistory(c.env.DB);
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
    if (r.ref) await watchBuild(c.env.DB, r.ref);
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

// Notifications: newest first, with how many are unread. Dismissing deletes; reading keeps them in the list.
app.get("/notifications", humanOnly, async (c) => {
  const items = await db(c).select().from(notifications).orderBy(desc(notifications.at)).limit(100);
  const [{ n }] = await db(c).select({ n: count() }).from(notifications).where(isNull(notifications.readAt));
  return c.json({ items, unread: n });
});
app.post("/notifications/read", humanOnly, async (c) => { await db(c).update(notifications).set({ readAt: new Date() }).where(isNull(notifications.readAt)); return c.body(null, 204); });
app.post("/notifications/:id/read", humanOnly, async (c) => { await db(c).update(notifications).set({ readAt: new Date() }).where(eq(notifications.id, c.req.param("id"))); return c.body(null, 204); });
app.delete("/notifications/:id", humanOnly, async (c) => { await db(c).delete(notifications).where(eq(notifications.id, c.req.param("id"))); return c.body(null, 204); });
app.get("/settings/notifications", humanOnly, async (c) => c.json({ success: await successWanted(c.env.DB) }));
app.put("/settings/notifications", ownerOnly, async (c) => {
  const { success } = z.object({ success: z.boolean() }).parse(await c.req.json());
  await db(c).insert(settings).values({ key: "notify.success", value: success ? "1" : "0" }).onConflictDoUpdate({ target: settings.key, set: { value: success ? "1" : "0" } });
  return c.body(null, 204);
});

// Scheduled work. entry.publish publishes the entry's latest draft at its go-live time and asks for a deploy; deploy.run sends what is published to the site.
// Several publishes in one tick share one deploy, and a failed deploy is retried like any other job.
const SCHEDULER = { email: "scheduler" };
const handlers = (env: Env["Bindings"]) => ({
  "entry.publish": async (job: Job) => {
    const [row] = await db({ env }).select().from(entries).where(eq(entries.id, job.ref));
    // The entry or its go-live time changed since: the job no longer applies, so drop it.
    if (!row || !row.publishAt || row.publishAt > job.runAt) { await setJob(env.DB, job.kind, job.ref, null); return; } // (a retry runs later than the go-live time, which is fine)
    const r = await publishRow({ env }, row, SCHEDULER, " (scheduled)");
    if (!r.res) { const e = r.error as { error?: string; formErrors?: string[]; fieldErrors?: Record<string, string[]> }; throw new Error([...(e.error ? [e.error] : []), ...(e.formErrors ?? []), ...Object.values(e.fieldErrors ?? {}).flat()].join("; ") || "The entry no longer validates."); }
    // Queue a deploy of just the entries published this way, so anything else you are holding back stays held back.
    const [d] = await db({ env }).select().from(schedule).where(and(eq(schedule.kind, "deploy.run"), eq(schedule.ref, "site")));
    await setJob(env.DB, "deploy.run", "site", new Date(), [...new Set([...(d && d.status !== "done" ? d.payload ?? [] : []), row.id])]);
  },
  "entry.unpublish": async (job: Job) => {
    const [row] = await db({ env }).select().from(entries).where(eq(entries.id, job.ref));
    if (!row || !row.unpublishAt || row.unpublishAt > job.runAt) { await setJob(env.DB, job.kind, job.ref, null); return; } // changed since: no longer applies
    if (row.live) {
      const [res] = await db({ env }).update(entries).set({ live: null, status: "draft", pending: false }).where(eq(entries.id, row.id)).returning();
      await logActivity(env.DB, SCHEDULER, { action: "entry.unpublish", collection: res.collection, entryId: res.id, label: await labelOf({ env }, res), detail: "(scheduled)" });
      await indexEntry({ env }, res);
      const [d] = await db({ env }).select().from(schedule).where(and(eq(schedule.kind, "deploy.run"), eq(schedule.ref, "site")));
      await setJob(env.DB, "deploy.run", "site", new Date(), [...new Set([...(d && d.status !== "done" ? d.payload ?? [] : []), row.id])]);
    }
    await db({ env }).update(entries).set({ unpublishAt: null }).where(eq(entries.id, row.id)); // done; the time is spent
  },
  "deploy.run": async (job: Job) => {
    const { token, tokenError, repo, branch, dir } = await loadGithub(env.DB, env);
    if (tokenError || !token || !repo) throw new Error(tokenError ?? "GitHub target not configured");
    const r = await publish(env.DB, githubTarget({ token, repo, branch, dir }, fetch, r2Store(env.BLOBS)), job.payload ?? []);
    await logActivity(env.DB, SCHEDULER, { action: "deploy", detail: r.changed ? `${r.changed} file${r.changed === 1 ? "" : "s"} (scheduled)` : "nothing new" });
    if (r.ref) await watchBuild(env.DB, r.ref);
  },
  // Reports come from the server's cron job; if none arrives for a day and a half, that is worth knowing. Runs every few hours once a report has been seen.
  "backup.check": async (job: Job) => {
    const [r] = await db({ env }).select().from(settings).where(eq(settings.key, "backup.last"));
    const last = r ? Date.parse(JSON.parse(r.value).at) : 0, hours = (Date.now() - last) / 3600_000;
    if (!last || hours > 36) await notify(env.DB, { kind: "backup", ref: "stale", level: "error", title: "No recent backup", body: last ? `The last good backup was ${Math.round(hours)} hours ago. Check the server's cron job (scripts/backup.sh).` : "No successful backup has been reported yet. Check the server's cron job (scripts/backup.sh).", link: "#/settings/backups" });
    await setJob(env.DB, job.kind, job.ref, new Date(Date.now() + 6 * 3600_000));
  },
  // Follows the site's build for one deploy until it finishes, then records the result. Polls about once a minute (a tick is a minute apart).
  "ci.check": async (job: Job) => {
    const { token, repo, branch, dir } = await loadGithub(env.DB, env);
    if (!token || !repo) return;
    const o = { token, repo, branch, dir }, age = Date.now() - (Date.parse(job.payload?.[0] ?? "") || Date.now()), short = job.ref.slice(0, 7);
    let st;
    try { st = await githubRuns(o, job.ref); }
    catch (e) {
      const s = (e as { status?: number }).status;
      if (s !== 403 && s !== 404) throw e;
      await notify(env.DB, { kind: "ci-access", ref: "token", level: "error", title: "Can't check the site build", body: `GitHub refused the request. The token needs Actions: read on ${repo}. Settings > Deploy has a Check access button.`, link: "#/settings" });
      return;
    }
    if (st.state === "running" || (st.state === "none" && age < 3 * 60_000)) { // not finished, or the run hasn't appeared yet
      if (age > 30 * 60_000) await notify(env.DB, { kind: "ci", ref: job.ref, level: "error", title: "Site build didn't finish", body: `Deploy ${short} was still running after 30 minutes.`, link: `https://github.com/${repo}/commit/${job.ref}` });
      else await setJob(env.DB, job.kind, job.ref, new Date(Date.now() + 45_000), job.payload);
      return;
    }
    if (st.state === "none") return; // the repository builds nothing on a push: nothing to report
    const run = st.runs.find((r) => r.state === "failed") ?? st.runs[0];
    if (st.state === "failed") {
      const step = await githubFailedStep(o, run.id).catch(() => undefined);
      await notify(env.DB, { kind: "ci", ref: job.ref, level: "error", title: "Site build failed", body: `Deploy ${short}${step ? `: ${step} failed` : ""}.`, link: run.url });
    } else {
      await db({ env }).update(notifications).set({ readAt: new Date() }).where(and(eq(notifications.kind, "ci"), eq(notifications.level, "error"), isNull(notifications.readAt))); // a passing build clears earlier failures
      if (await successWanted(env.DB)) await notify(env.DB, { kind: "ci", ref: job.ref, level: "success", title: "Site build passed", body: `Deploy ${short}.`, link: run.url });
    }
  },
});

/** After a deploy, follow its build (see ci.check). */
const watchBuild = (d1: D1Database, sha: string) => setJob(d1, "ci.check", sha, new Date(Date.now() + 20_000), [new Date().toISOString()]);
/** One tick: run what is due, then once more for the jobs that first pass queued (the deploy after a publish). */
export async function tick(env: Env["Bindings"]) {
  const h = handlers(env), failed = async (job: Job, error: string) => {
    const [e] = job.kind === "entry.publish" || job.kind === "entry.unpublish" ? await db({ env }).select().from(entries).where(eq(entries.id, job.ref)) : [];
    await notify(env.DB, { kind: "job", ref: job.id, level: "error", title: e ? `Scheduled ${job.kind === "entry.unpublish" ? "unpublish" : "publish"} failed: ${await labelOf({ env }, e)}` : job.kind === "deploy.run" ? "Scheduled deploy failed" : `${job.kind} failed`, body: error, link: e ? `#/${e.collection}/${e.id}` : undefined });
  };
  const a = await runDue(env.DB, h, Date.now(), failed), b = await runDue(env.DB, h, Date.now(), failed);
  if (new Date().getMinutes() === 0) await pruneHistory(env.DB).catch(() => {}); // hourly: copies past the history limits
  return { ran: a.ran + b.ran, ok: a.ok + b.ok };
}

// Jobs that are waiting or failed, for the Activity page.
// Everyone can see what is coming for entries; the system's own jobs (deploys, checks) are for owners.
app.get("/schedule", async (c) => {
  const owner = c.get("user").role === "owner";
  const jobs = await db(c).select().from(schedule).where(and(ne(schedule.status, "done"), owner ? undefined : like(schedule.kind, "entry.%"))).orderBy(schedule.runAt).limit(100);
  const rows = await db(c).select({ id: entries.id, collection: entries.collection, slug: entries.slug, data: entries.data }).from(entries).where(inArray(entries.id, jobs.map((j) => j.ref)));
  const by = new Map(rows.map((r) => [r.id, r]));
  return c.json(await Promise.all(jobs.map(async (j) => { const e = by.get(j.ref); return { kind: j.kind, at: j.runAt.toISOString(), status: j.status, error: j.error, entry: e && { id: e.id, collection: e.collection, label: await labelOf(c, e) } }; })));
});

// Sign-in and OAuth routes come first (reachable signed out); everything else under /api needs a session or an access token.
const root = new Hono<Env>();
root.route("/", authRoutes);
// Scripts on the server (not signed-in people) call these with the TICK_TOKEN: the scheduler's tick every minute, and the backup script's report.
const automationDenied = (c: { env: Env["Bindings"]; req: { header(n: string): string | undefined }; json(b: unknown, s: 404 | 401): Response }) => {
  const want = c.env.TICK_TOKEN, got = c.req.header("authorization")?.replace(/^Bearer /, "") ?? "";
  if (!want) return c.json({ error: "not found" }, 404);
  if (got.length !== want.length || [...want].reduce((d, ch, i) => d | (ch.charCodeAt(0) ^ got.charCodeAt(i)), 0)) return c.json({ error: "unauthorized" }, 401);
  return null;
};
root.post("/api/tick", async (c) => automationDenied(c) ?? c.json(await tick(c.env)));
root.post("/api/backup/report", async (c) => {
  const denied = automationDenied(c);
  if (denied) return denied;
  const b = z.object({ ok: z.boolean(), detail: z.string().max(300).optional() }).safeParse(await c.req.json().catch(() => null));
  if (!b.success) return c.json({ error: "expected { ok, detail? }" }, 400);
  const d = db({ env: c.env });
  if (b.data.ok) {
    const v = JSON.stringify({ at: new Date().toISOString(), detail: b.data.detail ?? "" });
    await d.insert(settings).values({ key: "backup.last", value: v }).onConflictDoUpdate({ target: settings.key, set: { value: v } });
    await d.update(notifications).set({ readAt: new Date() }).where(and(eq(notifications.kind, "backup"), isNull(notifications.readAt))); // a good backup clears a failure or a "no backup" notice
  } else await notify(c.env.DB, { kind: "backup", ref: "failed", level: "error", title: "Backup failed", body: b.data.detail ?? "The backup script reported a failure.", link: "#/settings/backups" });
  await setJob(c.env.DB, "backup.check", "daily", new Date(Date.now() + 6 * 3600_000)); // from the first report on, notice if they stop coming
  return c.body(null, 204);
});
root.use("/api/*", requireAuth);
root.route("/", accountRoutes);
root.route("/", app);
root.all("/mcp", (c, next) => (c.req.method === "POST" ? next() : c.body(null, 405, { allow: "POST" })), requireAuth, mcpHandler(root));
export default {
  fetch: (req: Request, env: Env["Bindings"], ctx: ExecutionContext) => root.fetch(req, env, ctx),
  // Cloudflare's cron trigger (see wrangler.jsonc): the same tick the Docker setup reaches through /api/tick.
  scheduled: (_: ScheduledController, env: Env["Bindings"], ctx: ExecutionContext) => { ctx.waitUntil(tick(env)); },
};
