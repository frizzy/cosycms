import { drizzle } from "drizzle-orm/d1";
import { activity } from "./schema";

export type Actor = { email: string; via?: string };
export type Event = { action: string; collection?: string; entryId?: string; label?: string; detail?: string; before?: { slug: string; data: Record<string, unknown> } };

/** Appends to the activity history. shortcut: never pruned, and `before` copies grow it by an entry's size per save; add a retention rule when the table gets large. */
export async function logActivity(d1: D1Database, who: Actor, e: Event) {
  await drizzle(d1).insert(activity).values({ id: crypto.randomUUID(), at: new Date(), actor: who.email, via: who.via ?? null, action: e.action,
    collection: e.collection ?? null, entryId: e.entryId ?? null, label: e.label ?? null, detail: e.detail ?? null, before: e.before ?? null });
}

/** The fields whose values differ between two versions of an entry's data. */
export const changedKeys = (a: Record<string, unknown>, b: Record<string, unknown>) =>
  [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
