// A real app in a test: the migrations applied to an in-memory SQLite (node:sqlite) behind just enough of D1's interface for drizzle,
// plus a signed-in owner. Requests go through the same Hono app the server runs, so routes, validation and the scheduler are what is tested.
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import app, { tick } from "./index.ts";

function d1(db: DatabaseSync): D1Database {
  const stmt = (sql: string, params: unknown[] = []) => {
    const s: StatementSync = db.prepare(sql);
    const run = () => { const info = s.run(...(params as never[])); return { success: true, results: [], meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } }; };
    return {
      bind: (...p: unknown[]) => stmt(sql, p),
      all: async () => ({ success: true, results: s.all(...(params as never[])), meta: {} }),
      raw: async () => { s.setReturnArrays(true); try { return s.all(...(params as never[])); } finally { s.setReturnArrays(false); } },
      first: async () => s.get(...(params as never[])) ?? null,
      run: async () => run(),
      _run: run,
    };
  };
  return {
    prepare: (sql: string) => stmt(sql),
    batch: async (list: { _run: () => unknown }[]) => { db.exec("begin"); try { const out = list.map((x) => x._run()); db.exec("commit"); return out; } catch (e) { db.exec("rollback"); throw e; } },
    exec: async (sql: string) => { db.exec(sql); return { count: 1, duration: 0 }; },
  } as unknown as D1Database;
}

export function testEnv() {
  const db = new DatabaseSync(":memory:");
  for (const f of readdirSync("migrations").filter((n) => n.endsWith(".sql")).sort()) db.exec(readFileSync(`migrations/${f}`, "utf8"));
  db.exec("delete from collections"); // the migrations seed a starter collection; tests define their own
  const blobs = new Map<string, { bytes: Uint8Array; type: string }>();
  const env = {
    DB: d1(db), SETTINGS_KEY: Buffer.alloc(32, 7).toString("base64"), TICK_TOKEN: "test-tick-token",
    BLOBS: { head: async (k: string) => blobs.get(k) && { size: blobs.get(k)!.bytes.length, httpMetadata: { contentType: "image/png" } }, put: async (k: string, b: Uint8Array, o: { httpMetadata: { contentType: string } }) => void blobs.set(k, { bytes: b, type: o.httpMetadata.contentType }), get: async () => null },
  } as never;
  const person = (id: string, email: string, role: "owner" | "member") => {
    const secret = `tok-${id}`;
    db.prepare("insert into users (id, email, role, createdAt) values (?, ?, ?, ?)").run(id, email, role, Date.now());
    db.prepare("insert into tokens (hash, kind, userId, expiresAt) values (?, 'session', ?, ?)").run(createHash("sha256").update(secret).digest("base64url"), id, Date.now() + 3_600_000);
    return secret;
  };
  const owner = person("u1", "owner@example.com", "owner"), member = person("u2", "member@example.com", "member");
  /** A request as `who` (default the owner). */
  async function call(method: string, path: string, body?: unknown, who = owner) {
    const res = await app.fetch(new Request(`http://localhost/api${path}`, {
      method, headers: { cookie: `cosy_session=${who}`, origin: "http://localhost", ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), env, { waitUntil() {}, passThroughOnException() {} } as never);
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }
  /** A request the way the host's scripts make it: with the tick token, not a session. */
  async function script(method: string, path: string, body?: unknown) {
    const res = await app.fetch(new Request(`http://localhost${path}`, { method, headers: { authorization: "Bearer test-tick-token", ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) }), env, { waitUntil() {}, passThroughOnException() {} } as never);
    return { status: res.status, text: await res.text() };
  }
  return { script, db, env: env as unknown as { BLOBS: { put(k: string, b: Uint8Array, o: { httpMetadata: { contentType: string } }): Promise<void> } }, call, owner, member, tick: () => tick(env) };
}
