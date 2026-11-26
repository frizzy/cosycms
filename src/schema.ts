import type { Field } from "./fields";
import type { PropDef } from "./blocks";
import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";

// DB is the source of truth. `body` is the editor's native JSON (e.g. Tiptap), serialised.
export const entries = sqliteTable("entries", {
  id: text().primaryKey(),
  collection: text().notNull(),
  slug: text().notNull(),
  // `data` and `slug` are the working draft: every edit lands there. `live` is the version a person last published; only that goes to the
  // site, so editing a published entry never changes what's live. `status` is "published" exactly when `live` is set (kept so lists can sort by it).
  status: text({ enum: ["draft", "published"] }).notNull().default("draft"),
  data: text({ mode: "json" }).$type<Record<string, unknown>>().notNull(),
  live: text({ mode: "json" }).$type<{ slug: string; data: Record<string, unknown> } | null>(),
  pending: integer({ mode: "boolean" }).notNull().default(false), // published, and the draft differs from `live` (kept up to date on every write so lists and counts need no comparing)
  updatedAt: integer({ mode: "timestamp_ms" }).notNull(),
}, (t) => [uniqueIndex("entries_path").on(t.collection, t.slug), index("entries_status").on(t.status)]);

// Per-target publish state: lets publishes be incremental and detects out-of-band edits later.
export const publishState = sqliteTable("publish_state", {
  target: text().notNull(),
  entryId: text().notNull(),
  path: text().notNull().default(""), // default only because SQLite can't add NOT NULL columns without one
  hash: text().notNull(),
  ref: text(),
}, (t) => [uniqueIndex("publish_state_pk").on(t.target, t.entryId)]);

// Instance settings (publish target config). shortcut: token stored in plaintext; encrypt with a Worker secret key before multi-user/hosted use.
export const settings = sqliteTable("settings", {
  key: text().primaryKey(),
  value: text().notNull(),
});

// Collection definitions live in the DB so they can be edited from the admin.
export const collections = sqliteTable("collections", {
  key: text().primaryKey(),
  label: text().notNull(),
  slugSource: text(), // key of the field entry slugs are generated from
  titleField: text(), // key of the text field shown as the entry's title in lists and pickers
  thumbField: text(), // key of the image (or image-library reference) field shown as a thumbnail in lists
  format: text({ enum: ["json", "markdown", "mdx"] }), // null = json
  folder: text(), // published folder; null = the collection key
  urlTemplate: text(), // where an entry lives on the site, e.g. /blog/{slug}; lets links in text point at entries
  bodyField: text(), // markdown: the rich text field written as the file body
  single: integer({ mode: "boolean" }).notNull().default(false), // holds exactly one entry (a home page, site settings): the list opens it directly and a second can't be added
  scheduleField: text(), // key of the datetime field that says when an entry goes live; a future time publishes (and deploys) it then
  fields: text({ mode: "json" }).$type<Field[]>().notNull(),
  updatedAt: integer({ mode: "timestamp_ms" }).notNull(),
});

// Sign-in and OAuth. Only the SHA-256 of a secret is stored, so a leaked database can't be replayed.
export const tokens = sqliteTable("tokens", {
  hash: text().primaryKey(),
  kind: text({ enum: ["session", "code", "access", "refresh", "invite", "state"] }).notNull(),
  userId: text(), // whose token this is; everything a user holds goes when the user does
  clientId: text(), // OAuth client the token was issued to; null for browser sessions
  data: text({ mode: "json" }).$type<Record<string, string>>(), // codes: challenge + redirectUri; state: where to go after sign-in
  expiresAt: integer({ mode: "timestamp_ms" }).notNull(),
});

// MCP clients register themselves (RFC 7591). Public clients: PKCE instead of a client secret.
export const clients = sqliteTable("clients", {
  id: text().primaryKey(),
  name: text().notNull(),
  redirectUris: text({ mode: "json" }).$type<string[]>().notNull(),
  createdAt: integer({ mode: "timestamp_ms" }).notNull(),
});

// People who can sign in. A user with no password yet was invited and signs in with a social account (matched by verified email) or an invite link.
export const users = sqliteTable("users", {
  id: text().primaryKey(),
  email: text().notNull().unique(), // lowercased
  role: text({ enum: ["owner", "member"] }).notNull(),
  passwordHash: text(),
  createdAt: integer({ mode: "timestamp_ms" }).notNull(),
});

// Reusable content blocks (a call-out, a button, a gallery) that rich text fields can allow. See src/blocks.ts.
export const blocks = sqliteTable("blocks", {
  key: text().primaryKey(), // the component name, e.g. "Gallery"
  label: text().notNull(),
  content: text({ enum: ["none", "inline", "blocks"] }).notNull(),
  props: text({ mode: "json" }).$type<PropDef[]>().notNull(),
  updatedAt: integer({ mode: "timestamp_ms" }).notNull(),
});

// Starting points for rich text fields: a body that fills an empty field, and a prompt that gives MCP clients context. See src/templates.ts.
export const templates = sqliteTable("templates", {
  key: text().primaryKey(),
  label: text().notNull(),
  body: text({ mode: "json" }).$type<{ type: string; content?: unknown[] } | null>(), // an editor document; none = a prompt only
  prompt: text().notNull(),
  updatedAt: integer({ mode: "timestamp_ms" }).notNull(),
});

// Who did what, newest first. `detail` never holds secrets or content, only names and the keys of changed fields; `before` is the one place content is kept.
export const activity = sqliteTable("activity", {
  id: text().primaryKey(),
  at: integer({ mode: "timestamp_ms" }).notNull(),
  actor: text().notNull(),   // the signed-in person's email
  via: text(),               // the connected app they acted through (an MCP client), if any
  action: text().notNull(),  // entry.create, entry.save, entry.publish, deploy, collection.save, ...
  collection: text(),
  entryId: text(),
  label: text(),             // what it was called at the time (an entry's title, a collection's name, ...)
  detail: text(),
  before: text({ mode: "json" }).$type<{ slug: string; data: Record<string, unknown> } | null>(), // an entry's draft just before the change, so it can be undone (see /activity/:id/undo)
}, (t) => [index("activity_at").on(t.at), index("activity_entry").on(t.entryId, t.at)]);

// Things to do later, one row per job. A tick every minute runs what is due (see src/schedule.ts); the row is the "wait".
export const schedule = sqliteTable("schedule", {
  id: text().primaryKey(),
  kind: text().notNull(),  // which handler runs it: entry.publish, deploy.run, ...
  ref: text().notNull(),   // what it is about, e.g. an entry id; one job per (kind, ref)
  runAt: integer({ mode: "timestamp_ms" }).notNull(),
  status: text({ enum: ["pending", "running", "done", "failed"] }).notNull().default("pending"),
  attempts: integer().notNull().default(0),
  error: text(),
  payload: text({ mode: "json" }).$type<string[]>(), // deploy.run: the entries it may send (the ones the scheduler published)
  updatedAt: integer({ mode: "timestamp_ms" }).notNull(),
}, (t) => [uniqueIndex("schedule_job").on(t.kind, t.ref), index("schedule_due").on(t.status, t.runAt)]);
