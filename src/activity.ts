import { drizzle } from "drizzle-orm/d1";
import { activity } from "./schema.ts";

export type Actor = { email: string; via?: string };
export type Event = { action: string; collection?: string; entryId?: string; label?: string; detail?: string; before?: { slug: string; data: Record<string, unknown> } };

/** How much history to keep: versions per entry (what Undo and Restore can go back to), and days a deleted entry stays in the trash. Both are settings. */
export const HISTORY_DEFAULTS = { keep: 20, trashDays: 30 };
export async function historyLimits(d1: D1Database) {
  const { results } = await d1.prepare("select key, value from settings where key in ('history.keep', 'history.trashDays')").all<{ key: string; value: string }>();
  const n = (k: string, d: number) => { const v = parseInt(results.find((r) => r.key === k)?.value ?? ""); return Number.isFinite(v) && v >= 0 ? v : d; };
  return { keep: n("history.keep", HISTORY_DEFAULTS.keep), trashDays: n("history.trashDays", HISTORY_DEFAULTS.trashDays) };
}

/** Drops saved copies past the limits: older versions of one entry (or of every entry), and deleted entries older than the trash period. The log rows stay; only the copies go. */
export async function pruneHistory(d1: D1Database, entryId?: string) {
  const { keep, trashDays } = await historyLimits(d1);
  const mine = entryId ? "and entryId = ?1" : "and (?1 is null or 1)";
  await d1.prepare(`update activity set before = null where before is not null and action != 'entry.delete' ${mine} and id not in (select id from (select id, row_number() over (partition by entryId order by at desc, id desc) n from activity where before is not null and action != 'entry.delete' and entryId is not null) where n <= ?2)`).bind(entryId ?? null, keep).run();
  await d1.prepare("update activity set before = null where before is not null and action = 'entry.delete' and at < ?").bind(Date.now() - trashDays * 86_400_000).run();
}

/** Appends to the activity history. A change that keeps a copy (`before`) then trims copies past the history limits. */
export async function logActivity(d1: D1Database, who: Actor, e: Event) {
  await drizzle(d1).insert(activity).values({ id: crypto.randomUUID(), at: new Date(), actor: who.email, via: who.via ?? null, action: e.action,
    collection: e.collection ?? null, entryId: e.entryId ?? null, label: e.label ?? null, detail: e.detail ?? null, before: e.before ?? null });
  if (e.before) await pruneHistory(d1, e.entryId);
}

/** The fields whose values differ between two versions of an entry's data. */
export const changedKeys = (a: Record<string, unknown>, b: Record<string, unknown>) =>
  [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
