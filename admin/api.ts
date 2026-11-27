import type { Change } from "../src/diff";
import type { Collection, Field } from "../src/fields";
import type { FileValue } from "../src/images";
import type { BlockDef } from "../src/blocks";
import type { AccessCheck } from "../src/github";
import type { TemplateDef } from "../src/templates";

export type Entry = {
  id: string; collection: string; slug: string;
  published: boolean; pending: boolean; // has a published version; the draft differs from it
  data: Record<string, unknown>; updatedAt: string;
  keepCase?: Record<string, string[]> | null; // text the person chose not to auto-capitalise (see src/casing.ts)
  live?: { slug: string; data: Record<string, unknown> } | null; // single-entry reads only: the published version
  publishAt?: string | null; unpublishAt?: string | null; publishedAt?: string | null; revisedAt?: string | null; // go-live time; first and latest publish
  schedule?: { at: string; failed: boolean; error?: string }; // goes live at `at` (ISO); `failed` once its attempts ran out
  takeDown?: { at: string; failed: boolean; error?: string }; // comes off the site at `at`
  thumb?: string; // list view only: storage key of the thumbnail image, when the collection has a thumbnail field
};
export type EntryInput = Pick<Entry, "collection" | "slug" | "data" | "publishAt" | "unpublishAt"> & { keepCase?: Record<string, string[]> };

// The store sets this so a signed-out API call sends the user to the login screen.
export const hooks = { unauthorized: () => {} };

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch("/api" + path, { ...init, headers: { "content-type": "application/json" } });
  if (res.status === 401 && path !== "/login") hooks.unauthorized();
  if (!res.ok) {
    const e = (await res.json().catch(() => ({}))) as { error?: string; fieldErrors?: Record<string, string[]>; formErrors?: string[] };
    throw new Error(e.error ?? ([...(e.formErrors ?? []), ...Object.entries(e.fieldErrors ?? {}).map(([k, v]) => `${k}: ${v}`)].join("; ") || res.statusText || `Request failed (${res.status})`));
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

export type Settings = { repo?: string; branch?: string; dir?: string; hasToken: boolean; tokenError?: string };
export type SettingsInput = { repo: string; branch: string; dir: string; token?: string };

export type CollectionInput = { key?: string; label: string; slugSource?: string | null; titleField?: string | null; thumbField?: string | null; format?: "json" | "markdown" | "mdx" | null; folder?: string | null; bodyField?: string | null; urlTemplate?: string | null; single?: boolean; dates?: boolean; fields: Field[] };

export type Me = { id: string; email: string; role: "owner" | "member"; name?: string | null; avatar?: string | null };
export type Person = { id: string; name?: string | null; avatar?: string | null; email: string; role: "owner" | "member"; hasPassword: boolean };
export type Provider = { id: string; name: string; help: string; clientId: string; hasSecret: boolean; error?: string; source: "settings" | "environment" | null; callback: string };
export type Hit = Entry & { match: { title: string; snippet: string | null } }; // title and snippet have the matched words between \u0001 and \u0002
export type Notice = { id: string; at: string; kind: string; level: "error" | "success" | "info"; title: string; body: string | null; link: string | null; readAt: string | null };
export type Activity = { id: string; at: string; actor: string; via: string | null; action: string; collection: string | null; entryId: string | null; label: string | null; detail: string | null; undoable: number };
export type HealthRow = { id: string; collection: string; label: string; file: { key: string; size: number; width?: number; height?: number } };
export type MediaHealth = { total: number; counts: { unused: number; large: number; weakAlt: number }; unused: HealthRow[]; large: HealthRow[]; weakAlt: (HealthRow & { alt: string; altKey: string; why: string })[] };
export type BackupDest = { type: "r2"; accountId: string; bucket: string; accessKeyId: string; hasSecret?: boolean; prefix?: string } | { type: "ssh"; host: string; port?: number; user: string; path: string };
export type BackupState = { dest: BackupDest | null; pubkey: string | null; hasPassword: boolean; test: { state: "pending" | "running" | "ok" | "failed"; at: string; detail?: string } | null };
export type Used = { id: string; collection: string; slug: string; title: string };
export type Trashed = { id: string; at: string; actor: string; collection: string; label: string; entryId: string };
export type Counts = Record<string, { drafts: number; edited: number }>;
export type Connection = { id: string; name: string; lastActive: number };

export const api = {
  me: async (): Promise<Me | null> => { const r = await fetch("/api/session"); return r.ok ? r.json() : null; },
  authInfo: () => call<{ needsSetup: boolean; setup: "local" | "token" | "blocked"; providers: { id: string; name: string }[] }>("/auth"),
  login: (email: string, password: string) => call<void>("/login", { method: "POST", body: JSON.stringify({ email, password }) }),
  setup: (email: string, password: string, setupToken?: string) => call<void>("/setup", { method: "POST", body: JSON.stringify({ email, password, setupToken }) }),
  setupSocial: async (provider: string, setupToken?: string) => {
    const res = await fetch(`/auth/${provider}/setup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ setupToken }) });
    const body = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
    if (!res.ok || !body.url) throw new Error(body.error ?? res.statusText);
    return { url: body.url };
  },
  invitee: (secret: string) => call<{ email: string }>(`/invite/${secret}`),
  acceptInvite: (secret: string, password: string) => call<void>(`/invite/${secret}`, { method: "POST", body: JSON.stringify({ password }) }),
  people: () => call<Person[]>("/people"),
  invite: (email: string) => call<{ invite: string }>("/people", { method: "POST", body: JSON.stringify({ email }) }),
  reinvite: (id: string) => call<{ invite: string }>(`/people/${id}/invite`, { method: "POST" }),
  setRole: (id: string, role: "owner" | "member") => call<void>(`/people/${id}/role`, { method: "PUT", body: JSON.stringify({ role }) }),
  removePerson: (id: string) => call<void>(`/people/${id}`, { method: "DELETE" }),
  providers: () => call<Provider[]>("/providers"),
  saveProvider: (id: string, clientId: string, secret?: string) => call<void>(`/providers/${id}`, { method: "PUT", body: JSON.stringify({ clientId, secret: secret || undefined }) }),
  clearProvider: (id: string) => call<void>(`/providers/${id}`, { method: "DELETE" }),
  connections: () => call<Connection[]>("/connections"),
  disconnect: (id: string) => call<void>(`/connections/${id}`, { method: "DELETE" }),
  logout: () => call<void>("/logout", { method: "POST" }),
  mediaHealth: () => call<MediaHealth>("/media-health"),
  directory: () => call<{ email: string; name: string | null; avatar: string | null }[]>("/directory"),
  saveProfile: (p: { name: string | null; avatar: string | null }) => call<Me>("/profile", { method: "PUT", body: JSON.stringify(p) }),
  upload: async (f: File) => {
    const res = await fetch(`/api/uploads?name=${encodeURIComponent(f.name)}`, { method: "PUT", body: f });
    const body = (await res.json().catch(() => ({}))) as FileValue & { error?: string };
    if (res.status === 401) hooks.unauthorized();
    if (!res.ok) throw new Error(body.error ?? res.statusText);
    return body;
  },
  blocks: () => call<BlockDef[]>("/blocks"),
  saveBlock: (b: BlockDef) => call<BlockDef>(`/blocks/${b.key}`, { method: "PUT", body: JSON.stringify(b) }),
  templates: () => call<TemplateDef[]>("/templates"),
  saveTemplate: (t: TemplateDef) => call<TemplateDef>(`/templates/${t.key}`, { method: "PUT", body: JSON.stringify(t) }),
  deleteTemplate: (key: string) => call<void>(`/templates/${key}`, { method: "DELETE" }),
  deleteBlock: (key: string) => call<void>(`/blocks/${key}`, { method: "DELETE" }),
  collections: () => call<Collection[]>("/collections"),
  createCollection: (c: CollectionInput) => call<Collection>("/collections", { method: "POST", body: JSON.stringify(c) }),
  updateCollection: (key: string, c: CollectionInput) => call<Collection>(`/collections/${key}`, { method: "PUT", body: JSON.stringify(c) }),
  deleteCollection: (key: string) => call<void>(`/collections/${key}`, { method: "DELETE" }),
  settings: () => call<Settings>("/settings"),
  saveSettings: (s: SettingsInput) => call<void>("/settings", { method: "PUT", body: JSON.stringify(s) }),
  search: (collection: string, o: { q: string; sort: string; dir: "asc" | "desc"; limit: number; offset: number; filter?: string }) =>
    call<{ items: Entry[]; total: number }>(`/entries/search?${new URLSearchParams({ collection, q: o.q, sort: o.sort, dir: o.dir, limit: String(o.limit), offset: String(o.offset), filter: o.filter ?? "" })}`),
  matching: (collection: string, q: string, filter: string) => call<{ ids: string[]; total: number }>(`/entries/matching?${new URLSearchParams({ collection, q, filter })}`),
  list: (collection?: string) => call<Entry[]>("/entries" + (collection ? `?collection=${encodeURIComponent(collection)}` : "")),
  unused: (collection: string) => call<{ items: Entry[]; total: number; scanned: number }>(`/collections/${collection}/unused`, { method: "POST" }),
  usage: (id: string) => call<{ items: Used[]; links: Used[] }>(`/entries/${id}/usage`),
  get: (id: string) => call<Entry>(`/entries/${id}?live=1`),
  create: (e: EntryInput) => call<Entry>("/entries", { method: "POST", body: JSON.stringify(e) }),
  update: (id: string, e: EntryInput) => call<Entry>(`/entries/${id}`, { method: "PUT", body: JSON.stringify(e) }),
  slugAvailable: (collection: string, slug: string, except?: string) =>
    call<{ available: boolean; suggestion?: string }>(`/slug-available?${new URLSearchParams({ collection, slug, ...(except ? { except } : {}) })}`),
  build: () => call<{ pages: number; images: number; removed: number; paths: { type: "page" | "image" | "delete"; path: string }[]; more: number; warnings: string[]; conflicts: string[]; error?: string }>("/build", { method: "POST" }),
  checkAccess: (s: { repo?: string; branch?: string; token?: string }) => call<{ checks: AccessCheck[] }>("/settings/check", { method: "POST", body: JSON.stringify(s) }),
  ci: (sha: string) => call<{ state: "none" | "running" | "success" | "failed"; runs: { name: string; state: "running" | "success" | "failed"; url: string }[] }>(`/ci?sha=${sha}`),
  publish: () => call<{ changed: number; ref?: string; warnings?: string[]; remaining?: number }>("/publish", { method: "POST" }),
  counts: () => call<Counts>("/entries/counts"),
  activity: (o: { entry?: string; offset?: number; scheduled?: boolean; limit?: number } = {}) => call<{ items: Activity[]; total: number }>(`/activity?limit=${o.limit ?? 50}&offset=${o.offset ?? 0}${o.scheduled ? "&scheduled=1" : ""}${o.entry ? `&entry=${encodeURIComponent(o.entry)}` : ""}`),
  trash: () => call<{ items: Trashed[]; days: number }>("/trash"),
  activityChanges: (id: string) => call<{ changes: Change[]; slug: { from: string; to: string } | null; gone: boolean }>(`/activity/${id}/changes`),
  historySettings: () => call<{ keep: number; trashDays: number }>("/settings/history"),
  saveHistorySettings: (s: { keep: number; trashDays: number }) => call<void>("/settings/history", { method: "PUT", body: JSON.stringify(s) }),
  bulk: (ids: string[], action: "publish" | "unpublish" | "delete") => call<{ done: number; failed: { id: string; label: string; error: string }[] }>("/entries/bulk", { method: "POST", body: JSON.stringify({ ids, action }) }),
  undo: (id: string) => call<Entry>(`/activity/${id}/undo`, { method: "POST" }),
  schedule: () => call<{ kind: string; at: string; status: string; error: string | null; entry?: { id: string; collection: string; label: string } }[]>("/schedule"),
  values: (collection: string, field: string) => call<string[]>(`/collections/${collection}/values/${field}`),
  find: (q: string, limit = 20) => call<{ total: number; items: Hit[] }>(`/search?q=${encodeURIComponent(q)}&limit=${limit}`),
  recent: (limit = 10) => call<{ items: Entry[] }>(`/entries/recent?limit=${limit}`),
  backupDest: () => call<BackupState>("/backup/destination"),
  saveBackupDest: (d: Record<string, unknown>) => call<BackupState & { newPassword?: string }>("/backup/destination", { method: "PUT", body: JSON.stringify(d) }),
  testBackup: () => call<BackupState>("/backup/test", { method: "POST" }),
  backupPassword: () => call<{ password: string }>("/backup/password"),
  backupStatus: () => call<{ last: { at: string; detail: string } | null }>("/backup/status"),
  searchStatus: () => call<{ entries: number; indexed: number; links: number }>("/search/status"),
  rebuildSearch: () => call<void>("/search/rebuild", { method: "POST" }),
  notices: () => call<{ items: Notice[]; unread: number }>("/notifications"),
  readNotices: (id?: string) => call<void>(id ? `/notifications/${id}/read` : "/notifications/read", { method: "POST" }),
  dismissNotice: (id: string) => call<void>(`/notifications/${id}`, { method: "DELETE" }),
  notifySettings: () => call<{ success: boolean }>("/settings/notifications"),
  saveNotifySettings: (success: boolean) => call<void>("/settings/notifications", { method: "PUT", body: JSON.stringify({ success }) }),
  publishEntry: (id: string) => call<Entry>(`/entries/${id}/publish`, { method: "POST" }),
  unpublishEntry: (id: string) => call<Entry>(`/entries/${id}/unpublish`, { method: "POST" }),
  revertEntry: (id: string) => call<Entry>(`/entries/${id}/revert`, { method: "POST" }),
  remove: (id: string) => call<void>(`/entries/${id}`, { method: "DELETE" }),
};
