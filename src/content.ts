import { drizzle } from "drizzle-orm/d1";
import { eq, like } from "drizzle-orm";
import { settings } from "./schema.ts";
import { sha256 } from "./plan.ts";
import { snapshot } from "./publish.ts";
import { KEY_RE } from "./images.ts";
import { r2Store } from "./blobs.ts";

// A read-only way for a site to pull its content instead of (or as well as) receiving commits: GET /api/content with a content token.
// A "live" token sees what the live channel would get, a "preview" token what the preview channel would (published plus scheduled).
// Tokens are shown once and kept as hashes, one settings row each. shortcut: every request renders the whole site; fine for a build step, add caching if a site polls.
export type Channel = "live" | "preview";
type Stored = { hash: string; label: string; channel: Channel; at: string };
const PREFIX = "content.token.";

export async function listTokens(d1: D1Database) {
  return (await drizzle(d1).select().from(settings).where(like(settings.key, `${PREFIX}%`))).map((r) => ({ id: r.key.slice(PREFIX.length), ...(JSON.parse(r.value) as Stored) }));
}

export async function createToken(d1: D1Database, label: string, channel: Channel) {
  const id = crypto.randomUUID(), secret = `cosy_c_${btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/[+/=]/g, "")}`;
  const row: Stored = { hash: await sha256(secret), label, channel, at: new Date().toISOString() };
  await drizzle(d1).insert(settings).values({ key: PREFIX + id, value: JSON.stringify(row) });
  return { id, secret };
}

export const revokeToken = async (d1: D1Database, id: string) => { await drizzle(d1).delete(settings).where(eq(settings.key, PREFIX + id)); };

/** The channel a request's token grants, or null. */
async function channelOf(d1: D1Database, req: Request): Promise<Channel | null> {
  const secret = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  if (!secret.startsWith("cosy_c_")) return null;
  const hash = await sha256(secret);
  return (await listTokens(d1)).find((t) => t.hash === hash)?.channel ?? null;
}

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

/** GET /api/content[?prefix=posts/] lists files with their text; GET /api/content/blob/<file> is an image. Both need a content token. */
export async function contentResponse(env: { DB: D1Database; BLOBS: R2Bucket }, req: Request): Promise<Response> {
  const channel = await channelOf(env.DB, req);
  if (!channel) return json({ error: "A content token is needed: Authorization: Bearer cosy_c_…" }, 401);
  const url = new URL(req.url), blob = url.pathname.match(/^\/api\/content\/blob\/([^/]+)$/);
  if (blob) {
    const key = `media/${blob[1]}`, o = KEY_RE.test(key) ? await r2Store(env.BLOBS).get(key) : null;
    return o ? new Response(o.body, { headers: { "content-type": o.contentType, "content-length": String(o.size), "cache-control": "private, max-age=31536000, immutable", "x-content-type-options": "nosniff" } }) : json({ error: "not found" }, 404);
  }
  const prefix = url.searchParams.get("prefix") ?? "", files = (await snapshot(env.DB, channel)).filter((c) => c.path.startsWith(prefix));
  return json({
    channel, generatedAt: new Date().toISOString(),
    files: files.flatMap((c) => ("content" in c ? [{ path: c.path, content: c.content }] : [])),
    images: files.flatMap((c) => ("file" in c ? [{ path: c.path, url: `/api/content/blob/${c.file.slice("media/".length)}` }] : [])),
  });
}
