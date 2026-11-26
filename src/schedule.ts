import { and, asc, eq, lte, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { schedule } from "./schema.ts";

// A generic job scheduler. A job is a row (kind + ref + when); a tick every minute runs what is due. There is no timer per job:
// the row is the wait, and a tick that finds nothing is one indexed query. A job missed while the server was down runs on the next tick.
export type Job = typeof schedule.$inferSelect;
export type Handler = (job: Job) => Promise<void>; // throw to fail; the job is retried, then marked failed

const MAX_ATTEMPTS = 3, STALE_MS = 10 * 60_000; // a "running" job older than this crashed mid-run and may be claimed again

/** When a job should run: the datetime if it is a real time in the future, else none (past or empty times are not scheduled). */
export function futureTime(value: unknown, now = Date.now()): Date | null {
  const t = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(t) && t > now ? new Date(t) : null;
}

/** Wait before the next try: 5 minutes after the first failure, 10 after the second. */
export const backoff = (attempts: number) => attempts * 5 * 60_000;

/** Creates the job, or moves an existing one to the new time and starts it afresh. A null time removes it. */
export async function setJob(d1: D1Database, kind: string, ref: string, runAt: Date | null, payload: string[] | null = null) {
  const d = drizzle(d1), now = new Date();
  if (!runAt) { await d.delete(schedule).where(and(eq(schedule.kind, kind), eq(schedule.ref, ref))); return; }
  await d.insert(schedule).values({ id: crypto.randomUUID(), kind, ref, runAt, payload, updatedAt: now })
    .onConflictDoUpdate({ target: [schedule.kind, schedule.ref], set: { runAt, payload, status: "pending", attempts: 0, error: null, updatedAt: now } });
}

/** Runs every job that is due. Returns how many ran and how many of those succeeded. */
export async function runDue(d1: D1Database, handlers: Record<string, Handler>, now = Date.now()) {
  const d = drizzle(d1), stale = new Date(now - STALE_MS);
  const due = await d.select().from(schedule).where(and(lte(schedule.runAt, new Date(now)), or(eq(schedule.status, "pending"), and(eq(schedule.status, "running"), lte(schedule.updatedAt, stale))))).orderBy(asc(schedule.runAt)).limit(50);
  let ran = 0, ok = 0;
  for (const j of due) {
    // Claim it: only one tick wins this update, so two overlapping ticks can't run the same job twice.
    const [job] = await d.update(schedule).set({ status: "running", attempts: sql`${schedule.attempts} + 1`, updatedAt: new Date() })
      .where(and(eq(schedule.id, j.id), or(eq(schedule.status, "pending"), and(eq(schedule.status, "running"), lte(schedule.updatedAt, stale))))).returning();
    if (!job) continue;
    ran++;
    try {
      const h = handlers[job.kind];
      if (!h) throw new Error(`no handler for "${job.kind}"`);
      await h(job);
      await d.update(schedule).set({ status: "done", error: null, updatedAt: new Date() }).where(and(eq(schedule.id, job.id), eq(schedule.runAt, job.runAt)));
      ok++;
    } catch (e) {
      const retry = job.attempts < MAX_ATTEMPTS;
      await d.update(schedule).set({ status: retry ? "pending" : "failed", error: (e as Error).message.slice(0, 500), runAt: retry ? new Date(now + backoff(job.attempts)) : job.runAt, updatedAt: new Date() }).where(eq(schedule.id, job.id));
    }
  }
  return { ran, ok };
}
