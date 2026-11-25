// Tiptap JSON -> Markdown. Pure and dependency-free so it runs on Workers, Node and in the browser.
import { isBlockNode, type BlockDef } from "./blocks.ts";
// Rule: raw nodes (rawBlock / rawInline) hold Markdown or HTML the editor can't represent; they are written back verbatim.
export type Mark = { type: string; attrs?: Record<string, any> };
export type Node = { type: string; attrs?: Record<string, any>; content?: Node[]; text?: string; marks?: Mark[] };

// Library images are stored by entry id; the publisher resolves each to a file path and alt text.
// `path` (optional) is the same file's location from the project root, for blocks that publish rooted paths.
export type ImageResolver = (entryId: string, attrs: Record<string, any>) => { src: string; alt: string; path?: string } | undefined;
let imageTag: string | undefined; // MDX component that images with an alignment/size are written as
let images: ImageResolver | undefined; // set for the duration of one toMarkdown call (it is synchronous)

// A block's image list is an array of { entry, src, alt }; anything else in props is plain data.
const imageItems = (n: Node): { entry: string }[] => Object.values((n.attrs?.props ?? {}) as Record<string, unknown>)
  .flatMap((v) => (Array.isArray(v) ? v.filter((x): x is { entry: string } => !!x && typeof x === "object" && typeof (x as any).entry === "string") : []));

/** Ids of the library images used in a document, in its body and inside blocks. */
export function docImageIds(n: Node | null | undefined): string[] {
  if (!n) return [];
  return [...(n.type === "libraryImage" && n.attrs?.entry ? [String(n.attrs.entry)] : []), ...(isBlockNode(n.type) ? imageItems(n).map((i) => String(i.entry)) : []), ...(n.content ?? []).flatMap(docImageIds)];
}

/** Gives every library image (in the text and inside blocks) the `src` the editor draws it with, when it has none. Text that came in as
 * Markdown (from an agent, or an undo of one) only carries the entry id; the picture is looked up by `srcOf`. Changes the document in place. */
export function fillPictures(n: Node | null | undefined, srcOf: (entry: string) => string | undefined): void {
  if (!n) return;
  if (n.type === "libraryImage" && n.attrs?.entry && !n.attrs.src) n.attrs.src = srcOf(String(n.attrs.entry));
  else if (isBlockNode(n.type)) for (const i of imageItems(n)) if (!(i as { src?: string }).src) (i as { src?: string }).src = srcOf(i.entry);
  n.content?.forEach((c) => fillPictures(c, srcOf));
}

const LINK_PREFIX = "cosy:entry/"; // a link to another entry: [text](cosy:entry/<id>); resolved to the page address when published
const linkId = (m: Mark) => (m.type === "link" && typeof m.attrs?.href === "string" && m.attrs.href.startsWith(LINK_PREFIX) ? m.attrs.href.slice(LINK_PREFIX.length) : undefined);

/** Ids of the entries a document links to. */
export function docLinkIds(n: Node | null | undefined): string[] {
  if (!n) return [];
  return [...(n.marks ?? []).flatMap((m) => linkId(m) ?? []), ...(n.content ?? []).flatMap(docLinkIds)];
}

/** The document with each link to an entry turned into a link to its page address; a link whose target has none loses the link and keeps its text. */
export function resolveLinks(n: Node, href: (entry: string) => string | undefined): Node {
  const marks = n.marks?.flatMap((m): Mark[] => { const id = linkId(m), h = id && href(id); return !id ? [m] : h ? [{ ...m, attrs: { ...m.attrs, href: h } }] : []; });
  return { ...n, ...(marks ? { marks } : {}), ...(n.content ? { content: n.content.map((c) => resolveLinks(c, href)) } : {}) };
}

/** Names of the blocks used in a document. */
export function docBlockNames(n: Node | null | undefined): string[] {
  if (!n) return [];
  return [...(isBlockNode(n.type) ? [String(n.attrs?.name)] : []), ...(n.content ?? []).flatMap(docBlockNames)];
}

const pick = (a: Record<string, unknown> = {}) => Object.fromEntries(["align", "size"].filter((k) => a[k]).map((k) => [k, a[k]]));

/** The same document with each library image carrying its published path and alt text, for JSON output. */
export function resolveDoc(n: Node, resolve: ImageResolver, defs?: Map<string, BlockDef>): Node {
  if (n.type === "libraryImage") { const r = resolve(String(n.attrs?.entry), n.attrs ?? {}); return r ? { type: "libraryImage", attrs: { src: r.src, alt: r.alt, ...pick(n.attrs) } } : n; }
  const content = n.content ? n.content.map((c) => resolveDoc(c, resolve, defs)) : undefined;
  if (isBlockNode(n.type)) {
    const props = Object.fromEntries(Object.entries((n.attrs?.props ?? {}) as Record<string, unknown>).map(([k, v]) => [k, Array.isArray(v) ? v.map((it) => imageOf(it, resolve, rooted(defs, n, k))) : v]));
    return { ...n, attrs: { ...n.attrs, props }, ...(content ? { content } : {}) };
  }
  return content ? { ...n, content } : n;
}
const rooted = (defs: Map<string, BlockDef> | undefined, n: Node, prop: string) => !!defs?.get(String(n.attrs?.name))?.props.some((p) => p.key === prop && p.type === "images" && p.rooted);
function imageOf(it: any, resolve: ImageResolver, root: boolean) {
  const r = it && typeof it.entry === "string" ? resolve(it.entry, it) : undefined;
  return r ? { src: root && r.path ? "/" + r.path : r.src, alt: r.alt } : it;
}

const alnum = (c: string) => /[A-Za-z0-9]/.test(c);

function codeSpan(s: string) {
  s = s.replace(/\n/g, " ");
  const longest = Math.max(0, ...[...s.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  const pad = /^`|`$/.test(s) || (/^ .* $/.test(s) && /\S/.test(s)) ? " " : ""; // CommonMark strips one space each side
  return fence + pad + s + pad + fence;
}

/** Backslash-escapes text so it reads back as the same text. Only what can be misread is escaped. */
let blockDefs: Map<string, BlockDef> | undefined;
let mdx = false; // MDX reads { and any < as code, so text must escape them
function escapeText(t: string, lineStart: boolean) {
  const tildes = (t.match(/~/g) ?? []).length > 1;
  let out = "";
  for (let i = 0; i < t.length; i++) {
    const c = t[i], p = t[i - 1] ?? "", n = t[i + 1] ?? "";
    if (c === "\\" || c === "*" || c === "`" || c === "[" || c === "]") out += "\\" + c;
    else if (c === "_") out += alnum(p) && alnum(n) ? c : "\\_"; // intraword underscores aren't emphasis
    else if (c === "~") out += tildes ? "\\~" : c;
    else if (c === "<" && (mdx || /[A-Za-z/!?]/.test(n))) out += "\\<"; // could open HTML or an autolink (in MDX, a component)
    else if (c === "{" && mdx) out += "\\{";
    else if (c === "&" && /^[A-Za-z0-9#]+;/.test(t.slice(i + 1))) out += "\\&"; // would read as an entity
    else out += c;
  }
  if (lineStart) { // block syntax is only live at the start of a line
    out = out.replace(/^#{1,6}(?=\s|$)/, (m) => "\\" + m).replace(/^>/, "\\>").replace(/^\+(?=\s|$)/, "\\+")
      .replace(/^-(?=[-\s]|$)/, "\\-").replace(/^=+(?=\s*$)/, (m) => "\\" + m).replace(/^(\d{1,9})([.)])(?=\s|$)/, "$1\\$2");
  }
  return out;
}

const dest = (href: string, title?: string | null) => {
  const u = !href || /[\s()<>]/.test(href) ? `<${href.replace(/[<>\n]/g, encodeURIComponent)}>` : href;
  return title ? `${u} "${title.replace(/(["\\])/g, "\\$1")}"` : u;
};

const sameMark = (a: Mark, b: Mark) => a.type === b.type && JSON.stringify(a.attrs ?? null) === JSON.stringify(b.attrs ?? null);
// Outermost first. Code is handled separately (a code span can't contain other markup).
const ORDER = ["link", "bold", "italic", "strike", "underline"];
const wanted = (marks: Mark[] = []) => ORDER.flatMap((t) => marks.filter((m) => m.type === t).slice(0, 1));
const opener = (m: Mark) => ({ link: "[", bold: "**", italic: "*", strike: "~~", underline: "<u>" })[m.type as "bold"];
const closer = (m: Mark) => (m.type === "link" ? `](${dest(m.attrs?.href ?? "", m.attrs?.title)})` : m.type === "underline" ? "</u>" : opener(m));

// Adjacent text with the same marks is one run (the editor guarantees this; imported JSON may not).
function mergeText(nodes: Node[]) {
  const out: Node[] = [];
  for (const n of nodes) {
    const last = out[out.length - 1];
    if (n.type === "text" && last?.type === "text" && JSON.stringify(last.marks ?? []) === JSON.stringify(n.marks ?? [])) out[out.length - 1] = { ...last, text: (last.text ?? "") + (n.text ?? "") };
    else out.push(n);
  }
  return out;
}

/**
 * Marks open and close only where they change, so "**bold *nested* text**" stays one bold run.
 * Delimiters always touch non-space text (whitespace is held back and written outside them).
 */
function inline(nodes: Node[] = [], startsLine = true): string {
  let out = "", pending = "", lineStart = startsLine;
  const open: Mark[] = [];
  const closeTo = (n: number) => { while (open.length > n) out += closer(open.pop()!); };
  const space = () => { if (!lineStart) out += pending; pending = ""; };

  for (const n of mergeText(nodes)) {
    if (n.type === "text") {
      const [, lead, core, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(n.text ?? "")!;
      if (!core) { if (!lineStart) pending = " "; continue; }
      const want = wanted(n.marks);
      let k = 0;
      while (k < open.length && k < want.length && sameMark(open[k], want[k])) k++;
      closeTo(k);
      if (lead && !pending) pending = " ";
      space();
      for (const m of want.slice(k)) { out += opener(m); open.push(m); }
      const flat = core.replace(/\s*\n\s*/g, " ");
      out += n.marks?.some((m) => m.type === "code") ? codeSpan(flat) : escapeText(flat, lineStart && !open.length);
      lineStart = false;
      pending = trail ? " " : "";
      continue;
    }
    closeTo(0);
    space();
    if (n.type === "hardBreak") { out += "\\\n"; lineStart = true; pending = ""; }
    else if (n.type === "image") { out += `![${(n.attrs?.alt ?? "").replace(/[\\[\]]/g, "\\$&")}](${dest(n.attrs?.src ?? "", n.attrs?.title)})`; lineStart = false; }
    else if (n.type === "rawInline") { out += n.attrs?.source ?? ""; lineStart = false; }
    else { out += inline(n.content); lineStart = false; } // unknown inline node: keep its text rather than lose it
  }
  closeTo(0);
  return out.replace(/(\\\n)+$/, "").replace(/[ \t]+$/, "");
}

const isList = (n?: Node) => n?.type === "bulletList" || n?.type === "orderedList";
const indent = (s: string, pad: string) => s.split("\n").map((l) => (l ? pad + l : l)).join("\n");

function list(n: Node, alt: boolean) {
  const ordered = n.type === "orderedList", start = Number(n.attrs?.start ?? 1);
  const items = (n.content ?? []).map((li) => li.content ?? []);
  // Loose = an item holds more than one block besides nested lists; then every item gets a blank line between.
  const loose = items.some((kids) => kids.filter((k) => !isList(k)).length > 1);
  const out = items.map((kids, i) => {
    const marker = ordered ? `${start + i}${alt ? ")" : "."} ` : alt ? "* " : "- ";
    let body = "";
    kids.forEach((k, j) => {
      const s = blockOne(k, kids[j - 1], false);
      if (!s) return;
      body += (body ? (isList(k) && !loose ? "\n" : "\n\n") : "") + s;
    });
    return body ? marker + indent(body, " ".repeat(marker.length)).slice(marker.length) : marker.trimEnd();
  });
  return out.join(loose ? "\n\n" : "\n");
}

// ---- custom blocks: <Name prop="x" count={3} images={[{"src": "...", "alt": "..."}]} /> ----
const jsxString = (v: string) => (/^[^"\\&\n{}<>]*$/.test(v) ? `"${v}"` : `{${JSON.stringify(v)}}`); // plain strings as "…"; anything JSX would reinterpret as {"…"}
const objectLiteral = (o: Record<string, unknown>) => "{" + Object.entries(o).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(", ") + "}";

function component(n: Node): string {
  const name = String(n.attrs?.name ?? ""), def = blockDefs?.get(name), props = (n.attrs?.props ?? {}) as Record<string, unknown>;
  const attrs: string[] = [];
  for (const k of def ? def.props.map((p) => p.key) : Object.keys(props)) {
    const v = props[k], p = def?.props.find((x) => x.key === k);
    if (v == null || v === "" || (Array.isArray(v) && !v.length)) continue;
    if (Array.isArray(v)) {
      const list = v.map((it: any) => {
        const r = it?.entry ? images?.(String(it.entry), it) : undefined;
        return { src: r ? (p?.type === "images" && p.rooted && r.path ? "/" + r.path : r.src) : String(it?.src ?? ""), alt: r?.alt ?? String(it?.alt ?? "") };
      });
      attrs.push(`${k}={[${list.map(objectLiteral).join(", ")}]}`);
    } else attrs.push(typeof v === "string" ? `${k}=${jsxString(v)}` : `${k}={${JSON.stringify(v)}}`);
  }
  const open = `<${name}${attrs.map((a) => " " + a).join("")}`;
  if (n.type === "blockLeaf") return open + " />";
  const inner = (n.type === "blockInline" ? inline(n.content) : blocks(n.content)).trim();
  return inner ? `${open}>\n${inner}\n</${name}>` : `${open}></${name}>`;
}

function blockOne(n: Node, prev: Node | undefined, alt: boolean): string {
  switch (n.type) {
    case "blockLeaf": case "blockInline": case "blockWrap": return component(n);
    case "paragraph": return inline(n.content);
    case "heading": return `${"#".repeat(Math.min(6, Math.max(1, Number(n.attrs?.level ?? 1))))} ${inline(n.content, false)}`; // after "## " nothing is block syntax, so "1." needs no escape
    case "bulletList": case "orderedList": return list(n, alt);
    case "blockquote": return (blocks(n.content) || "").split("\n").map((l) => (l ? "> " + l : ">")).join("\n");
    case "codeBlock": {
      const code = (n.content ?? []).map((c) => c.text ?? "").join("");
      const fence = "`".repeat(Math.max(3, Math.max(0, ...[...code.matchAll(/`+/g)].map((m) => m[0].length)) + 1));
      return `${fence}${n.attrs?.language ?? ""}\n${code}\n${fence}`;
    }
    case "horizontalRule": return "---";
    case "rawBlock": return String(n.attrs?.source ?? "");
    case "libraryImage": {
      const r = images?.(String(n.attrs?.entry), n.attrs ?? {}) ?? { src: String(n.attrs?.src ?? ""), alt: String(n.attrs?.alt ?? "") };
      const o = Object.entries(pick(n.attrs)).map(([k, v]) => ` ${k}=${jsxString(String(v))}`).join("");
      if (mdx && imageTag && o) return `<${imageTag} src=${jsxString(r.src)} alt=${jsxString(r.alt)}${o} />`;
      return `![${r.alt.replace(/[\\[\]]/g, "\\$&")}](${dest(r.src)})`;
    }
    default: return inline(n.content); // unknown block: keep its text rather than lose it
  }
}

function blocks(nodes: Node[] = []): string {
  const parts: string[] = [];
  let altNext = false;
  nodes.forEach((n, i) => {
    // Neighbouring lists of the same kind would merge, so the second one uses the other marker.
    const alt = isList(n) && nodes[i - 1]?.type === n.type ? altNext : false;
    altNext = isList(n) ? !alt : false;
    const s = blockOne(n, nodes[i - 1], alt);
    if (s.trim()) parts.push(s);
  });
  return parts.join("\n\n");
}

export const toMarkdown = (doc: Node | null | undefined, resolve?: ImageResolver, opts: { mdx?: boolean; blocks?: Map<string, BlockDef>; imageComponent?: string } = {}) => {
  images = resolve; mdx = !!opts.mdx; blockDefs = opts.blocks; imageTag = opts.imageComponent;
  try { const md = blocks(doc?.content); return md ? md + "\n" : ""; }
  finally { images = undefined; mdx = false; blockDefs = undefined; imageTag = undefined; }
};
