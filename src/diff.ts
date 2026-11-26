import type { Field } from "./fields.ts";

// What changed between two versions of an entry's data, shaped for showing to a person: short values as before/after, lists as
// added/removed, long text and rich text as changed lines.
export type Line = { t: "same" | "add" | "del"; s: string };
export type Gap = { t: "gap"; n: number };
export type Change =
  | { key: string; label: string; kind: "value"; before: string; after: string }
  | { key: string; label: string; kind: "list"; added: string[]; removed: string[] }
  | { key: string; label: string; kind: "lines"; lines: (Line | Gap)[] }
  | { key: string; label: string; kind: "note"; note: string };

/** Line-by-line difference (longest common subsequence). shortcut: past ~4 million line pairs it falls back to "all replaced", fine for a post, revisit for a book. */
export function lineDiff(a: string[], b: string[]): Line[] {
  if (a.length * b.length > 4_000_000) return [...a.map((s) => ({ t: "del" as const, s })), ...b.map((s) => ({ t: "add" as const, s }))];
  const n = a.length, m = b.length, w = m + 1, len = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) len[i * w + j] = a[i] === b[j] ? len[(i + 1) * w + j + 1] + 1 : Math.max(len[(i + 1) * w + j], len[i * w + j + 1]);
  const out: Line[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ t: "same", s: a[i] }); i++; j++; }
    else if (len[(i + 1) * w + j] >= len[i * w + j + 1]) out.push({ t: "del", s: a[i++] });
    else out.push({ t: "add", s: b[j++] });
  }
  while (i < n) out.push({ t: "del", s: a[i++] });
  while (j < m) out.push({ t: "add", s: b[j++] });
  return out;
}

/** Keeps the changed lines and `ctx` lines around them; longer unchanged runs become a gap. */
export function collapse(lines: Line[], ctx = 1): (Line | Gap)[] {
  const keep = lines.map((l, i) => l.t !== "same" || lines.slice(Math.max(0, i - ctx), i + ctx + 1).some((x) => x.t !== "same"));
  const out: (Line | Gap)[] = [];
  lines.forEach((l, i) => {
    if (keep[i]) out.push(l);
    else if (out.length && (out[out.length - 1] as Gap).t === "gap") (out[out.length - 1] as Gap).n++;
    else out.push({ t: "gap", n: 1 });
  });
  return out;
}

type Node = { type?: string; text?: string; attrs?: Record<string, unknown>; content?: Node[] };
const LINE_END = new Set(["paragraph", "heading", "codeBlock", "listItem", "blockquote", "rawBlock", "libraryImage", "horizontalRule"]);

/** Rich text (an editor document) as plain lines, so two versions can be compared. Images and blocks show as a marker. */
export function docText(doc: unknown): string {
  const walk = (n: Node): string => {
    if (n.type === "text") return n.text ?? "";
    if (n.type === "hardBreak") return "\n";
    if (n.type === "libraryImage") return `[image${n.attrs?.alt ? `: ${n.attrs.alt}` : ""}]\n`;
    if (n.type === "rawBlock" || n.type === "rawInline") return `[${String(n.attrs?.raw ?? n.attrs?.text ?? "block").slice(0, 60)}]${n.type === "rawBlock" ? "\n" : ""}`;
    const inner = (n.content ?? []).map(walk).join("");
    if (n.type === "heading") return `${"#".repeat(Number(n.attrs?.level ?? 1))} ${inner}\n`;
    if (n.type === "listItem") return `• ${inner.trimEnd()}\n`;
    return LINE_END.has(n.type ?? "") ? `${inner}\n` : inner;
  };
  return doc && typeof doc === "object" ? walk(doc as Node).split("\n").map((l) => l.trimEnd()).filter(Boolean).join("\n") : "";
}

const norm = (v: unknown) => (v == null || v === "" || v === false || (Array.isArray(v) && !v.length) ? null : v);
const same = (a: unknown, b: unknown) => JSON.stringify(norm(a)) === JSON.stringify(norm(b));
const show = (v: unknown): string => {
  if (norm(v) === null) return v === false ? "No" : "—";
  if (v === true) return "Yes";
  if (Array.isArray(v)) return v.map(String).join(", ");
  if (typeof v === "object") return String((v as { name?: string; key?: string }).name ?? (v as { key?: string }).key ?? JSON.stringify(v));
  return String(v);
};

/** The fields of `fields` whose values differ between `before` and `after`, in field order. */
export function fieldChanges(fields: Field[], before: Record<string, unknown>, after: Record<string, unknown>): Change[] {
  const out: Change[] = [];
  for (const f of fields) {
    if (f.type === "datetime" && f.autoSet === "save") continue; // set by the system on every save, not something a person changed
    const a = before[f.key], b = after[f.key];
    if (same(a, b)) continue;
    const base = { key: f.key, label: f.label || f.key };
    if (f.type === "richtext") out.push({ ...base, kind: "lines", lines: collapse(lineDiff(docText(a).split("\n").filter(Boolean), docText(b).split("\n").filter(Boolean))) });
    else if (f.type === "reference") out.push({ ...base, kind: "note", note: "changed" });
    else if (Array.isArray(a) || Array.isArray(b)) {
      const x = ((a as unknown[]) ?? []).map(String), y = ((b as unknown[]) ?? []).map(String);
      out.push({ ...base, kind: "list", added: y.filter((v) => !x.includes(v)), removed: x.filter((v) => !y.includes(v)) });
    } else if (f.type === "textarea" && (String(a ?? "").includes("\n") || String(b ?? "").includes("\n") || String(a ?? "").length > 80 || String(b ?? "").length > 80))
      out.push({ ...base, kind: "lines", lines: collapse(lineDiff(String(a ?? "").split("\n"), String(b ?? "").split("\n"))) });
    else out.push({ ...base, kind: "value", before: show(a), after: show(b) });
  }
  return out;
}
