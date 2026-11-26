import { drizzle } from "drizzle-orm/d1";
import { eq, lt } from "drizzle-orm";
import { notifications, settings } from "./schema.ts";

export type Note = { kind: string; ref: string; level: "error" | "success" | "info"; title: string; body?: string; link?: string };

/** Records a notification, or refreshes the one for the same thing (and makes it unread again). Anything older than 90 days goes. */
export async function notify(d1: D1Database, n: Note) {
  const d = drizzle(d1), at = new Date(), v = { at, level: n.level, title: n.title, body: n.body ?? null, link: n.link ?? null, readAt: null };
  await d.insert(notifications).values({ id: crypto.randomUUID(), kind: n.kind, ref: n.ref, ...v }).onConflictDoUpdate({ target: [notifications.kind, notifications.ref], set: v });
  await d.delete(notifications).where(lt(notifications.at, new Date(+at - 90 * 864e5)));
}

/** Whether a passing site build is worth a notification (off unless an owner turns it on). */
export async function successWanted(d1: D1Database) {
  const [r] = await drizzle(d1).select().from(settings).where(eq(settings.key, "notify.success"));
  return r?.value === "1";
}
