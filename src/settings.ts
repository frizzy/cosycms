import { drizzle } from "drizzle-orm/d1";
import { eq, inArray, like } from "drizzle-orm";
import { publishState, settings } from "./schema";
import { isSealed, seal, unseal } from "./seal";
import { credsFromEnv, isProvider, providerList, type Creds, type ProviderEnv } from "./providers";

const KEYS = ["github.token", "github.repo", "github.branch", "github.dir"] as const;
type Env = { SETTINGS_KEY?: string; GITHUB_TOKEN?: string; GITHUB_REPO?: string; GITHUB_BRANCH?: string; GITHUB_DIR?: string };

export type GithubSettings = { token?: string; repo?: string; branch?: string; dir?: string };
// tokenError is set instead of token when a saved token exists but can't be read, so Settings still loads and says why.
export type LoadedGithub = GithubSettings & { tokenError?: string };

/** DB settings win; env vars (.dev.vars / secrets) are the fallback. The token is stored encrypted with SETTINGS_KEY. */
export async function loadGithub(d1: D1Database, env: Env): Promise<LoadedGithub> {
  const rows = await drizzle(d1).select().from(settings).where(inArray(settings.key, [...KEYS]));
  const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const out: LoadedGithub = { repo: s["github.repo"] ?? env.GITHUB_REPO, branch: s["github.branch"] ?? env.GITHUB_BRANCH, dir: s["github.dir"] ?? env.GITHUB_DIR, token: env.GITHUB_TOKEN };
  const raw = s["github.token"];
  if (!raw) return out;
  try {
    if (isSealed(raw)) {
      if (!env.SETTINGS_KEY) throw new Error("The saved token is encrypted but SETTINGS_KEY isn't set on the server.");
      out.token = await unseal(raw, env.SETTINGS_KEY, "github.token");
    } else {
      out.token = raw;
      // A token saved before encryption existed: encrypt it the first time it's read with a key available.
      if (env.SETTINGS_KEY) await drizzle(d1).update(settings).set({ value: await seal(raw, env.SETTINGS_KEY, "github.token") }).where(eq(settings.key, "github.token"));
    }
  } catch (e) { out.token = undefined; out.tokenError = (e as Error).message; }
  return out;
}

/** Empty string clears a key; undefined leaves it alone. A token is refused unless there's a key to encrypt it with. */
export async function saveGithub(d1: D1Database, v: GithubSettings, env: Env) {
  const db = drizzle(d1);
  if (v.token && !env.SETTINGS_KEY) throw new Error("Can't store the token: SETTINGS_KEY isn't set on the server (openssl rand -base64 32).");
  // Encrypt first, then build the queries: a drizzle query is a thenable, so returning one from an async function would run it early.
  const entries = await Promise.all((Object.entries(v) as [keyof GithubSettings, string | undefined][])
    .filter(([, val]) => val !== undefined)
    .map(async ([k, val]) => [`github.${k}`, k === "token" && val ? await seal(val, env.SETTINGS_KEY!, "github.token") : val!] as const));
  const writes = entries.map(([key, value]) => value === ""
    ? db.delete(settings).where(eq(settings.key, key))
    : db.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } }));
  // What was "already sent" belongs to the old repo, branch and folder. Pointing somewhere else starts from nothing, or unchanged files would be skipped there.
  const was = Object.fromEntries((await db.select().from(settings).where(inArray(settings.key, ["github.repo", "github.branch", "github.dir"]))).map((r) => [r.key, r.value]));
  const moved = (["repo", "branch", "dir"] as const).some((k) => v[k] !== undefined && v[k] !== (was[`github.${k}`] ?? ""));
  if (moved) writes.push(db.delete(publishState).where(eq(publishState.target, "github")) as never);
  if (writes.length) await db.batch(writes as [(typeof writes)[0], ...typeof writes]);
}

// ---- Social sign-in providers: client id in the clear, secret encrypted, both under auth.<provider>.* ----
const pk = (id: string) => [`auth.${id}.clientId`, `auth.${id}.secret`] as const;

/** What the provider's rows hold. A secret that can't be decrypted is reported, not thrown, so Settings still loads. */
async function savedProviders(d1: D1Database, env: { SETTINGS_KEY?: string }) {
  const rows = await drizzle(d1).select().from(settings).where(like(settings.key, "auth.%"));
  const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return Promise.all(providerList().map(async ({ id }) => {
    const [idKey, secretKey] = pk(id);
    let secret: string | undefined, error: string | undefined;
    if (s[secretKey]) {
      try {
        if (!env.SETTINGS_KEY) throw new Error("The saved secret is encrypted but SETTINGS_KEY isn't set on the server.");
        secret = await unseal(s[secretKey], env.SETTINGS_KEY, secretKey);
      } catch (e) { error = (e as Error).message; }
    }
    return { id, clientId: s[idKey], secret, hasSecret: !!s[secretKey], error };
  }));
}

/** Saved settings win over env vars, provider by provider. */
export async function loadProviders(d1: D1Database, env: ProviderEnv & { SETTINGS_KEY?: string }): Promise<Creds> {
  const out = credsFromEnv(env);
  for (const p of await savedProviders(d1, env)) if (p.clientId && p.secret) out[p.id] = { id: p.clientId, secret: p.secret };
  return out;
}

/** For the Settings page: never includes a secret. */
export async function providerStatus(d1: D1Database, env: ProviderEnv & { SETTINGS_KEY?: string }) {
  const fromEnv = credsFromEnv(env), saved = new Map((await savedProviders(d1, env)).map((p) => [p.id, p]));
  return providerList().map((p) => {
    const s = saved.get(p.id)!;
    return { ...p, clientId: s.clientId ?? "", hasSecret: s.hasSecret, error: s.error,
      source: s.clientId && s.secret ? "settings" as const : fromEnv[p.id] ? "environment" as const : null };
  });
}

/** A blank secret keeps the saved one. Refused without SETTINGS_KEY, since the secret is stored encrypted. */
export async function saveProvider(d1: D1Database, id: string, v: { clientId: string; secret?: string }, env: { SETTINGS_KEY?: string }) {
  if (!isProvider(id)) throw new Error("Unknown provider.");
  const [idKey, secretKey] = pk(id), db = drizzle(d1);
  const had = await db.select().from(settings).where(eq(settings.key, secretKey));
  if (!v.secret && !had.length) throw new Error("Enter the client secret.");
  if (v.secret && !env.SETTINGS_KEY) throw new Error("Can't store the secret: SETTINGS_KEY isn't set on the server (openssl rand -base64 32).");
  const value = v.secret ? await seal(v.secret, env.SETTINGS_KEY!, secretKey) : undefined;
  const put = (key: string, val: string) => db.insert(settings).values({ key, value: val }).onConflictDoUpdate({ target: settings.key, set: { value: val } });
  await db.batch([put(idKey, v.clientId), ...(value ? [put(secretKey, value)] : [])] as [ReturnType<typeof put>, ...ReturnType<typeof put>[]]);
}

export async function clearProvider(d1: D1Database, id: string) {
  await drizzle(d1).delete(settings).where(inArray(settings.key, [...pk(id)]));
}
