// Markdown -> Tiptap JSON (runs in the browser; uses `marked` only for tokenising).
// Rule: anything the editor can't represent (tables, task lists, HTML, link definitions, linked images) becomes a raw
// node holding the original source, so nothing is dropped or rewritten.
import { marked, type Token, type Tokens } from "marked";
import type { Mark, Node } from "./markdown.ts";
import { IMAGE_ALIGN, IMAGE_SIZE, blockNodeType, type BlockDef, type PropDef } from "./blocks.ts";

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0", copy: "©", reg: "®", trade: "™",
  hellip: "…", mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", bull: "•", middot: "·", euro: "€", pound: "£",
  yen: "¥", cent: "¢", deg: "°", plusmn: "±", times: "×", divide: "÷", laquo: "«", raquo: "»", sect: "§", para: "¶" };
// shortcut: common named entities only; an unknown one stays literal text, which renders the same as CommonMark would.
export const decodeEntities = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
  if (e[0] === "#") { const cp = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : m; }
  return ENTITIES[e.toLowerCase()] ?? m;
});

const raw = (src: string): Node[] => (src.trim() ? [{ type: "rawBlock", attrs: { source: src.replace(/\n+$/, "") } }] : []);
export const LIBRARY_PREFIX = "cosy:entry/";
const rawInline = (source: string): Node => ({ type: "rawInline", attrs: { source } });
// Entities we can't decode stay as written (a raw node): escaping them as text would change what they mean.
function text(s: string, marks: Mark[]): Node[] {
  s = s.replace(/\s*\n\s*/g, " "); // a soft line break reads as a space
  const out: Node[] = [];
  const plain = (t: string) => { t = decodeEntities(t); if (t) out.push({ type: "text", text: t, ...(marks.length ? { marks } : {}) }); };
  let last = 0;
  for (const m of s.matchAll(/&[A-Za-z][A-Za-z0-9]*;/g)) {
    if (decodeEntities(m[0]) !== m[0]) continue; // known: decoded with the rest
    plain(s.slice(last, m.index));
    out.push(rawInline(m[0]));
    last = m.index + m[0].length;
  }
  plain(s.slice(last));
  return out;
}

/** Adjacent text with the same marks becomes one run. */
function merge(nodes: Node[]) {
  const out: Node[] = [];
  for (const n of nodes) {
    const last = out[out.length - 1];
    if (n.type === "text" && last?.type === "text" && JSON.stringify(last.marks ?? []) === JSON.stringify(n.marks ?? [])) out[out.length - 1] = { ...last, text: (last.text ?? "") + (n.text ?? "") };
    else out.push(n);
  }
  return out;
}

function inl(tokens: Token[] = [], marks: Mark[] = []): Node[] {
  return merge(tokens.flatMap((t): Node[] => {
    switch (t.type) {
      case "text": { const x = t as Tokens.Text; return x.tokens?.length ? inl(x.tokens, marks) : text(x.text, marks); }
      case "escape": return text((t as Tokens.Escape).text, marks);
      case "strong": return inl((t as Tokens.Strong).tokens, [...marks, { type: "bold" }]);
      case "em": return inl((t as Tokens.Em).tokens, [...marks, { type: "italic" }]);
      case "del": return inl((t as Tokens.Del).tokens, [...marks, { type: "strike" }]);
      case "codespan": return [{ type: "text", text: decodeEntities((t as Tokens.Codespan).text), marks: [...marks, { type: "code" }] }];
      case "br": return [{ type: "hardBreak" }];
      case "image": { const x = t as Tokens.Image; return [{ type: "image", attrs: { src: x.href, alt: decodeEntities(x.text), title: x.title ?? null } }]; }
      case "link": {
        const x = t as Tokens.Link;
        // A linked image can't hold a link mark in the editor, so the whole thing is kept as written.
        if (x.tokens?.length === 1 && x.tokens[0].type === "image") return [rawInline(x.raw)];
        return inl(x.tokens, [...marks, { type: "link", attrs: { href: x.href, title: x.title ?? null } }]);
      }
      default: return t.raw ? [rawInline(t.raw)] : []; // inline HTML and anything unknown
    }
  }));
}

function listItem(tokens: Token[]): Node {
  const content = blocks(tokens);
  // The editor's list items must start with a paragraph.
  if (content[0]?.type !== "paragraph") content.unshift({ type: "paragraph" });
  return { type: "listItem", content };
}

let blockDefs: Map<string, BlockDef> | undefined;
let mdx = false;
let imageTag: string | undefined;

// ---- custom blocks: <Name prop="x" count={3} /> and <Name>…</Name>. Anything that doesn't parse cleanly stays a raw block. ----
function closeBrace(s: string, i: number) { // index of the } matching the { at i, skipping strings
  for (let depth = 0, q = ""; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === "\\") i++; else if (c === q) q = ""; }
    else if (c === '"' || c === "'" || c === "`") q = c;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  return -1;
}
// End of a component that starts at `start`: just past its self-closing "/>" or its closing tag; -1 if it never ends.
function componentEnd(src: string, start: number, name: string) {
  let i = start + name.length + 1;
  for (let q = ""; i < src.length; i++) { // the open tag ends at the first ">" outside strings and {braces}
    const c = src[i];
    if (q) { if (c === q) q = ""; }
    else if (c === '"' || c === "'") q = c;
    else if (c === "{") { i = closeBrace(src, i); if (i < 0) return -1; }
    else if (c === ">") break;
  }
  if (i >= src.length) return -1;
  if (src[i - 1] === "/") return i + 1;
  const close = src.indexOf(`</${name}>`, i);
  return close < 0 ? -1 : close + name.length + 3;
}

// marked ends an HTML block at the first blank line, which would cut a <Callout> with two paragraphs in half. So in MDX the source is first
// split at the known components; each component becomes one token, and only the Markdown between them goes to marked.
function lexMdx(src: string): Token[] {
  if (!mdx || !(blockDefs?.size || imageTag)) return marked.lexer(src);
  const out: Token[] = [], fences = [...src.matchAll(/^(```|~~~)[\s\S]*?^\1/gm)].map((m) => [m.index!, m.index! + m[0].length]);
  let last = 0;
  for (const m of src.matchAll(/^<([A-Z][A-Za-z0-9]*)\b/gm)) {
    const at = m.index!;
    if (at < last || !(blockDefs?.has(m[1]) || m[1] === imageTag) || fences.some(([a, b]) => at >= a && at < b)) continue;
    const end = componentEnd(src, at, m[1]);
    if (end < 0) continue;
    if (at > last) out.push(...marked.lexer(src.slice(last, at)));
    out.push({ type: "html", raw: src.slice(at, end), text: src.slice(at, end), block: true } as Token);
    last = end;
  }
  if (last < src.length) out.push(...marked.lexer(src.slice(last)));
  return out;
}

function coerce(p: PropDef, v: unknown): unknown {
  switch (p.type) {
    case "text": return typeof v === "string" ? v : undefined;
    case "number": return typeof v === "number" ? v : undefined;
    case "boolean": return typeof v === "boolean" ? v : undefined;
    case "select": return typeof v === "string" && p.options.includes(v) ? v : undefined;
    case "images": { // pictures from the library: [{ src, alt }]; "cosy:entry/<id>" links to a library entry, real paths are matched up by whoever imports
      if (!Array.isArray(v) || !v.every((x) => x && typeof x === "object" && typeof x.src === "string")) return undefined;
      return v.map((x) => (x.src.startsWith(LIBRARY_PREFIX) ? { entry: x.src.slice(LIBRARY_PREFIX.length), alt: String(x.alt ?? "") } : { src: x.src, alt: String(x.alt ?? "") }));
    }
  }
}
// <Image src="cosy:entry/<id>" alt="…" align="left" size="small" /> -> a library image with those settings. Any other shape stays raw.
function parseImage(s: string): Node | undefined {
  const m = s.match(/^<[A-Z]\w*((?:\s+\w+=(?:"[^"]*"|\{"(?:[^"\\]|\\.)*"\}))*)\s*\/>$/);
  if (!m) return undefined;
  const a: Record<string, string> = {};
  for (const [, k, q, j] of m[1].matchAll(/(\w+)=(?:"([^"]*)"|\{("(?:[^"\\]|\\.)*")\})/g)) a[k] = q ?? JSON.parse(j);
  const { src, alt = "", align = "", size = "" } = a;
  if (!src?.startsWith(LIBRARY_PREFIX) || Object.keys(a).some((k) => !["src", "alt", "align", "size"].includes(k)) || (align && !IMAGE_ALIGN.includes(align)) || (size && !IMAGE_SIZE.includes(size))) return undefined;
  return { type: "libraryImage", attrs: { entry: src.slice(LIBRARY_PREFIX.length), alt: decodeEntities(alt), ...(align ? { align } : {}), ...(size ? { size } : {}) } };
}
function parseComponent(raw: string): Node | undefined {
  const s = raw.trim(), name = s.match(/^<([A-Z][A-Za-z0-9]*)/)?.[1];
  if (name && name === imageTag) return parseImage(s);
  const def = name ? blockDefs?.get(name) : undefined;
  if (!name || !def) return undefined;
  let i = name.length + 1, selfClosed = false;
  const props: Record<string, unknown> = {};
  for (;;) {
    while (/\s/.test(s[i] ?? "")) i++;
    if (s.startsWith("/>", i)) { i += 2; selfClosed = true; break; }
    if (s[i] === ">") { i++; break; }
    const attr = s.slice(i).match(/^[a-zA-Z][\w-]*/)?.[0], p = attr && def.props.find((x) => x.key === attr);
    if (!attr || !p) return undefined; // an unknown property: don't guess
    i += attr.length;
    let v: unknown = true;
    if (s[i] === "=") {
      i++;
      if (s[i] === '"' || s[i] === "'") { const j = s.indexOf(s[i], i + 1); if (j < 0) return undefined; v = s.slice(i + 1, j); i = j + 1; }
      else if (s[i] === "{") { const j = closeBrace(s, i); if (j < 0) return undefined; try { v = JSON.parse(s.slice(i + 1, j)); } catch { return undefined; } i = j + 1; }
      else return undefined;
    }
    const c = coerce(p, v);
    if (c === undefined) return undefined;
    props[attr] = c;
  }
  const attrs = { name, props };
  if (selfClosed) return def.content === "none" && !s.slice(i).trim() ? { type: "blockLeaf", attrs } : undefined;
  const close = `</${name}>`;
  if (def.content === "none" || !s.endsWith(close)) return undefined;
  const inner = s.slice(i, s.length - close.length).trim(), toks = lexMdx(inner).filter((t) => t.type !== "space");
  if (def.content === "inline") {
    if (toks.length > 1 || (toks[0] && toks[0].type !== "paragraph")) return undefined; // more than one run of text: keep it as written
    return { type: blockNodeType("inline"), attrs, content: toks[0] ? inl((toks[0] as Tokens.Paragraph).tokens ?? []) : [] };
  }
  const content = blocks(toks);
  return { type: blockNodeType("blocks"), attrs, content: content.length ? content : [{ type: "paragraph" }] };
}
// In MDX a paragraph that opens with a component (<Gallery …/>, <Caption>…</Caption>) or an expression ({…}) is code, not prose: keep it verbatim.
const isJsx = (raw: string) => /^(<[A-Z][\w.]*[\s/>]|\{)/.test(raw.trimStart());

function blocks(tokens: Token[] = []): Node[] {
  return tokens.flatMap((t): Node[] => {
    switch (t.type) {
      case "space": return [];
      case "paragraph": {
        if (mdx) { const b = parseComponent(t.raw); if (b) return [b]; if (isJsx(t.raw)) return raw(t.raw); }
        const kids = (t as Tokens.Paragraph).tokens ?? [];
        // The editor's Markdown view writes a library image as ![alt](cosy:entry/<id>); on its own line it goes back to being one.
        if (kids.length === 1 && kids[0].type === "image" && (kids[0] as Tokens.Image).href.startsWith(LIBRARY_PREFIX)) {
          const img = kids[0] as Tokens.Image;
          return [{ type: "libraryImage", attrs: { entry: img.href.slice(LIBRARY_PREFIX.length), alt: decodeEntities(img.text) } }];
        }
        return [{ type: "paragraph", content: inl(kids) }];
      }
      case "text": { const x = t as Tokens.Text; return [{ type: "paragraph", content: x.tokens ? inl(x.tokens) : text(x.text, []) }]; } // tight list item
      case "heading": { const x = t as Tokens.Heading; return [{ type: "heading", attrs: { level: Math.min(6, x.depth) }, content: inl(x.tokens) }]; }
      case "hr": return [{ type: "horizontalRule" }];
      case "code": { const x = t as Tokens.Code; return [{ type: "codeBlock", attrs: { language: x.lang || null }, ...(x.text ? { content: [{ type: "text", text: x.text }] } : {}) }]; }
      case "blockquote": return [{ type: "blockquote", content: blocks((t as Tokens.Blockquote).tokens) }];
      case "list": {
        const x = t as Tokens.List;
        if (x.items.some((i) => i.task)) return raw(x.raw); // checkboxes can't be represented
        return [{ type: x.ordered ? "orderedList" : "bulletList", ...(x.ordered ? { attrs: { start: typeof x.start === "number" ? x.start : 1 } } : {}),
          content: x.items.map((i) => listItem(i.tokens)) }];
      }
      default: { const b = mdx && t.type === "html" ? parseComponent(t.raw) : undefined; return b ? [b] : raw(t.raw); } // html, table, link definitions, ...
    }
  });
}

export function fromMarkdown(src: string, opts: { mdx?: boolean; blocks?: BlockDef[]; imageComponent?: string } = {}): Node[] {
  mdx = !!opts.mdx; imageTag = opts.imageComponent; blockDefs = opts.blocks && new Map(opts.blocks.map((b) => [b.key, b]));
  try { return blocks(lexMdx(src)); } finally { mdx = false; blockDefs = undefined; imageTag = undefined; }
}
