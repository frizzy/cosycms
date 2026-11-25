import type { Field } from "./fields.ts";
import { toMarkdown, type ImageResolver } from "./markdown.ts";
import type { BlockDef } from "./blocks.ts";

// Strings are always written as JSON strings: valid YAML, and never ambiguous (no "no", "1e3", "2026-01-01" surprises).
const str = JSON.stringify;
// YAML 1.1 parsers read these bare keys as booleans/null, so quote them.
const key = (k: string) => (/^(y|n|yes|no|on|off|true|false|null|~)$/i.test(k) ? str(k) : /^[A-Za-z_][A-Za-z0-9_-]*$/.test(k) ? k : str(k));

class Raw { s: string; constructor(s: string) { this.s = s; } } // written as-is (dates)
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Raw);
const scalar = (v: unknown) => (v instanceof Raw ? v.s : typeof v === "string" ? str(v) : String(v));

// A mapping entry at `ind`. Empty values produce no lines.
function entry(k: string, v: unknown, ind: string): string[] {
  if (v == null) return [];
  if (Array.isArray(v)) return v.length ? [`${ind}${key(k)}:`, ...v.flatMap((x) => item(x, ind + "  "))] : [];
  if (isObject(v)) { const inner = Object.entries(v).flatMap(([kk, vv]) => entry(kk, vv, ind + "  ")); return inner.length ? [`${ind}${key(k)}:`, ...inner] : []; }
  return [`${ind}${key(k)}: ${scalar(v)}`];
}

// A "- " list item at `ind`; a mapping item continues on the same line as the dash.
function item(v: unknown, ind: string): string[] {
  if (isObject(v)) {
    const inner = Object.entries(v).flatMap(([k, x]) => entry(k, x, ind + "  "));
    if (inner.length) inner[0] = ind + "- " + inner[0].slice(ind.length + 2);
    return inner;
  }
  return [`${ind}- ${Array.isArray(v) ? JSON.stringify(v) : scalar(v)}`];
}

function value(f: Field, v: unknown, images?: ImageResolver, mdx = false, blocks?: Map<string, BlockDef>): unknown {
  switch (f.type) {
    case "date": case "datetime": return v == null ? v : new Raw(String(v)); // unquoted, which YAML reads as a date / timestamp
    case "richtext": return v == null ? v : toMarkdown(v as never, images, { mdx, blocks, imageComponent: f.imageComponent }).trimEnd();
    default: return v; // text, numbers, lists, and resolved references/files (plain objects) all emit as they are
  }
}

/** YAML frontmatter for every field except the body, in the collection's field order. */
export function frontmatter(fields: Field[], data: Record<string, unknown>, bodyKey?: string | null, images?: ImageResolver, mdx = false, blocks?: Map<string, BlockDef>) {
  const lines = fields.filter((f) => f.key !== bodyKey).flatMap((f) => entry(f.key, value(f, data[f.key], images, mdx, blocks), ""));
  return lines.length ? `---\n${lines.join("\n")}\n---\n` : "";
}
