import { Hono, type Context, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { csrf } from "hono/csrf";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { drizzle } from "drizzle-orm/d1";
import { and, count, eq, gt, lt } from "drizzle-orm";
import { z } from "zod";
import { clients, tokens, users } from "./schema";
import { hashPassword, verifyPassword } from "./passwords";
import { authorizeUrl, configured, isProvider, verifiedEmail, type ProviderEnv } from "./providers";
import { logActivity, type Event } from "./activity";
import { clearProvider, loadProviders, providerStatus, saveProvider } from "./settings";

// People sign in with email + password or a social account. The browser gets a session cookie; MCP clients and other apps
// get OAuth 2.1 tokens (authorization code + PKCE, dynamic client registration) that the same middleware accepts.
// Every token belongs to a user, so removing a user cuts off everything they signed in or connected.
export type AuthEnv = { Bindings: { DB: D1Database; SETUP_TOKEN?: string; SETTINGS_KEY?: string } & ProviderEnv; Variables: { user: { id: string; email: string; role: "owner" | "member"; name?: string | null; avatar?: string | null; app?: boolean; via?: string } } };
type Kind = "session" | "code" | "access" | "refresh" | "invite" | "state";

const MIN = 60_000;
export const TTL: Record<Kind, number> = { session: 14 * 24 * 60 * MIN, code: 10 * MIN, access: 60 * MIN, refresh: 30 * 24 * 60 * MIN, invite: 7 * 24 * 60 * MIN, state: 10 * MIN };
const COOKIE = "cosy_session";
const MAX_CLIENTS = 200; // shortcut: registration is open (the protocol requires it), so cap it; prune old clients when it bites

const b64url = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const digest = async (s: string) => b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));

/** PKCE S256: the verifier the client sends at /token must hash to the challenge it sent at /authorize. */
export const pkceOk = async (verifier: string, challenge: string) => verifier.length >= 43 && verifier.length <= 128 && (await digest(verifier)) === challenge;

/** https, loopback http (desktop apps), or a custom app scheme. Never a scriptable scheme, never a fragment. */
export function redirectAllowed(u: string) {
  try {
    const p = new URL(u);
    if (p.hash) return false;
    if (p.protocol === "https:") return true;
    if (p.protocol === "http:") return ["localhost", "127.0.0.1", "[::1]"].includes(p.hostname);
    return !["javascript:", "data:", "vbscript:", "file:", "blob:", "about:"].includes(p.protocol);
  } catch { return false; }
}

const db = (env: AuthEnv["Bindings"]) => drizzle(env.DB);
type TokenOpts = { userId?: string; clientId?: string; data?: Record<string, string> };

async function issue(env: AuthEnv["Bindings"], kind: Kind, o: TokenOpts = {}) {
  const secret = b64url(crypto.getRandomValues(new Uint8Array(32)));
  await db(env).delete(tokens).where(lt(tokens.expiresAt, new Date())); // housekeeping
  await db(env).insert(tokens).values({ hash: await digest(secret), kind, ...o, expiresAt: new Date(Date.now() + TTL[kind]) });
  return secret;
}

async function peek(env: AuthEnv["Bindings"], kind: Kind, secret: string) {
  if (!secret) return undefined;
  const [row] = await db(env).select().from(tokens).where(and(eq(tokens.hash, await digest(secret)), eq(tokens.kind, kind)));
  return row && row.expiresAt > new Date() ? row : undefined;
}

/** Codes, refresh tokens, invites and state are single-use: deleting is the check, so two racing requests can't both win. */
async function take(env: AuthEnv["Bindings"], kind: Kind, secret: string) {
  const [row] = await db(env).delete(tokens).where(and(eq(tokens.hash, await digest(secret ?? "")), eq(tokens.kind, kind))).returning();
  return row && row.expiresAt > new Date() ? row : undefined;
}

async function userOf(env: AuthEnv["Bindings"], id: string | null | undefined) {
  if (!id) return undefined;
  const [u] = await db(env).select().from(users).where(eq(users.id, id));
  return u && { id: u.id, email: u.email, role: u.role, name: u.name, avatar: u.avatar };
}

const secure = (c: { req: { url: string } }) => new URL(c.req.url).protocol === "https:";
const COOKIE_BASE = { httpOnly: true, sameSite: "Lax" as const };

async function startSession(c: Context<AuthEnv>, userId: string) {
  setCookie(c, COOKIE, await issue(c.env, "session", { userId }), { ...COOKIE_BASE, secure: secure(c), path: "/", maxAge: TTL.session / 1000 });
}

/** Who this request is: a session cookie or an access token, mapped to a current user. */
async function whoAmI(c: Context<AuthEnv>) {
  const bearer = c.req.header("authorization")?.match(/^Bearer (.+)$/i)?.[1];
  const row = bearer ? await peek(c.env, "access", bearer) : await peek(c.env, "session", getCookie(c, COOKIE) ?? "");
  const u = await userOf(c.env, row?.userId);
  // app: a connected app (MCP client), not a person at the keyboard; via: its name
  const via = bearer && row?.clientId ? (await db(c.env).select({ name: clients.name }).from(clients).where(eq(clients.id, row.clientId)))[0]?.name : undefined;
  return u && { ...u, app: !!bearer, via };
}

export const requireAuth: MiddlewareHandler<AuthEnv> = async (c, next) => {
  const user = await whoAmI(c);
  if (user) { c.set("user", user); return next(); }
  const url = new URL(c.req.url), mcp = url.pathname.startsWith("/mcp");
  const meta = `${url.origin}/.well-known/oauth-protected-resource${mcp ? "/mcp" : ""}`;
  return c.json({ error: "Sign in required" }, 401, { "www-authenticate": `Bearer resource_metadata="${meta}"` });
};

export const ownerOnly: MiddlewareHandler<AuthEnv> = async (c, next) => (c.get("user").role === "owner" ? next() : c.json({ error: "Only an owner can do that." }, 403));

/** Publishing is for people: a connected app (an LLM through MCP, say) can write drafts but never make anything live. */
export const humanOnly: MiddlewareHandler<AuthEnv> = async (c, next) => (c.get("user").app ? c.json({ error: "Connected apps can save drafts, but only a person can publish." }, 403) : next());

/** Only same-site paths, so a sign-in link can't bounce someone to another site. */
const safeNext = (n: string | undefined) => (n && /^\/(?![/\\])/.test(n) ? n : "/");

// ---- pages ----------------------------------------------------------------------------------------------------------
const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
const page = (body: string, status = 200) => new Response(
  `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>cosycms</title>
<style>:root{color-scheme:light dark;--bg:light-dark(#f1f6f7,#1e2629);--surface:light-dark(#fff,#263237);--ink:light-dark(#1b2a2f,#d4d4d4);--muted:light-dark(#566f78,#8ea4ac);--accent:light-dark(#0b6f8b,#2eadd7);--on:light-dark(#fff,#0e1d22);--edge:light-dark(#7b949d,#6a838d);--err:light-dark(#bd3434,#ff7b7b)}body{font:16px system-ui,sans-serif;max-width:26rem;margin:12vh auto;padding:0 1rem;background:var(--bg);color:var(--ink)}a{color:var(--accent)}button,.b{font:inherit;padding:.55rem .8rem;border-radius:7px;border:1px solid var(--edge);cursor:pointer;background:transparent;color:inherit;text-decoration:none}.go{background:var(--accent);color:var(--on);border-color:transparent;font-weight:600}.err{color:var(--err)}.muted{color:var(--muted);font-size:.9rem;word-break:break-all}</style>${body}`,
  { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'" } });
const problem = (msg: string, status = 400) => page(`<h1>Can't continue</h1><p class=err>${esc(msg)}</p><p><a href="/">Back to cosycms</a></p>`, status);

const PARAMS = ["client_id", "redirect_uri", "response_type", "code_challenge", "code_challenge_method", "state"] as const;
type Params = Record<(typeof PARAMS)[number], string>;

async function check(env: AuthEnv["Bindings"], p: Params) {
  const [client] = await db(env).select().from(clients).where(eq(clients.id, p.client_id));
  if (!client) return { error: "Unknown application. It needs to register first." };
  if (!client.redirectUris.includes(p.redirect_uri)) return { error: "That redirect address isn't registered for this application." };
  if (p.response_type !== "code" || p.code_challenge_method !== "S256" || !p.code_challenge) return { error: "This request is missing PKCE (S256), which is required." };
  return { client };
}

const consent = (p: Params, name: string, email: string) => page(`<h1>Connect to cosycms</h1>
<p><strong>${esc(name)}</strong> wants full access to this CMS as <strong>${esc(email)}</strong>: read and change content, collections, and publish.</p>
<p class=muted>Returns to ${esc(p.redirect_uri)}</p>
<form method=post>${PARAMS.map((k) => `<input type=hidden name=${k} value="${esc(p[k] ?? "")}">`).join("")}
<button class=go name=decision value=allow>Allow</button> <button name=decision value=deny>Deny</button></form>`);

// ---- routes ---------------------------------------------------------------------------------------------------------
// Registered before the API's requireAuth, so these are reachable while signed out.
export const authRoutes = new Hono<AuthEnv>();

const Credentials = z.object({ email: z.email().transform((e) => e.toLowerCase()), password: z.string().min(1) });
const NewPassword = z.string().min(10, "Use at least 10 characters.").max(200);

// Who may create the owner: anyone on localhost; anywhere else only someone who knows SETUP_TOKEN (and with it unset, nobody).
const setupMode = (c: Context<AuthEnv>) => (["localhost", "127.0.0.1", "[::1]"].includes(new URL(c.req.url).hostname) ? "local" : c.env.SETUP_TOKEN ? "token" : "blocked") as "local" | "token" | "blocked";
const sameSecret = async (a: string, b: string) => { // compare digests so length and position of a mismatch don't leak
  const [x, y] = await Promise.all([digest(a), digest(b)]);
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return d === 0;
};

// What the login screen needs to know: is there anyone yet, and which social buttons to show.
authRoutes.get("/api/auth", async (c) => {
  const [{ n }] = await db(c.env).select({ n: count() }).from(users);
  return c.json({ needsSetup: n === 0, setup: setupMode(c), providers: configured(await loadProviders(c.env.DB, c.env)) });
});

/** Null when this request may create the owner, otherwise the reason it may not. */
async function setupDenied(c: Context<AuthEnv>, token: unknown) {
  const mode = setupMode(c);
  if (mode === "blocked") return "Setup is locked. Set a SETUP_TOKEN secret on the server (wrangler secret put SETUP_TOKEN), then try again.";
  if (mode === "token" && !(typeof token === "string" && (await sameSecret(token, c.env.SETUP_TOKEN!)))) return "That setup token is wrong.";
  return null;
}

/** One conditional INSERT, so two racing setups can't both win. Returns the new owner's id, or undefined if an owner already exists. */
async function createOwner(env: AuthEnv["Bindings"], email: string, passwordHash: string | null) {
  const id = crypto.randomUUID();
  const r = await env.DB.prepare("INSERT INTO users (id, email, role, passwordHash, createdAt) SELECT ?, ?, 'owner', ?, ? WHERE NOT EXISTS (SELECT 1 FROM users)").bind(id, email, passwordHash, Date.now()).run();
  return r.meta.changes ? id : undefined;
}

// First visit: the first account becomes the owner. One conditional INSERT, so two racing setups can't both win.
// shortcut: whoever reaches a fresh deployment first owns it, so open it right after deploying.
authRoutes.post("/api/setup", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const denied = await setupDenied(c, body.setupToken);
  if (denied) return c.json({ error: denied }, 403);
  const input = Credentials.extend({ password: NewPassword }).safeParse(body);
  if (!input.success) return c.json({ error: input.error.issues[0].message }, 400);
  const id = await createOwner(c.env, input.data.email, await hashPassword(input.data.password));
  if (!id) return c.json({ error: "This CMS already has an owner. Sign in instead." }, 409);
  await startSession(c, id);
  return c.body(null, 204);
});

authRoutes.post("/api/login", async (c) => {
  const input = Credentials.safeParse(await c.req.json().catch(() => ({}))); // shortcut: no rate limit; add one (or Cloudflare WAF rules) before exposing publicly
  const [u] = input.success ? await db(c.env).select().from(users).where(eq(users.email, input.data.email)) : [];
  if (!input.success || !(await verifyPassword(input.data.password, u?.passwordHash)) || !u) return c.json({ error: "Wrong email or password." }, 401);
  await startSession(c, u.id);
  return c.body(null, 204);
});

authRoutes.post("/api/logout", async (c) => {
  const s = getCookie(c, COOKIE);
  if (s) await take(c.env, "session", s);
  deleteCookie(c, COOKIE, { path: "/" });
  return c.body(null, 204);
});

// An invite link lets an invited person set their password (or reset a forgotten one).
authRoutes.get("/api/invite/:secret", async (c) => {
  const u = await userOf(c.env, (await peek(c.env, "invite", c.req.param("secret")))?.userId);
  return u ? c.json({ email: u.email }) : c.json({ error: "This invite link has expired or was already used." }, 404);
});

authRoutes.post("/api/invite/:secret", async (c) => {
  const pw = NewPassword.safeParse((await c.req.json().catch(() => ({}))).password);
  if (!pw.success) return c.json({ error: pw.error.issues[0].message }, 400);
  const row = await take(c.env, "invite", c.req.param("secret"));
  if (!row?.userId) return c.json({ error: "This invite link has expired or was already used." }, 404);
  await db(c.env).update(users).set({ passwordHash: await hashPassword(pw.data) }).where(eq(users.id, row.userId));
  await startSession(c, row.userId);
  return c.body(null, 204);
});

// Social sign-in: the state is stored server-side AND bound to this browser by a cookie, so a callback someone else started is refused.
async function beginSocial(c: Context<AuthEnv>, next: string | undefined, setup = false) {
  const id = c.req.param("provider") ?? "", origin = new URL(c.req.url).origin;
  const state = await issue(c.env, "state", { data: { next: safeNext(next), ...(setup ? { setup: "1" } : {}) } });
  const url = authorizeUrl(id, await loadProviders(c.env.DB, c.env), `${origin}/auth/${id}/callback`, state);
  if (url) setCookie(c, "cosy_state", state, { ...COOKIE_BASE, secure: secure(c), path: "/auth", maxAge: TTL.state / 1000 });
  return url;
}

authRoutes.get("/auth/:provider/start", async (c) => {
  const url = await beginSocial(c, c.req.query("next"));
  return url ? c.redirect(url) : problem("That sign-in method isn't set up on this server.", 404);
});

// Creating the owner with a social account: the same gate as the password form, checked here and remembered in the (server-side) state.
authRoutes.post("/auth/:provider/setup", async (c) => {
  const denied = await setupDenied(c, (await c.req.json().catch(() => ({}))).setupToken);
  if (denied) return c.json({ error: denied }, 403);
  const url = await beginSocial(c, "/", true);
  return url ? c.json({ url }) : c.json({ error: "That sign-in method isn't set up on this server." }, 404);
});

authRoutes.get("/auth/:provider/callback", async (c) => {
  const id = c.req.param("provider"), origin = new URL(c.req.url).origin, state = c.req.query("state") ?? "";
  const bound = getCookie(c, "cosy_state");
  deleteCookie(c, "cosy_state", { path: "/auth" });
  const row = state && state === bound ? await take(c.env, "state", state) : undefined;
  const code = c.req.query("code");
  if (!row || !code) return problem("That sign-in expired or was cancelled. Go back and try again.");
  let email: string | undefined, why = "";
  try { email = await verifiedEmail(id, await loadProviders(c.env.DB, c.env), code, `${origin}/auth/${id}/callback`); } catch (e) { why = ` (${(e as Error).message})`; }
  if (!email) return problem(`The provider didn't give us a verified email address${why}.`);
  const [u] = await db(c.env).select().from(users).where(eq(users.email, email));
  const userId = u?.id ?? (row.data?.setup ? await createOwner(c.env, email, null) : undefined);
  if (!userId) return problem(`There's no account for ${email}. Ask the owner to invite you.`, 403);
  await startSession(c, userId);
  return c.redirect(row.data?.next ?? "/");
});

// ---- OAuth for MCP clients and other apps ------------------------------------------------------------------------------
const open = cors({ origin: "*" }); // none of these use cookies, so any origin may call them (browser-based MCP clients)
authRoutes.use("/.well-known/*", open);
authRoutes.use("/oauth/token", open);
authRoutes.use("/oauth/register", open);

const resource = (c: { req: { url: string } }, path = "") => {
  const origin = new URL(c.req.url).origin;
  return { resource: origin + path, authorization_servers: [origin], bearer_methods_supported: ["header"] };
};
authRoutes.get("/.well-known/oauth-protected-resource", (c) => c.json(resource(c)));
authRoutes.get("/.well-known/oauth-protected-resource/mcp", (c) => c.json(resource(c, "/mcp")));

authRoutes.get("/.well-known/oauth-authorization-server", (c) => {
  const o = new URL(c.req.url).origin;
  return c.json({
    issuer: o, authorization_endpoint: `${o}/oauth/authorize`, token_endpoint: `${o}/oauth/token`, registration_endpoint: `${o}/oauth/register`,
    response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"],
  });
});

authRoutes.post("/oauth/register", async (c) => {
  const b = await c.req.json<{ client_name?: unknown; redirect_uris?: unknown }>().catch(() => ({} as { client_name?: unknown; redirect_uris?: unknown }));
  const uris = b.redirect_uris;
  if (!Array.isArray(uris) || !uris.length || uris.length > 10 || !uris.every((u) => typeof u === "string" && redirectAllowed(u)))
    return c.json({ error: "invalid_redirect_uri" }, 400);
  const [{ n }] = await db(c.env).select({ n: count() }).from(clients);
  if (n >= MAX_CLIENTS) return c.json({ error: "temporarily_unavailable" }, 503);
  const client_name = typeof b.client_name === "string" && b.client_name.trim() ? b.client_name.trim().slice(0, 100) : "An application";
  const id = crypto.randomUUID();
  await db(c.env).insert(clients).values({ id, name: client_name, redirectUris: uris as string[], createdAt: new Date() });
  return c.json({ client_id: id, client_name, redirect_uris: uris, token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }, 201);
});

// Not signed in? Go through the normal sign-in (password or social) and come straight back here.
authRoutes.get("/oauth/authorize", async (c) => {
  const p = Object.fromEntries(PARAMS.map((k) => [k, c.req.query(k) ?? ""])) as Params;
  const r = await check(c.env, p);
  if (!r.client) return problem(r.error!);
  const user = await whoAmI(c);
  if (!user) { const u = new URL(c.req.url); return c.redirect(`/login?next=${encodeURIComponent(u.pathname + u.search)}`); }
  return consent(p, r.client.name, user.email);
});

// csrf() rejects a cross-site form post outright; the session cookie is SameSite=Lax as a second layer.
authRoutes.post("/oauth/authorize", csrf(), async (c) => {
  const user = await whoAmI(c);
  if (!user) return problem("You're signed out. Start again from the app.", 401);
  const form = await c.req.parseBody();
  const p = Object.fromEntries(PARAMS.map((k) => [k, typeof form[k] === "string" ? (form[k] as string) : ""])) as Params;
  const r = await check(c.env, p);
  if (!r.client) return problem(r.error!);
  const back = new URL(p.redirect_uri);
  if (p.state) back.searchParams.set("state", p.state);
  if (form.decision !== "allow") back.searchParams.set("error", "access_denied");
  else back.searchParams.set("code", await issue(c.env, "code", { userId: user.id, clientId: p.client_id, data: { challenge: p.code_challenge, redirectUri: p.redirect_uri } }));
  return c.redirect(back.toString(), 303);
});

authRoutes.post("/oauth/token", async (c) => {
  const f = Object.fromEntries(Object.entries(await c.req.parseBody()).filter(([, v]) => typeof v === "string")) as Record<string, string>;
  const fail = (error: string) => c.json({ error }, 400, { "cache-control": "no-store" });
  const [client] = await db(c.env).select().from(clients).where(eq(clients.id, f.client_id ?? ""));
  if (!client) return c.json({ error: "invalid_client" }, 401);

  let userId: string | null | undefined;
  if (f.grant_type === "authorization_code") {
    const row = await take(c.env, "code", f.code);
    if (!row || row.clientId !== client.id || row.data?.redirectUri !== f.redirect_uri || !(await pkceOk(f.code_verifier ?? "", row.data.challenge))) return fail("invalid_grant");
    userId = row.userId;
  } else if (f.grant_type === "refresh_token") {
    const row = await take(c.env, "refresh", f.refresh_token); // rotated: the old one stops working
    if (!row || row.clientId !== client.id) return fail("invalid_grant");
    userId = row.userId;
  } else return fail("unsupported_grant_type");
  if (!(await userOf(c.env, userId))) return fail("invalid_grant");

  return c.json({
    access_token: await issue(c.env, "access", { userId: userId!, clientId: client.id }), token_type: "Bearer", expires_in: TTL.access / 1000,
    refresh_token: await issue(c.env, "refresh", { userId: userId!, clientId: client.id }),
  }, 200, { "cache-control": "no-store" });
});

// ---- signed-in account routes (mounted after requireAuth) ---------------------------------------------------------------
export const accountRoutes = new Hono<AuthEnv>().basePath("/api");

const log = (c: Context<AuthEnv>, e: Event) => logActivity(c.env.DB, { email: c.get("user").email, via: c.get("user").via }, e);

accountRoutes.get("/session", (c) => c.json(c.get("user")));

// Social sign-in setup (owner only). The secret is write-only; what to register at the provider is the callback URL.
accountRoutes.get("/providers", ownerOnly, async (c) => {
  const origin = new URL(c.req.url).origin;
  return c.json((await providerStatus(c.env.DB, c.env)).map((p) => ({ ...p, callback: `${origin}/auth/${p.id}/callback` })));
});
accountRoutes.put("/providers/:id", ownerOnly, async (c) => {
  const input = z.object({ clientId: z.string().trim().min(1, "Enter the client ID."), secret: z.string().trim().optional() }).safeParse(await c.req.json().catch(() => null));
  if (!input.success) return c.json({ error: input.error.issues[0].message }, 400);
  try { await saveProvider(c.env.DB, c.req.param("id"), input.data, c.env); } catch (e) { return c.json({ error: (e as Error).message }, 400); }
  await log(c, { action: "provider.save", label: c.req.param("id") });
  return c.body(null, 204);
});
accountRoutes.delete("/providers/:id", ownerOnly, async (c) => {
  if (!isProvider(c.req.param("id"))) return c.json({ error: "Unknown provider." }, 404);
  await clearProvider(c.env.DB, c.req.param("id"));
  await log(c, { action: "provider.remove", label: c.req.param("id") });
  return c.body(null, 204);
});

// Apps (MCP clients etc.) this person has connected. A refresh token's expiry minus its lifetime is when it was last issued.
accountRoutes.get("/connections", async (c) => {
  const live = await db(c.env).select().from(tokens).where(and(eq(tokens.kind, "refresh"), eq(tokens.userId, c.get("user").id), gt(tokens.expiresAt, new Date())));
  const names = new Map((await db(c.env).select().from(clients)).map((x) => [x.id, x.name]));
  return c.json(live.filter((t) => t.clientId && names.has(t.clientId)).map((t) => ({ id: t.clientId, name: names.get(t.clientId!), lastActive: t.expiresAt.getTime() - TTL.refresh })));
});

// Disconnecting removes this person's tokens for the app; the app's registration goes once nobody uses it.
accountRoutes.delete("/connections/:id", async (c) => {
  const id = c.req.param("id");
  await db(c.env).delete(tokens).where(and(eq(tokens.clientId, id), eq(tokens.userId, c.get("user").id)));
  const [{ n }] = await db(c.env).select({ n: count() }).from(tokens).where(eq(tokens.clientId, id));
  if (!n) await db(c.env).delete(clients).where(eq(clients.id, id));
  return c.body(null, 204);
});

const inviteLink = async (c: { env: AuthEnv["Bindings"]; req: { url: string } }, userId: string) => `${new URL(c.req.url).origin}/invite/${await issue(c.env, "invite", { userId })}`;

accountRoutes.get("/people", ownerOnly, async (c) =>
  c.json((await db(c.env).select().from(users).orderBy(users.createdAt)).map((u) => ({ id: u.id, email: u.email, role: u.role, name: u.name, avatar: u.avatar, hasPassword: !!u.passwordHash }))));

accountRoutes.post("/people", ownerOnly, async (c) => {
  const input = z.object({ email: z.email().transform((e) => e.toLowerCase()) }).safeParse(await c.req.json().catch(() => ({})));
  if (!input.success) return c.json({ error: "Enter a valid email address." }, 400);
  const id = crypto.randomUUID();
  try { await db(c.env).insert(users).values({ id, email: input.data.email, role: "member", createdAt: new Date() }); }
  catch (e) { if (/UNIQUE/.test(String(e) + String((e as Error).cause))) return c.json({ error: "That person already has an account." }, 409); throw e; }
  await log(c, { action: "person.invite", label: input.data.email });
  return c.json({ id, invite: await inviteLink(c, id) }, 201);
});

// Also the password reset: a fresh link lets them choose a new password.
accountRoutes.post("/people/:id/invite", ownerOnly, async (c) =>
  (await userOf(c.env, c.req.param("id"))) ? c.json({ invite: await inviteLink(c, c.req.param("id")) }) : c.json({ error: "not found" }, 404));

// Promote a member to owner, or step another owner back down. You can't change your own role, so there is always at least one owner.
accountRoutes.put("/people/:id/role", ownerOnly, async (c) => {
  const id = c.req.param("id"), input = z.object({ role: z.enum(["owner", "member"]) }).safeParse(await c.req.json().catch(() => null));
  if (!input.success) return c.json({ error: "Role must be owner or member." }, 400);
  if (id === c.get("user").id) return c.json({ error: "You can't change your own role." }, 400);
  const r = await db(c.env).update(users).set({ role: input.data.role }).where(eq(users.id, id)).returning({ id: users.id });
  if (!r.length) return c.json({ error: "No such person." }, 404);
  await log(c, { action: "person.role", label: (await userOf(c.env, id))?.email, detail: input.data.role });
  return c.body(null, 204);
});

accountRoutes.delete("/people/:id", ownerOnly, async (c) => {
  const id = c.req.param("id");
  if (id === c.get("user").id) return c.json({ error: "You can't remove yourself." }, 400);
  const gone = await userOf(c.env, id);
  await db(c.env).delete(tokens).where(eq(tokens.userId, id));
  await db(c.env).delete(users).where(eq(users.id, id));
  if (gone) await log(c, { action: "person.remove", label: gone.email });
  return c.body(null, 204);
});
