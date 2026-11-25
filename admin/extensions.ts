import { Node } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import type { BlockDef } from "../src/blocks";
import { OPEN_SVG } from "./openIcon";
import { IMAGE_ALIGN, IMAGE_SIZE } from "../src/blocks";

// Markdown or HTML the editor can't represent is kept as written in these nodes (see src/markdown-import.ts).
export const RawBlock = Node.create({
  name: "rawBlock", group: "block", atom: true, selectable: true, priority: 200,
  addAttributes: () => ({ source: { default: "" } }),
  parseHTML: () => [{ tag: "pre[data-raw]", getAttrs: (el) => ({ source: (el as HTMLElement).textContent ?? "" }) }],
  renderHTML: ({ node }) => ["pre", { "data-raw": "", class: "raw", title: "Kept exactly as written" }, node.attrs.source],
});

export const RawInline = Node.create({
  name: "rawInline", group: "inline", inline: true, atom: true, selectable: true,
  addAttributes: () => ({ source: { default: "" } }),
  parseHTML: () => [{ tag: "code[data-raw]", getAttrs: (el) => ({ source: (el as HTMLElement).textContent ?? "" }) }],
  renderHTML: ({ node }) => ["code", { "data-raw": "", class: "raw", title: "Kept exactly as written" }, node.attrs.source],
});

// (appendChild, not append: the project also loads the Workers types, whose Element.append means something else)
const add = (parent: { appendChild(n: any): unknown }, ...kids: (HTMLElement | HTMLSelectElement | HTMLOptionElement)[]) => kids.forEach((k) => parent.appendChild(k));
const h = (tag: string, cls = "", text = "") => { const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; };

// An image from the image library. Only the entry id is the truth; src/alt are a copy for display, and the published
// path and alt text are looked up again when publishing, so renaming or re-describing the image updates every page.
export const libraryImage = (hooks: { replace(pos: number): void; remove(pos: number): void; href(entry: string): string | undefined; options(): boolean; set(pos: number, attrs: Record<string, string>): void }) => Node.create({
  name: "libraryImage", group: "block", atom: true, draggable: true, selectable: true, priority: 200,
  addAttributes: () => ({ entry: { default: "" }, src: { default: "" }, alt: { default: "" }, align: { default: "" }, size: { default: "" } }),
  parseHTML: () => [{ tag: "img[data-entry]", getAttrs: (el) => ({ entry: (el as HTMLElement).getAttribute("data-entry"), src: (el as HTMLElement).getAttribute("src"), alt: (el as HTMLElement).getAttribute("alt") }) }],
  renderHTML: ({ node }) => ["img", { "data-entry": node.attrs.entry, src: node.attrs.src, alt: node.attrs.alt, class: "libimg" }],
  // A header like the blocks have: what the image is, plus Replace and remove.
  addNodeView: () => ({ node: initial, getPos }) => {
    let node = initial;
    const dom = h("div", "block libblock"), head = h("div", "block-head"), title = h("strong"), img = h("img", "libimg") as HTMLImageElement;
    const replace = h("button", "ghost", "Replace") as HTMLButtonElement, remove = h("button", "ghost remove", "×") as HTMLButtonElement;
    const open = h("a", "open") as HTMLAnchorElement;
    open.target = "_blank"; open.rel = "noopener"; open.title = "Open in the library"; open.setAttribute("aria-label", "Open in the library"); open.innerHTML = OPEN_SVG;
    replace.type = remove.type = "button"; head.contentEditable = "false"; head.draggable = true; // Firefox only starts a drag from an element that is draggable before the mouse goes down
    remove.setAttribute("aria-label", "Remove image"); remove.title = "Remove image";
    // Alignment and size only when the field publishes images as a component (hooks.options); the site decides what they look like.
    const pick = (key: "align" | "size", label: string, list: string[]) => {
      const sel = document.createElement("select"); sel.className = "imgopt";
      sel.setAttribute("aria-label", label);
      add(sel, ...[["", label], ...list.map((o) => [o, o])].map(([v, t]) => Object.assign(document.createElement("option"), { value: v, textContent: t })));
      sel.addEventListener("change", () => { const pos = getPos(); if (typeof pos === "number") hooks.set(pos, { [key]: sel.value }); });
      return sel;
    };
    const opts = hooks.options() ? [pick("align", "Align", IMAGE_ALIGN), pick("size", "Size", IMAGE_SIZE)] : [];
    add(head, title, open, h("span", "spacer"), ...opts, replace, remove);
    add(dom, head, img);
    const paint = () => { dom.className = `block libblock${node.attrs.align ? " align-" + node.attrs.align : ""}${node.attrs.size ? " size-" + node.attrs.size : ""}`; opts.forEach((o) => (o.value = node.attrs[o.getAttribute("aria-label") === "Align" ? "align" : "size"] ?? "")); title.textContent = String(node.attrs.alt || "Image"); img.src = node.attrs.src; img.alt = node.attrs.alt; const u = hooks.href(node.attrs.entry); open.hidden = !u; if (u) open.href = u; };
    paint();
    const on = (b: HTMLElement, f: (pos: number) => void) => b.addEventListener("click", () => { const pos = getPos(); if (typeof pos === "number") f(pos); });
    on(replace, hooks.replace); on(remove, hooks.remove);
    return {
      dom,
      update: (n) => { if (n.type !== node.type) return false; node = n; paint(); return true; },
      stopEvent: (e) => !!(e.target as Element).closest?.("button,select,a") && head.contains(e.target as Element),
      ignoreMutation: () => true,
    };
  },
});

// Markdown links can carry a title; the stock Link mark has no attribute for it.
const RichLink = Link.extend({ addAttributes() { return { ...this.parent?.(), title: { default: null } }; } });

export const richExtensions = (hooks: Parameters<typeof libraryImage>[0]) => [
  StarterKit.configure({ link: false }),
  RichLink.configure({ openOnClick: false, protocols: [{ scheme: "cosy", optionalSlashes: true }] }), // cosy:entry/<id> links to another entry
  Image.configure({ inline: true }),
  RawBlock, RawInline, libraryImage(hooks),
];

// ---- Custom content blocks (see src/blocks.ts) ------------------------------------------------------------------------
// Three node types cover every block: one that holds only settings, one holding a run of text, one holding other blocks.
// Which block it is lives in attrs.name; its settings in attrs.props. Settings are edited in a dialog (hooks.edit).
export type BlockHooks = { edit(pos: number): void; remove(pos: number): void };

/** One line saying what a block's settings are, e.g. `columns: 2 · 3 images`. */
export function blockSummary(def: BlockDef | undefined, props: Record<string, unknown>) {
  return Object.entries(props ?? {}).flatMap(([k, v]) => {
    if (v == null || v === "" || (Array.isArray(v) && !v.length)) return [];
    const label = (def?.props.find((p) => p.key === k)?.label ?? k).replace(/\s*\(.*$/, ""); // "Image shape (1 = square…)" → "Image shape"
    return [Array.isArray(v) ? `${v.length} ${v.length === 1 ? "image" : "images"}` : `${label}: ${v}`];
  }).join(" · ");
}

export function blockExtensions(defs: BlockDef[], hooks: BlockHooks) {
  const byName = new Map(defs.map((d) => [d.key, d]));
  const make = (type: "blockLeaf" | "blockInline" | "blockWrap") => Node.create({
    name: type, group: "block", priority: 200, draggable: true, selectable: true,
    content: type === "blockInline" ? "inline*" : type === "blockWrap" ? "block+" : undefined,
    atom: type === "blockLeaf", defining: type !== "blockLeaf",
    addAttributes: () => ({ name: { default: "" }, props: { default: {} } }),
    parseHTML: () => [{ tag: `div[data-block="${type}"]`, getAttrs: (el) => ({ name: (el as HTMLElement).dataset.name, props: JSON.parse((el as HTMLElement).dataset.props || "{}") }) }],
    renderHTML: ({ node }) => ["div", { "data-block": type, "data-name": node.attrs.name, "data-props": JSON.stringify(node.attrs.props) }, ...(type === "blockLeaf" ? [] : [0])],
    addNodeView: () => ({ node: initial, getPos }) => {
      let node = initial;
      const dom = h("div", `block ${type}`), head = h("div", "block-head"), title = h("strong"), note = h("span", "muted"), edit = h("button", "ghost", "Edit"), remove = h("button", "ghost remove", "×");
      (edit as HTMLButtonElement).type = "button"; (remove as HTMLButtonElement).type = "button"; head.contentEditable = "false"; head.draggable = true; // Firefox only starts a drag from an element that is draggable before the mouse goes down
      remove.setAttribute("aria-label", "Remove block"); remove.title = "Remove block";
      add(head, title, note, h("span", "spacer"), edit, remove);
      add(dom, head);
      let thumbs: HTMLElement | undefined, contentDOM: HTMLElement | undefined;
      if (type === "blockLeaf") { thumbs = h("div", "block-thumbs"); thumbs.contentEditable = "false"; add(dom, thumbs); }
      else { contentDOM = h("div", "block-body"); add(dom, contentDOM); }
      const paint = () => {
        const def = byName.get(String(node.attrs.name));
        const p = node.attrs.props as Record<string, unknown>; // an align or size setting on any block previews as a float or width, like an image's
        dom.className = `block ${type}${p?.align ? " align-" + p.align : ""}${p?.size ? " size-" + p.size : ""}`;
        title.textContent = def?.label ?? String(node.attrs.name);
        note.textContent = blockSummary(def, node.attrs.props);
        edit.hidden = !def?.props.length;
        if (thumbs) {
          thumbs.replaceChildren(...Object.values(node.attrs.props as Record<string, unknown>).flatMap((v) => (Array.isArray(v) ? v : []))
            .filter((it: any) => it?.src).map((it: any) => Object.assign(h("img"), { src: it.src, alt: it.alt ?? "" })));
          thumbs.hidden = !thumbs.children.length;
        }
      };
      paint();
      edit.addEventListener("click", () => { const pos = getPos(); if (typeof pos === "number") hooks.edit(pos); });
      remove.addEventListener("click", () => { const pos = getPos(); if (typeof pos === "number") hooks.remove(pos); });
      return {
        dom, contentDOM,
        update: (n) => { if (n.type !== node.type) return false; node = n; paint(); return true; },
        stopEvent: (e) => !!(e.target as Element).closest?.("button,select,a") && head.contains(e.target as Element), // only the controls are ours; the rest of the header is a drag handle
        ignoreMutation: (m) => !contentDOM?.contains(m.target) && m.type !== "selection",
      };
    },
  });
  return [make("blockLeaf"), make("blockInline"), make("blockWrap")];
}
