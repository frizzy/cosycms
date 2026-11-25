// Social sign-in. A provider's client id and secret come from the settings the owner saved (see settings.ts) or, failing that, from env vars
// (<ID>_CLIENT_ID / <ID>_CLIENT_SECRET); it only shows up once it has both. To add a provider, add an entry to PROVIDERS.
// All we take from a provider is a *verified* email, which is matched to an existing (invited) user.
export type ProviderEnv = Partial<Record<`${"GITHUB" | "GOOGLE"}_CLIENT_${"ID" | "SECRET"}`, string>>;
export type Creds = Record<string, { id: string; secret: string }>;
type Provider = {
  name: string; authorize: string; scope: string; help: string; // help: where to create the app

  email(code: string, o: { id: string; secret: string; redirect: string }, f: typeof fetch): Promise<string | undefined>;
};

// The message is shown to the person signing in, so it names the failing step and status but never includes a token.
const json = async (r: Response) => { if (!r.ok) throw new Error(`${new URL(r.url).pathname} answered ${r.status}`); return r.json() as Promise<any>; };

const PROVIDERS: Record<string, Provider> = {
  github: {
    name: "GitHub", authorize: "https://github.com/login/oauth/authorize", scope: "user:email",
    help: "GitHub → Settings → Developer settings → OAuth Apps → New OAuth App. (A GitHub App also works if you give it the Email addresses: read permission.)",
    async email(code, o, f) {
      const t = await json(await f("https://github.com/login/oauth/access_token", { method: "POST", headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ client_id: o.id, client_secret: o.secret, code, redirect_uri: o.redirect }) }));
      if (!t.access_token) throw new Error(t.error_description ?? t.error ?? "GitHub returned no access token");
      const emails = await json(await f("https://api.github.com/user/emails", { headers: { authorization: `Bearer ${t.access_token}`, accept: "application/vnd.github+json", "user-agent": "cosycms" } }));
      return (emails as { email: string; primary: boolean; verified: boolean }[]).find((e) => e.primary && e.verified)?.email;
    },
  },
  google: {
    name: "Google", authorize: "https://accounts.google.com/o/oauth2/v2/auth", scope: "openid email",
    help: "Google Cloud console → APIs & Services → Credentials → Create credentials → OAuth client ID → Web application.",
    async email(code, o, f) {
      const t = await json(await f("https://oauth2.googleapis.com/token", { method: "POST",
        body: new URLSearchParams({ client_id: o.id, client_secret: o.secret, code, redirect_uri: o.redirect, grant_type: "authorization_code" }) }));
      if (!t.access_token) throw new Error(t.error_description ?? t.error ?? "Google returned no access token");
      const u = await json(await f("https://openidconnect.googleapis.com/v1/userinfo", { headers: { authorization: `Bearer ${t.access_token}` } }));
      return u.email_verified ? (u.email as string) : undefined;
    },
  },
};

export const providerList = () => Object.entries(PROVIDERS).map(([id, p]) => ({ id, name: p.name, help: p.help }));
export const isProvider = (id: string) => id in PROVIDERS;

/** Credentials from env vars; settings saved in the database take precedence (see loadProviders). */
export function credsFromEnv(env: ProviderEnv): Creds {
  const e = env as Record<string, string | undefined>;
  return Object.fromEntries(Object.keys(PROVIDERS).flatMap((id) => {
    const k = id.toUpperCase();
    return e[`${k}_CLIENT_ID`] && e[`${k}_CLIENT_SECRET`] ? [[id, { id: e[`${k}_CLIENT_ID`]!, secret: e[`${k}_CLIENT_SECRET`]! }]] : [];
  }));
}

export const configured = (creds: Creds) => Object.entries(PROVIDERS).filter(([id]) => creds[id]).map(([id, p]) => ({ id, name: p.name }));

export function authorizeUrl(id: string, creds: Creds, redirect: string, state: string) {
  const c = creds[id], p = PROVIDERS[id];
  if (!c || !p) return undefined;
  return `${p.authorize}?${new URLSearchParams({ client_id: c.id, redirect_uri: redirect, state, scope: p.scope, response_type: "code" })}`;
}

/** The provider's verified email for this sign-in, lowercased; undefined if it has none verified. */
export async function verifiedEmail(id: string, creds: Creds, code: string, redirect: string, f: typeof fetch = fetch) {
  const c = creds[id];
  return c && PROVIDERS[id] ? (await PROVIDERS[id].email(code, { ...c, redirect }, f))?.toLowerCase() : undefined;
}
