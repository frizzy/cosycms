import { docText } from "./diff.ts";
import { entryLabel, type Field } from "./fields.ts";

// A search index (full text, SQLite FTS5) and a "who mentions whom" table, both rebuilt from the entries whenever needed.
// Every write path calls reindex(); a failed index write never fails the save, it just leaves the index stale until the next rebuild (Settings > Search).
export const INDEX_VERSION = "1"; // bump when what gets indexed changes: the next request rebuilds
export type Col = { fields: Field[]; titleField?: string | null };
export type Indexable = { id: string; collection: string; slug: string; data: Record<string, unknown>; live?: { data: Record<string, unknown> } | null };
export type Hit = { entry: string; title: string; snip: string | null };

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const MARK_A = "\u0001", MARK_B = "\u0002"; // around matched words in titles and snippets; the admin turns them into highlights

/** What the index holds for an entry: its title, its tags (select values), and every other text (short text, long text, rich text flattened to lines). */
export function indexText(col: Col, e: Indexable) {
  const tags: string[] = [], body: string[] = [];
  for (const f of col.fields) {
    const v = e.data[f.key];
    if (v == null || v === "") continue;
    if (f.type === "select") tags.push(...[v].flat().map(String));
    else if (f.key === col.titleField) continue; // already the title
    else if (f.type === "text" || f.type === "textarea") body.push(String(v));
    else if (f.type === "richtext") body.push(docText(v));
  }
  return { title: entryLabel(col.fields, e.data, e.slug, col.titleField), tags: tags.join(" "), body: body.join("\n"), slug: e.slug };
}

/** Every id-shaped string in the given JSON values: an entry is "used" when its id appears in another entry's draft or published data, or a template. */
export const idsIn = (...values: unknown[]) => [...new Set(values.flatMap((v) => (v == null ? [] : [...JSON.stringify(v).matchAll(UUID)].map((m) => m[0]))))];

/** A user's words as an FTS5 query: every word must match, the last as a prefix too (so it works while typing). Null when there are no words. */
export function ftsQuery(q: string): string | null {
  const words = q.match(/[\p{L}\p{N}]+/gu);
  return words ? words.map((w) => `"${w}"*`).join(" ") : null;
}

const upsert = (d1: D1Database, e: Indexable, col: Col | undefined) => {
  const t = col ? indexText(col, e) : { title: e.slug, tags: "", body: "", slug: e.slug };
  return [
    d1.prepare("insert into search_doc(entry, collection, slug, title, tags, body) values (?, ?, ?, ?, ?, ?) on conflict(entry) do update set collection = excluded.collection, slug = excluded.slug, title = excluded.title, tags = excluded.tags, body = excluded.body")
      .bind(e.id, e.collection, t.slug, t.title, t.tags, t.body),
    d1.prepare("delete from refs where src = ?").bind(e.id),
    ...idsIn(e.data, e.live?.data).filter((id) => id !== e.id).map((id) => d1.prepare("insert or ignore into refs(src, dst) values (?, ?)").bind(e.id, id)),
  ];
};

export async function reindex(d1: D1Database, col: Col | undefined, e: Indexable) {
  try { await d1.batch(upsert(d1, e, col)); } catch (err) { console.error("search index", err); }
}
export async function unindex(d1: D1Database, id: string) {
  try { await d1.batch([d1.prepare("delete from search_doc where entry = ?").bind(id), d1.prepare("delete from refs where src = ?").bind(id)]); } catch (err) { console.error("search index", err); }
}
export async function reindexTemplate(d1: D1Database, key: string, body: unknown) {
  try { await d1.batch([d1.prepare("delete from refs where src = ?").bind(`template:${key}`), ...idsIn(body).map((id) => d1.prepare("insert or ignore into refs(src, dst) values (?, ?)").bind(`template:${key}`, id))]); } catch (err) { console.error("search index", err); }
}
export const unindexTemplate = (d1: D1Database, key: string) => reindexTemplate(d1, key, null);

/** Throws the index away and builds it again from the given entries and templates. */
export async function rebuild(d1: D1Database, cols: Map<string, Col>, entries: Indexable[], templates: { key: string; body: unknown }[]) {
  const stmts: D1PreparedStatement[] = [d1.prepare("delete from search_doc"), d1.prepare("delete from refs")];
  for (const e of entries) stmts.push(...upsert(d1, e, cols.get(e.collection)).filter((_, i) => i !== 1)); // nothing to clear per entry after the delete above
  for (const t of templates) stmts.push(...idsIn(t.body).map((id) => d1.prepare("insert or ignore into refs(src, dst) values (?, ?)").bind(`template:${t.key}`, id)));
  for (let i = 0; i < stmts.length; i += 80) await d1.batch(stmts.slice(i, i + 80)); // shortcut: a few thousand entries rebuild in seconds; chunk across requests beyond that
}

/** Ranked matches: title words count most, then tags, slug, body. Collections in `last` (image libraries: short captions would crowd out real content) come after the rest. `title` has the matched words marked; `snip` is a body excerpt when the body matched. */
export async function searchIndex(d1: D1Database, q: string, limit: number, last: string[] = []): Promise<{ hits: Hit[]; total: number }> {
  const fts = ftsQuery(q);
  if (!fts) return { hits: [], total: 0 };
  const { results } = await d1.prepare(
    `select d.entry, highlight(search, 0, char(1), char(2)) as title, snippet(search, 2, char(1), char(2), '…', 14) as snip
     from search join search_doc d on d.id = search.rowid where search match ?1 order by d.collection in (select value from json_each(?3)), bm25(search, 10.0, 6.0, 1.0, 3.0) limit ?2`).bind(fts, limit, JSON.stringify(last)).all<{ entry: string; title: string; snip: string }>();
  const total = (await d1.prepare("select count(*) n from search where search match ?1").bind(fts).first<{ n: number }>())?.n ?? 0;
  return { hits: results.map((r) => ({ entry: r.entry, title: r.title, snip: r.snip.includes(MARK_A) ? r.snip : null })), total };
}
