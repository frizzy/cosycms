import { drizzle } from "drizzle-orm/d1";
import { and, eq, inArray } from "drizzle-orm";
import { blocks, collections, entries, publishState } from "./schema";
import { draftWarnings, plan, type RenderCtx } from "./plan";
import type { Change, Target } from "./targets";

// shortcut: Workers cap the work done per request, so images go in batches; the rest follow on the next publish.
const MAX_IMAGES_PER_PUBLISH = 20;

/** Renders everything published and compares it with what the target last received. Nothing is sent or recorded. */
async function prepare(d1: D1Database, targetName: string) {
  const db = drizzle(d1);
  const [all, cols, state, defs] = await Promise.all([
    db.select().from(entries),
    db.select().from(collections),
    db.select().from(publishState).where(eq(publishState.target, targetName)),
    db.select().from(blocks),
  ]);
  // The site gets each entry's published version (`live`), never its working draft.
  // Entries whose go-live time is still ahead stay off the site, even if published.
  // In collections with dates the file also carries publishedAt and revisedAt.
  const dated = new Set(cols.filter((c) => c.dates).map((c) => c.key)), now = new Date();
  const dates = (e: (typeof all)[number]) => (dated.has(e.collection) ? { ...(e.publishedAt ? { publishedAt: e.publishedAt.toISOString() } : {}), ...(e.revisedAt ? { revisedAt: e.revisedAt.toISOString() } : {}) } : {});
  const rows = all.flatMap((e) => (e.live && !(dated.has(e.collection) && e.publishAt && e.publishAt > now) ? [{ ...e, slug: e.live.slug, data: { ...e.live.data, ...dates(e) } }] : []));
  const ctx: RenderCtx = { collections: new Map(cols.map((c) => [c.key, { fields: c.fields, format: c.format, bodyField: c.bodyField, folder: c.folder, urlTemplate: c.urlTemplate, dates: c.dates }])), entries: new Map(all.map((e) => [e.id, { collection: e.collection, slug: e.live?.slug ?? e.slug, data: e.live?.data ?? e.data }])), blocks: new Map(defs.map((d) => [d.key, d])) };
  const planned = await plan(rows, state, ctx);
  return { db, planned, warnings: draftWarnings(rows, new Map(all.map((e) => [e.id, e])), ctx) };
}

const conflictError = (conflicts: string[]) => `Two files would be published to the same place (${conflicts.slice(0, 3).join(", ")}). Change a slug, folder or file name so each path is used once.`;
const isImage = (c: Change): c is Extract<Change, { file: string }> => c.type === "upsert" && "file" in c;

/** The build step: what a deploy would send right now, with references already resolved into the files. Changes nothing. */
export async function build(d1: D1Database, targetName: string) {
  const { planned, warnings } = await prepare(d1, targetName);
  const ch = planned.changes, SHOWN = 200;
  return {
    pages: ch.filter((c) => c.type === "upsert" && !isImage(c)).length, images: ch.filter(isImage).length, removed: ch.filter((c) => c.type === "delete").length,
    paths: ch.slice(0, SHOWN).map((c) => ({ type: isImage(c) ? "image" : c.type === "delete" ? "delete" : "page", path: c.path })), more: Math.max(0, ch.length - SHOWN),
    warnings, conflicts: planned.conflicts, error: planned.conflicts.length ? conflictError(planned.conflicts) : undefined,
  };
}

/** Sends what is published. With `only`, just those entries (and their files): everything else, held back or not, stays as the site has it. */
export async function publish(d1: D1Database, target: Target, only?: string[]) {
  const { db, planned: all, warnings } = await prepare(d1, target.name);
  const mine = (id: string) => !only || only.includes(id.split("#")[0]); // a file's id is "<entry id>#<field>"
  const planned = { ...all, changes: all.changes.filter((c) => mine(c.id)), upserts: all.upserts.filter((u) => mine(u.entryId)), removed: all.removed.filter(mine) };
  if (planned.conflicts.length) throw new Error(conflictError(planned.conflicts));
  if (!planned.changes.length) return { changed: 0, warnings };

  // Send everything except the images beyond this batch; those stay unrecorded and go out next time.
  const images = planned.changes.filter(isImage), later = new Set(images.slice(MAX_IMAGES_PER_PUBLISH));
  const changes = planned.changes.filter((c) => !(isImage(c) && later.has(c)));
  const laterIds = new Set([...later].map((c) => c.id));
  const upserts = planned.upserts.filter((u) => !laterIds.has(u.entryId)), removed = planned.removed;
  const ref = await target.publish(changes);

  // If this fails after a successful push, the next publish re-sends the same content (idempotent).
  const writes = [
    ...upserts.map((s) =>
      db.insert(publishState).values({ target: target.name, ...s, ref })
        .onConflictDoUpdate({ target: [publishState.target, publishState.entryId], set: { path: s.path, hash: s.hash, ref } })),
    ...(removed.length ? [db.delete(publishState).where(and(eq(publishState.target, target.name), inArray(publishState.entryId, removed)))] : []),
  ];
  if (writes.length) await db.batch(writes as [(typeof writes)[0], ...typeof writes]);
  return { changed: changes.length, ref, warnings, remaining: later.size };
}
