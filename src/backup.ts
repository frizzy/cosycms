import { drizzle } from "drizzle-orm/d1";
import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { settings } from "./schema.ts";
import { seal, unseal } from "./seal.ts";

// Where the off-server copy of the backup goes. The owner chooses it in Settings; the server's backup script (scripts/backup.sh, on the host)
// asks for it and sends an encrypted copy there with restic. Secrets are stored encrypted with SETTINGS_KEY, like the GitHub token.
const R2 = z.object({
  type: z.literal("r2"),
  accountId: z.string().trim().regex(/^[a-f0-9]{32}$/i, "The account ID is 32 letters and numbers (Cloudflare dashboard, R2)."),
  bucket: z.string().trim().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, "A bucket name is lowercase letters, numbers, dots and dashes."),
  accessKeyId: z.string().trim().regex(/^[A-Za-z0-9]{8,64}$/, "Paste the access key ID."),
  secret: z.string().max(200).optional(), // write-only: left out on a later save to keep the saved one
  prefix: z.string().trim().regex(/^[A-Za-z0-9._/-]{0,100}$/, "Letters, numbers, dots, dashes and slashes only.").optional(),
});
const SSH = z.object({
  type: z.literal("ssh"),
  host: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/, "A host name or address."),
  port: z.number().int().min(1).max(65535).optional(),
  user: z.string().trim().regex(/^[A-Za-z_][A-Za-z0-9_-]{0,31}$/, "A user name."),
  path: z.string().trim().regex(/^[A-Za-z0-9._~/-]{1,300}$/, "A folder path: letters, numbers, dots, dashes and slashes."),
});
export const Destination = z.discriminatedUnion("type", [R2, SSH]);
export type Dest = z.infer<typeof Destination>;
type Env = { SETTINGS_KEY?: string };
export type TestState = { state: "pending" | "running" | "ok" | "failed"; at: string; detail?: string };

const DEST = "backup.dest", PASSWORD = "backup.password", TEST = "backup.test", PUBKEY = "backup.pubkey";
const rows = async (d1: D1Database, keys: string[]) => Object.fromEntries((await drizzle(d1).select().from(settings).where(inArray(settings.key, keys))).map((r) => [r.key, r.value]));
const put = (d1: D1Database, key: string, value: string) => drizzle(d1).insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } });
const needKey = (env: Env) => { if (!env.SETTINGS_KEY) throw new Error("Can't store backup details: SETTINGS_KEY isn't set on the server (openssl rand -base64 32)."); return env.SETTINGS_KEY; };

export async function loadDest(d1: D1Database, env: Env): Promise<Dest | null> {
  const raw = (await rows(d1, [DEST]))[DEST];
  return raw ? (JSON.parse(await unseal(raw, needKey(env), DEST)) as Dest) : null;
}

/** What the admin may see: everything except the secret, which is only reported as saved. */
export const publicView = (d: Dest | null) => (d ? (d.type === "r2" ? { ...d, secret: undefined, hasSecret: !!d.secret } : d) : null);

/** Saves the destination (null removes it). A repository password is made the first time and returned once, so the owner can keep a copy somewhere else. */
export async function saveDest(d1: D1Database, env: Env, input: Dest | null): Promise<{ newPassword?: string }> {
  const db = drizzle(d1);
  if (!input) { await db.delete(settings).where(inArray(settings.key, [DEST, TEST])); return {}; }
  const key = needKey(env);
  let dest = input;
  if (dest.type === "r2" && !dest.secret) {
    const old = await loadDest(d1, env);
    if (old?.type !== "r2" || !old.secret) throw new Error("Paste the secret access key.");
    dest = { ...dest, secret: old.secret };
  }
  await put(d1, DEST, await seal(JSON.stringify(dest), key, DEST));
  await db.delete(settings).where(eq(settings.key, TEST)); // an earlier test says nothing about this destination
  const have = (await rows(d1, [PASSWORD]))[PASSWORD];
  if (have) return {};
  const newPassword = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
  await put(d1, PASSWORD, await seal(newPassword, key, PASSWORD));
  return { newPassword };
}

export async function getPassword(d1: D1Database, env: Env) {
  const raw = (await rows(d1, [PASSWORD]))[PASSWORD];
  return raw ? unseal(raw, needKey(env), PASSWORD) : null;
}

export async function getTest(d1: D1Database): Promise<TestState | null> {
  const raw = (await rows(d1, [TEST]))[TEST];
  return raw ? (JSON.parse(raw) as TestState) : null;
}
export const setTest = (d1: D1Database, t: TestState) => put(d1, TEST, JSON.stringify(t));
export const getPubkey = async (d1: D1Database) => (await rows(d1, [PUBKEY]))[PUBKEY] ?? null;
export const setPubkey = (d1: D1Database, key: string) => put(d1, PUBKEY, key);

const q = (v: string) => `'${v.replaceAll("'", `'\\''`)}'`; // a value safe inside single quotes in a shell script
/** The restic settings as shell assignments, for the backup scripts on the host (they eval it). Values are quoted, whatever they contain. */
export function jobScript(dest: Dest | null, password: string | null, testing: boolean) {
  const v: Record<string, string> = { COSY_DEST: dest?.type ?? "none", COSY_TEST: testing ? "1" : "0" };
  if (dest && password) {
    v.RESTIC_PASSWORD = password;
    if (dest.type === "r2") Object.assign(v, {
      RESTIC_REPOSITORY: `s3:https://${dest.accountId.toLowerCase()}.r2.cloudflarestorage.com/${dest.bucket}${dest.prefix?.replace(/^\/+|\/+$/g, "") ? `/${dest.prefix.replace(/^\/+|\/+$/g, "")}` : ""}`,
      AWS_ACCESS_KEY_ID: dest.accessKeyId, AWS_SECRET_ACCESS_KEY: dest.secret ?? "", AWS_DEFAULT_REGION: "auto",
    });
    else Object.assign(v, { RESTIC_REPOSITORY: `sftp:${dest.user}@${dest.host}:${dest.path}`, COSY_SSH_PORT: String(dest.port ?? 22) });
  }
  return Object.entries(v).map(([k, val]) => `${k}=${q(val)}`).join("\n") + "\n";
}
