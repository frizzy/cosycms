import type { Context } from "hono";
import { toMarkdown, type Node } from "./markdown";
import { fromMarkdown, LIBRARY_PREFIX } from "./markdown-import";
import { entryLabel } from "./fields";

// A small MCP server (Streamable HTTP, stateless, JSON replies). Tools don't re-implement anything: each one calls the
// same /api routes the admin uses, with the caller's own credentials, so validation and permissions are identical.
type Api = { fetch(r: Request, env: unknown): Response | Promise<Response> };
type Call = (method: string, path: string, body?: unknown) => Promise<{ ok: boolean; body: any }>;
type Tool = { name: string; description: string; properties: Record<string, unknown>; required?: string[]; hint?: "read" | "write" | "destroy"; run(a: any, call: Call): Promise<unknown> };

const RICH = "Rich text fields are read and written as Markdown. Images from the media library are lines like ![alt](cosy:entry/<id>) and blocks are components such as <Figure …>…</Figure>: keep those exactly as they are, they are how the entry stays linked to its images and blocks. A link to another entry is [text](cosy:entry/<id>) (find the id with search_entries); it becomes that entry's page address when published.";
const entryProps = { collection: { type: "string", description: "Collection key" }, slug: { type: "string", description: "lowercase-letters-numbers-dashes, unique in the collection" },
  data: { type: "object", description: "Field values keyed by field key. " + RICH } };

const TOOLS: Tool[] = [
  { name: "list_collections", hint: "read", description: "List collections with their fields. Read this first: it tells you which keys and types an entry's data takes.", properties: {}, run: (_, call) => call("GET", "/api/collections") },
  { name: "list_entries", hint: "read", description: "List the entries of one collection, newest change first, a page at a time. Returns id, slug, title and state for each (use get_entry for the content). state is draft, published, or edited (published, with draft changes not yet live).",
    properties: { collection: { type: "string", description: "Collection key" }, limit: { type: "number", description: "Page size, up to 100 (default 25)" }, offset: { type: "number" } }, required: ["collection"],
    run: (a, call) => search(call, a) },
  { name: "search_entries", hint: "read", description: "Find entries in one collection by words in the slug, tags, any text field or the body. Whole words and the beginnings of words match ('cla' finds 'clay'), not the middle of a word. Best match first unless you sort. Same result as list_entries: id, slug, title and state. Then get_entry by id, or by collection and slug.",
    properties: { collection: { type: "string", description: "Collection key" }, query: { type: "string" }, sort: { type: "string", enum: ["relevance", "updated", "title", "slug", "status"] }, limit: { type: "number" }, offset: { type: "number" } }, required: ["collection", "query"],
    run: (a, call) => search(call, a) },
  { name: "search_content", hint: "read", description: "Search every collection at once, bodies included, best matches first. Use it to find where something is written about. Returns collection, id, slug, title, state and a short excerpt with the matched words in **bold**; then get_entry. Whole words and the beginnings of words match, not the middle of a word. Image-library captions come after the other content.",
    properties: { query: { type: "string" }, limit: { type: "number", description: "Up to 25 (default 10)" } }, required: ["query"],
    async run(a, call) {
      const r = await call("GET", `/api/search?q=${encodeURIComponent(a.query ?? "")}&limit=${Math.min(Math.max(a.limit ?? 10, 1), 25)}`);
      if (!r.ok) return r;
      const plain = (s: string) => s.replace(/[\u0001\u0002]/g, ""), bold = (s: string) => s.replace(/[\u0001\u0002]/g, "**");
      return { ok: true, body: { total: r.body.total, items: r.body.items.map((e: any) => ({ collection: e.collection, id: e.id, slug: e.slug, title: plain(e.match.title), state: !e.published ? "draft" : e.pending ? "edited" : "published", excerpt: e.match.snippet ? bold(e.match.snippet) : undefined })) } };
    } },
  { name: "get_entry", hint: "read", description: "Get one entry. Give its id, or its collection and slug (easier than copying an id; ids are long and must be exact).",
    properties: { id: { type: "string" }, collection: { type: "string" }, slug: { type: "string" } },
    async run(a, call) {
      const r = await fetchEntry(a, call);
      if (!r.ok) return r;
      const rich = await richOf(call, r.body.collection), data = { ...r.body.data };
      for (const f of rich.fields) if (data[f.key] && typeof data[f.key] === "object") data[f.key] = rich.toMd(f, data[f.key]);
      return { ok: true, body: { ...r.body, data } };
    } },
  { name: "replace_text", hint: "write", description: "Change part of a rich text field without resending the whole thing: replaces `find` with `replace` in the field's Markdown, in the draft. `find` must match exactly and appear once (make it longer if it appears more than once, or set all). Prefer this to update_entry for small edits.",
    properties: { id: { type: "string" }, collection: { type: "string" }, slug: { type: "string" }, field: { type: "string", description: "Key of the rich text field, e.g. content" }, find: { type: "string" }, replace: { type: "string" }, all: { type: "boolean", description: "Replace every occurrence" } },
    required: ["field", "find", "replace"],
    async run(a, call) {
      const r = await fetchEntry(a, call);
      if (!r.ok) return r;
      const rich = await richOf(call, r.body.collection), f = rich.fields.find((x) => x.key === a.field);
      if (!f) return { ok: false, body: { error: `"${a.field}" isn't a rich text field of ${r.body.collection}.` } };
      if (!a.find) return { ok: false, body: { error: "`find` can't be empty." } };
      const md = r.body.data[f.key] ? rich.toMd(f, r.body.data[f.key]) : "", parts = md.split(a.find), n = parts.length - 1;
      if (!n) return { ok: false, body: { error: "That text isn't in the field's current Markdown. Read the entry with get_entry and copy it exactly." } };
      if (n > 1 && !a.all) return { ok: false, body: { error: `That text appears ${n} times. Include more around it so it appears once, or set all to replace every one.` } };
      const data = { ...r.body.data, [f.key]: rich.fromMd(f, parts.join(a.replace)) };
      const w = await call("PUT", `/api/entries/${encodeURIComponent(r.body.id)}`, { collection: r.body.collection, slug: r.body.slug, data });
      return w.ok ? { ok: true, body: { replaced: n, id: r.body.id, published: w.body.published, pending: w.body.pending } } : w;
    } },
  { name: "list_templates", hint: "read", description: "List the templates: each has a key, a label, a prompt (how to write with it, or what it is for, such as guidance for generating images) and, if it has one, its starting content as Markdown. A rich text field's `templates` lists the keys it can start from.", properties: {},
    async run(_, call) {
      const r = await call("GET", "/api/templates");
      return r.ok ? { ok: true, body: r.body.map((t: any) => ({ key: t.key, label: t.label, prompt: t.prompt, ...(t.body ? { body: toMarkdown(t.body, undefined, { mdx: true }).trimEnd() } : {}) })) } : r;
    } },
  { name: "create_entry", hint: "write", description: "Create an entry as a draft. Drafts never go live by themselves: a person reviews and publishes them in the admin. Give `template` (see list_templates) to start each rich text field that allows it, and that you leave out of data, from the template's content.", properties: { ...entryProps, template: { type: "string", description: "Template key; its content fills the entry's empty rich text fields that allow it" } }, required: ["collection", "slug", "data"],
    async run({ template, ...a }, call) {
      const data = await markdown(call, a.collection, a.data);
      if (template) {
        const t = (await call("GET", "/api/templates")).body?.find?.((x: any) => x.key === template);
        if (!t) return { ok: false, body: { error: `There is no template "${template}". See list_templates.` } };
        for (const f of (await richOf(call, a.collection)).fields as (RichField & { templates?: string[] })[]) if (t.body && f.templates?.includes(template) && !data[f.key]) data[f.key] = t.body;
      }
      return call("POST", "/api/entries", { ...a, data });
    } },
  { name: "update_entry", hint: "write", description: "Change an entry's draft. Only the data keys you send change; set a key to null to clear it. If the entry is published, the live version is untouched until a person publishes the changes.",
    properties: { id: { type: "string" }, slug: entryProps.slug, data: entryProps.data }, required: ["id"],
    async run(a, call) {
      const old = await call("GET", `/api/entries/${encodeURIComponent(a.id)}`);
      if (!old.ok) return old;
      const data: Record<string, unknown> = { ...old.body.data, ...(await markdown(call, old.body.collection, a.data ?? {})) };
      for (const k of Object.keys(data)) if (data[k] === null) delete data[k];
      return call("PUT", `/api/entries/${encodeURIComponent(a.id)}`, { collection: old.body.collection, slug: a.slug ?? old.body.slug, data });
    } },
  { name: "delete_entry", hint: "destroy", description: "Delete an entry. Refused while other entries still use it.", properties: { id: { type: "string" } }, required: ["id"], run: (a, call) => call("DELETE", `/api/entries/${encodeURIComponent(a.id)}`) },
];

/** One page of an entry list without the bodies: an id, slug, title and state per entry. */
async function search(call: Call, a: { collection: string; query?: string; sort?: string; limit?: number; offset?: number }) {
  const [cols, r] = await Promise.all([call("GET", "/api/collections"), call("GET", `/api/entries/search?collection=${encodeURIComponent(a.collection)}&q=${encodeURIComponent(a.query ?? "")}&sort=${a.sort ?? (a.query?.trim() ? "relevance" : "updated")}&limit=${Math.min(Math.max(a.limit ?? 25, 1), 100)}&offset=${Math.max(a.offset ?? 0, 0)}`)]);
  if (!r.ok) return r;
  const col = cols.body?.find?.((c: any) => c.key === a.collection);
  return { ok: true, body: { total: r.body.total, items: r.body.items.map((e: any) => ({ id: e.id, slug: e.slug, title: col ? entryLabel(col.fields, e.data, e.slug, col.titleField) : e.slug,
    state: !e.published ? "draft" : e.pending ? "edited" : "published", updatedAt: e.updatedAt })) } };
}

/** How a collection's rich text fields turn into Markdown (to read) and back into a document (to save). */
type RichField = { key: string; type: string; blocks?: string[]; imageComponent?: string; templates?: string[] };
async function richOf(call: Call, collection: string) {
  const col = (await call("GET", "/api/collections")).body?.find?.((c: any) => c.key === collection);
  const fields: RichField[] = (col?.fields ?? []).filter((f: RichField) => f.type === "richtext");
  const defs: any[] = fields.some((f) => f.blocks?.length) ? (await call("GET", "/api/blocks")).body ?? [] : [];
  const mdx = col?.format === "mdx", allowed = (f: RichField) => defs.filter((d) => f.blocks?.includes(d.key));
  return {
    fields,
    // Library images keep their entry id (cosy:entry/<id>) so the text stays linked to them when it comes back.
    toMd: (f: RichField, doc: unknown) => toMarkdown(doc as Node, (id, a) => ({ src: LIBRARY_PREFIX + id, alt: String(a.alt ?? "") }), { mdx, imageComponent: f.imageComponent, blocks: new Map(allowed(f).map((d) => [d.key, d])) }).trimEnd(),
    fromMd: (f: RichField, md: string) => ({ type: "doc", content: fromMarkdown(md, { mdx, imageComponent: f.imageComponent, blocks: allowed(f) }) }),
  };
}

/** Strings given for rich text fields are Markdown; turn them into the editor's document format. */
async function markdown(call: Call, collection: string, data: Record<string, unknown>) {
  const rich = await richOf(call, collection), out = { ...data };
  for (const f of rich.fields) if (typeof out[f.key] === "string") out[f.key] = rich.fromMd(f, out[f.key] as string);
  return out;
}

/** The entry as the API has it, found by id or by collection and slug. */
async function fetchEntry(a: { id?: string; collection?: string; slug?: string }, call: Call) {
  if (a.id) return call("GET", `/api/entries/${encodeURIComponent(a.id)}`);
  if (!a.collection || !a.slug) return { ok: false, body: { error: "Give an id, or both collection and slug." } };
  const r = await call("GET", `/api/entries?collection=${encodeURIComponent(a.collection)}&slug=${encodeURIComponent(a.slug)}`);
  return r.ok && !r.body?.length ? { ok: false, body: { error: `There is no entry with slug "${a.slug}" in "${a.collection}". Try search_entries.` } } : r.ok ? { ok: true, body: r.body[0] } : r;
}

const VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const ok = (id: unknown, result: unknown) => ({ jsonrpc: "2.0", id, result });
const err = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

async function handle(msg: any, call: Call) {
  const { id, method, params } = msg ?? {};
  if (id === undefined) return undefined; // a notification: nothing to answer
  switch (method) {
    case "initialize":
      return ok(id, { protocolVersion: VERSIONS.includes(params?.protocolVersion) ? params.protocolVersion : VERSIONS[0], capabilities: { tools: {} }, serverInfo: { name: "cosycms", version: "0.1.0" },
        instructions: "Manage content: call list_collections first, then create or update entries. Changes stay in the CMS until publish is called." });
    case "ping": return ok(id, {});
    case "tools/list":
      return ok(id, { tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: { type: "object", properties: t.properties, required: t.required ?? [] },
        annotations: { readOnlyHint: t.hint === "read", destructiveHint: t.hint === "destroy" } })) });
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) return err(id, -32602, `Unknown tool: ${params?.name}`);
      const r = (await tool.run(params.arguments ?? {}, call)) as { ok: boolean; body: any };
      if (!r.ok && r.body?.error === "not found") r.body = { error: "No entry has that id. Ids are long and must be copied exactly from list_entries or search_entries results; or use get_entry with collection and slug." };
      const text = r.body === undefined ? "Done." : JSON.stringify(r.body, null, 2);
      return ok(id, { content: [{ type: "text", text }], isError: !r.ok });
    }
    default: return err(id, -32601, `Method not found: ${method}`);
  }
}

/** Mount behind requireAuth: `root.post("/mcp", requireAuth, mcpHandler(root))`. */
export const mcpHandler = (api: Api) => async (c: Context) => {
  const origin = new URL(c.req.url).origin;
  const headers: Record<string, string> = { "content-type": "application/json" };
  for (const h of ["authorization", "cookie"]) if (c.req.header(h)) headers[h] = c.req.header(h)!;
  const call: Call = async (method, path, body) => {
    const res = await api.fetch(new Request(origin + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), c.env);
    const parsed = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { ok: res.ok, body: parsed };
  };
  let msg: any;
  try { msg = await c.req.json(); } catch { return c.json(err(null, -32700, "Parse error"), 400); }
  const batch = Array.isArray(msg);
  const replies = (await Promise.all((batch ? msg : [msg]).map((m: any) => handle(m, call).catch((e) => err(m?.id ?? null, -32603, String(e.message ?? e)))))).filter(Boolean);
  if (!replies.length) return c.body(null, 202);
  return c.json(batch ? replies : replies[0]);
};
