// Automatic capitalisation for text fields and rich text headings. It only ever raises letters (so NASA, iPhone and eBay survive),
// except that title case lowers the first letter of a small word like "And" in the middle of a title.
export type Casing = "words" | "title";

// shortcut: English small words only; another language needs its own list.
const SMALL = new Set(["a", "an", "the", "and", "but", "or", "nor", "for", "so", "yet", "of", "in", "on", "at", "to", "by", "up", "as", "from", "with", "via", "per", "is", "vs"]);

const up = (s: string) => s.replace(/\p{L}/u, (c) => c.toUpperCase()); // first letter of s, skipping leading quotes, brackets and digits
const raise = (s: string) => (/^\P{L}*\d/u.test(s) ? s : up(s)); // "3rd" stays; "(the" becomes "(The"
const upperCount = (s: string) => (s.match(/\p{Lu}/gu) ?? []).length;

function line(s: string, mode: Casing): string {
  const toks = s.split(/(\s+)/), at: number[] = [];
  toks.forEach((t, i) => { if (i % 2 === 0 && t) at.push(i); });
  return toks.map((t, i) => {
    const w = at.indexOf(i);
    if (w < 0 || /:\/\/|@|^www\./i.test(t)) return t; // spacing, links and addresses
    if (mode === "title") {
      const core = t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
      const prev = w > 0 ? toks[at[w - 1]] : "";
      const small = SMALL.has(core.toLowerCase()) && w > 0 && w < at.length - 1 && !/[:.!?]$/.test(prev);
      if (small) return upperCount(core) <= 1 && /^\p{Lu}/u.test(core) ? t.replace(/\p{L}/u, (c) => c.toLowerCase()) : t;
    }
    return t.split("-").map(raise).join("-");
  }).join("");
}

/** The text with its words capitalised, line by line. */
export const capitalise = (s: string, mode: Casing) => s.split("\n").map((l) => line(l, mode)).join("\n");

type Node = { type?: string; text?: string; content?: Node[] };
const textsOf = (n: Node): Node[] => (n.type === "text" && typeof n.text === "string" ? [n] : (n.content ?? []).flatMap(textsOf));
const headingText = (n: Node) => textsOf(n).map((t) => t.text).join("");

/** The text of every heading in a rich text document, as typed. */
export function headingTexts(doc: unknown): string[] {
  const walk = (n: Node): string[] => (n.type === "heading" ? [headingText(n)] : (n.content ?? []).flatMap(walk));
  return doc && typeof doc === "object" ? walk(doc as Node) : [];
}

/** The pieces of a field's value that capitalisation works on, as typed: the whole text, or each heading. A person's opt-out is remembered per piece. */
export const unitsOf = (type: string, value: unknown): string[] => (type === "richtext" ? headingTexts(value) : typeof value === "string" ? [value] : []);

/** A rich text document with every heading capitalised, except headings whose text (as typed) is in `keep`. The rest of the document is returned as it was. */
export function capitaliseHeadings<T>(doc: T, mode: Casing, keep: string[] = []): T {
  const heading = (n: Node): Node => {
    const before = headingText(n), after = capitalise(before, mode);
    if (keep.includes(before) || after === before || after.length !== before.length) return n;
    let i = 0;
    const apply = (x: Node): Node => x.type === "text" && typeof x.text === "string"
      ? { ...x, text: after.slice(i, (i += x.text.length)) }
      : x.content ? { ...x, content: x.content.map(apply) } : x;
    return apply(n);
  };
  const walk = (n: Node): Node => n.type === "heading" ? heading(n) : n.content ? { ...n, content: n.content.map(walk) } : n;
  return walk(doc as Node) as T;
}
