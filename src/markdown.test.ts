import { test } from "node:test";
import assert from "node:assert/strict";
import { marked } from "marked";
import { toMarkdown, fillPictures, docLinkIds, resolveLinks, type Node } from "./markdown.ts";
import { fromMarkdown, decodeEntities, LIBRARY_PREFIX } from "./markdown-import.ts";

const trip = (md: string) => toMarkdown({ type: "doc", content: fromMarkdown(md) });
// Entities are decoded on both sides: "&copy;" and "©" render the same.
const html = (md: string) => decodeEntities((marked.parse(md, { async: false }) as string).replace(/\s+/g, " ").trim());

// Every sample must (1) render to the same HTML after a round trip and (2) be stable: converting again changes nothing.
const corpus: Record<string, string> = {
  headings: "# One\n\n## Two\n\n###### Six\n\nSetext\n======\n\nbody",
  inline: "Plain **bold**, *italic*, ***both***, ~~strike~~, `code`, and [a link](https://example.com \"Title\").",
  "marks with edge spaces": "A **bold phrase** then *an italic one* and **bold *nested italic* text**.",
  "code spans": "Use `` a`b `` and ` pad ` and ``` `` ``` here.",
  "links": "[plain](https://x.com) [parens](<https://x.com/a(b)c>) [space](<a b.png>) <https://auto.com>",
  lists: "- one\n- two\n  - nested a\n  - nested b\n- three\n\n1. first\n2. second\n3. third",
  "ordered start": "3. three\n4. four",
  "loose list": "- a\n\n- b\n\n  continued paragraph\n\n- c",
  "adjacent lists": "- a\n- b\n\n<!-- split -->\n\n- c\n- d",
  quote: "> quoted\n>\n> second para\n>\n> - with\n> - list\n\n> > nested",
  "code block": "```js\nconst a = 1 * 2;\n```\n\n````\n```\ninner fence\n```\n````",
  rule: "above\n\n---\n\nbelow",
  "hard break": "line one\\\nline two\\\nline three",
  "special characters": "1 * 2 * 3, snake_case_word, _lead and trail_, a < b, <3, AT\\&T, ~~, back\\\\slash, \\# not a heading, 2 \\> 1, 1\\. not a list",
  entities: "Copyright &copy; 2026 &mdash; caf&eacute; &#169; &#x1F600;",
  "line start lookalikes": "\\- not a bullet\n\n\\+ plus\n\n\\> not a quote\n\n3\\) not ordered\n\n\\=== not setext",
  image: "![Alt text](../img/a.png \"Title\") inline with text ![x](b.jpg).",
  "linked image (kept raw)": "[![Alt](a.jpg)](https://u.com)",
  "html block": "<div class=\"note\">\n  <p>raw *html*</p>\n</div>\n\nafter",
  "jsx-like component": "<Caption>\nCredit: [Someone](https://x.com)\n</Caption>",
  "inline html": "A line<br>break and <b>bold html</b> and <u>under</u> end.",
  "html comment": "<!-- note to self -->\n\ntext",
  table: "| a | b |\n|---|---|\n| 1 | 2 |\n\nafter",
  "task list": "- [ ] todo\n- [x] done",
  "reference links": "[ref][1] and [other][two]\n\n[1]: https://one.com\n[two]: https://two.com \"Two\"",
};
for (const [name, md] of Object.entries(corpus)) {
  test(`markdown round trip: ${name}`, () => {
    const once = trip(md), twice = trip(once);
    assert.equal(html(once), html(md), `rendered HTML differs\n--- original\n${md}\n--- exported\n${once}`);
    assert.equal(twice, once, "not stable on a second pass");
  });
}

test("unsupported constructs are kept verbatim, never dropped", () => {
  const nodes = fromMarkdown("| a | b |\n|---|---|\n| 1 | 2 |\n\n<Caption>\nx\n</Caption>\n\n- [ ] t\n\n[![A](a.jpg)](https://u.com)");
  const raws = JSON.stringify(nodes);
  for (const s of ["| a | b |", "<Caption>", "- [ ] t", "[![A](a.jpg)](https://u.com)"]) assert.ok(raws.includes(JSON.stringify(s).slice(1, -1)), `lost: ${s}`);
});

test("exporting authored content", () => {
  const doc: Node = { type: "doc", content: [
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Hello" }] },
    { type: "paragraph", content: [{ type: "text", text: "A " }, { type: "text", text: "bold ", marks: [{ type: "bold" }] }, { type: "text", text: "word & more *stars*" }] },
    { type: "paragraph" }, // empty paragraphs are dropped
    { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "item" }] }] }] },
    { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "other list" }] }] }] },
  ] };
  assert.equal(toMarkdown(doc), "## Hello\n\nA **bold** word & more \\*stars\\*\n\n- item\n\n* other list\n");
  assert.equal(toMarkdown({ type: "doc", content: [{ type: "paragraph" }] }), "", "empty doc");
  assert.equal(toMarkdown(null), "");
});

test("whitespace stays outside emphasis, and trailing hard breaks vanish", () => {
  const p = (...content: Node[]): Node => ({ type: "doc", content: [{ type: "paragraph", content }] });
  assert.equal(toMarkdown(p({ type: "text", text: "  lead", marks: [{ type: "italic" }] }, { type: "text", text: " tail " })), "*lead* tail\n");
  assert.equal(toMarkdown(p({ type: "text", text: "end" }, { type: "hardBreak" })), "end\n");
});

test("entities decode, unknown ones stay literal", () => {
  assert.equal(decodeEntities("&copy; &amp; &#65; &#x42; &nope;"), "© & A B &nope;");
});

test("library images survive the editor's Markdown view and are not turned into plain images", () => {
  const doc: Node = { type: "doc", content: [
    { type: "paragraph", content: [{ type: "text", text: "Before" }] },
    { type: "libraryImage", attrs: { entry: "abc-123", src: "/api/blobs/x.webp", alt: "A [panda]" } },
  ] };
  const view = toMarkdown(doc, (id, a) => ({ src: LIBRARY_PREFIX + id, alt: a.alt }));
  assert.equal(view, "Before\n\n![A \\[panda\\]](cosy:entry/abc-123)\n");
  const back = fromMarkdown(view);
  assert.deepEqual(back[1], { type: "libraryImage", attrs: { entry: "abc-123", alt: "A [panda]" } });
  assert.equal(toMarkdown({ type: "doc", content: back }, (id, a) => ({ src: LIBRARY_PREFIX + id, alt: a.alt })), view, "stable");
});

// ---- MDX: components must survive untouched ----
test("MDX components and expressions are kept verbatim; the same text in plain Markdown is prose", () => {
  const src = `Intro\n\n<Gallery columns={2} aspect="3/2" images={[{"src": "/a.jpg", "alt": "x"}]} />\n\n<Caption>\nCredit: [Name](https://x.com)\n</Caption>\n\n{/* note */}\n\nPrice <40cm {ok}.\n`;
  const mdx = toMarkdown({ type: "doc", content: fromMarkdown(src, { mdx: true }) } as never, undefined, { mdx: true });
  assert.ok(mdx.includes('<Gallery columns={2} aspect="3/2" images={[{"src": "/a.jpg", "alt": "x"}]} />'), mdx);
  assert.ok(mdx.includes("<Caption>\nCredit: [Name](https://x.com)\n</Caption>") && mdx.includes("{/* note */}"), mdx);
  assert.ok(mdx.includes("Price \\<40cm \\{ok}."), "prose is escaped so MDX won't read it as code");
  const types = fromMarkdown(src, { mdx: true }).map((n) => n.type);
  assert.deepEqual(types, ["paragraph", "rawBlock", "rawBlock", "rawBlock", "paragraph"]);
  assert.equal(fromMarkdown(src).filter((n) => n.type === "rawBlock").length, 1, "without mdx only the real HTML block (<Caption>) is raw");
});
test("a heading starting with a number isn't escaped", () => {
  assert.equal(toMarkdown({ type: "doc", content: [{ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "1. Classic" }] }] } as never), "## 1. Classic\n");
});

// ---- custom blocks, modelled on the first real site: Caption, Callout, LinkButton, Gallery ----
import { BlockDef } from "./blocks.ts";
import { docBlockNames, docImageIds, resolveDoc } from "./markdown.ts";
const DEFS = [
  { key: "Caption", label: "Caption", content: "inline", props: [] },
  { key: "Callout", label: "Call-out", content: "blocks", props: [] },
  { key: "LinkButton", label: "Button", content: "none", props: [{ key: "label", label: "Text", type: "text" }, { key: "href", label: "Link", type: "text" }] },
  { key: "Gallery", label: "Gallery", content: "none", props: [{ key: "columns", label: "Columns", type: "number" }, { key: "aspect", label: "Shape", type: "text" }, { key: "images", label: "Images", type: "images", library: "media", rooted: true }] },
].map((d) => BlockDef.parse(d));
const map = new Map(DEFS.map((d) => [d.key, d]));
const SITE = `Intro text.

<Caption>
Image credit: [Caroline Badran](https://unsplash.com/@x?utm_source=a&utm_medium=b) on [Unsplash](https://unsplash.com/photos/y)
</Caption>

<Callout>
My **e-design** might be just the right thing.

A second paragraph.
</Callout>

<LinkButton label="Get in touch" href="/contact" />

<Gallery columns={2} aspect="3/2" images={[{"src": "/src/assets/pages/gallery/a.jpg", "alt": "A bright room"}, {"src": "/src/assets/pages/gallery/b.jpg", "alt": "Another"}]} />

After.
`;
const imp = (s: string) => ({ type: "doc", content: fromMarkdown(s, { mdx: true, blocks: DEFS }) }) as Node;
const exp = (d: Node, r?: any) => toMarkdown(d as never, r, { mdx: true, blocks: map });

test("blocks: the site's own components import as blocks and export byte-for-byte", () => {
  const doc = imp(SITE);
  assert.deepEqual(doc.content!.map((n) => n.type), ["paragraph", "blockInline", "blockWrap", "blockLeaf", "blockLeaf", "paragraph"]);
  assert.deepEqual(doc.content![3].attrs, { name: "LinkButton", props: { label: "Get in touch", href: "/contact" } });
  assert.deepEqual(doc.content![4].attrs!.props.images[1], { src: "/src/assets/pages/gallery/b.jpg", alt: "Another" });
  assert.equal(doc.content![2].content!.length, 2, "a Callout holds paragraphs");
  assert.equal(exp(doc), SITE);
});

test("blocks: a Caption's text keeps its links and marks as editable content", () => {
  const cap = imp(SITE).content![1];
  assert.deepEqual(cap.content!.filter((n) => n.marks?.some((m) => m.type === "link")).map((n) => n.text), ["Caroline Badran", "Unsplash"]);
});

test("blocks: anything that doesn't parse cleanly stays as written", () => {
  for (const src of [
    '<Gallery colums={2} />',                                   // a property the block doesn't have
    '<LinkButton label={label} href="/x" />',                    // an expression we can't evaluate
    "<Caption>\nOne.\n\nTwo.\n</Caption>",                        // more than one run of text in an inline block
    '<LinkButton label="x" href="/y">inside</LinkButton>',       // content in a block that has none
    "<Unknown a=\"1\" />",                                        // not a defined block
  ]) assert.deepEqual(imp(src).content!.map((n) => n.type), ["rawBlock"], src);
});

test("blocks: library images are written as resolved paths; rooted blocks get project-root paths", () => {
  const doc = { type: "doc", content: [{ type: "blockLeaf", attrs: { name: "Gallery", props: { columns: 2, images: [{ entry: "e1", src: "/api/blobs/x.jpg", alt: "stale" }, { entry: "gone", src: "/api/blobs/y.jpg", alt: "Kept" }] } } }] } as Node;
  const out = exp(doc, (id: string) => (id === "e1" ? { src: "../../assets/library/a.jpg", alt: "Fresh alt", path: "src/assets/library/a.jpg" } : undefined));
  assert.equal(out, '<Gallery columns={2} images={[{"src": "/src/assets/library/a.jpg", "alt": "Fresh alt"}, {"src": "/api/blobs/y.jpg", "alt": "Kept"}]} />\n');
  assert.deepEqual(docImageIds(doc), ["e1", "gone"]);
  assert.deepEqual(docBlockNames(imp(SITE)), ["Caption", "Callout", "LinkButton", "Gallery"]);
  const json = resolveDoc(doc, (id) => (id === "e1" ? { src: "../a.jpg", alt: "Fresh alt", path: "src/assets/library/a.jpg" } : undefined), map);
  assert.deepEqual(json.content![0].attrs!.props.images[0], { src: "/src/assets/library/a.jpg", alt: "Fresh alt" });
});

test("blocks: the editor's Markdown view links gallery images to the library and reads them back", () => {
  const doc = { type: "doc", content: [{ type: "blockLeaf", attrs: { name: "Gallery", props: { images: [{ entry: "e1", src: "/api/blobs/x.jpg", alt: "A" }] } } }] } as Node;
  const md = exp(doc, (id: string, a: any) => ({ src: "cosy:entry/" + id, alt: String(a.alt) }));
  assert.equal(md, '<Gallery images={[{"src": "cosy:entry/e1", "alt": "A"}]} />\n');
  assert.deepEqual(imp(md).content![0].attrs!.props.images, [{ entry: "e1", alt: "A" }]);
});

test("blocks: strings JSX would reinterpret are written as expressions", () => {
  const doc = { type: "doc", content: [{ type: "blockLeaf", attrs: { name: "LinkButton", props: { label: 'Say "hi" & <go>', href: "/a" } } }] } as Node;
  const md = exp(doc);
  assert.equal(md, '<LinkButton label={"Say \\"hi\\" & <go>"} href="/a" />\n');
  assert.deepEqual(imp(md).content![0].attrs!.props, { label: 'Say "hi" & <go>', href: "/a" });
});

test("blocks: definitions are validated", () => {
  assert.ok(!BlockDef.safeParse({ key: "gallery", label: "G", content: "none", props: [] }).success, "must be a component name");
  assert.ok(!BlockDef.safeParse({ key: "G", label: "G", content: "none", props: [{ key: "a", label: "A", type: "text" }, { key: "a", label: "B", type: "text" }] }).success, "duplicate property");
  assert.ok(!BlockDef.safeParse({ key: "G", label: "G", content: "none", props: [{ key: "a", label: "A", type: "select", options: [] }] }).success, "select needs options");
});

test("an image with align/size is an MDX component only when the field names one, and round-trips", () => {
  const doc: Node = { type: "doc", content: [
    { type: "libraryImage", attrs: { entry: "a1", alt: 'A "panda"', align: "left", size: "small" } },
    { type: "libraryImage", attrs: { entry: "a2", alt: "plain" } },
  ] };
  const resolve = (id: string, a: Record<string, unknown>) => ({ src: LIBRARY_PREFIX + id, alt: String(a.alt) });
  const out = toMarkdown(doc, resolve, { mdx: true, imageComponent: "Image" });
  assert.equal(out, `<Image src="cosy:entry/a1" alt={"A \\"panda\\""} align="left" size="small" />\n\n![plain](cosy:entry/a2)\n`);
  const back = fromMarkdown(out, { mdx: true, imageComponent: "Image" });
  assert.deepEqual(back[0], { type: "libraryImage", attrs: { entry: "a1", alt: 'A "panda"', align: "left", size: "small" } });
  assert.deepEqual(back[1], { type: "libraryImage", attrs: { entry: "a2", alt: "plain" } });
  // without a component name (or without MDX) the settings are not written
  assert.equal(toMarkdown(doc, resolve, { mdx: true }).split("\n")[0], '![A "panda"](cosy:entry/a1)');
  // an unknown option stays as written
  assert.equal(fromMarkdown('<Image src="cosy:entry/a1" align="up" />', { mdx: true, imageComponent: "Image" })[0].type, "rawBlock");
});

test("fillPictures gives text that came in as Markdown the picture address the editor needs", () => {
  const doc: Node = { type: "doc", content: [
    { type: "libraryImage", attrs: { entry: "a", alt: "x" } },
    { type: "libraryImage", attrs: { entry: "b", alt: "y", src: "/kept" } },
    { type: "blockLeaf", attrs: { name: "Gallery", props: { images: [{ entry: "a", alt: "" }, { entry: "zzz", alt: "" }] } } },
  ] };
  fillPictures(doc, (id) => (id === "zzz" ? undefined : `/api/blobs/${id}`));
  assert.equal(doc.content![0].attrs!.src, "/api/blobs/a");
  assert.equal(doc.content![1].attrs!.src, "/kept");
  const imgs = (doc.content![2].attrs!.props as any).images;
  assert.equal(imgs[0].src, "/api/blobs/a");
  assert.equal(imgs[1].src, undefined);
});

test("links to entries: round-trip as cosy:entry/<id>, then resolve to page addresses or lose the link", () => {
  const md = "See [the oiling guide](cosy:entry/abc-1) and [gone](cosy:entry/zzz).\n";
  const doc: Node = { type: "doc", content: fromMarkdown(md) };
  assert.equal(toMarkdown(doc), md);
  assert.deepEqual(docLinkIds(doc), ["abc-1", "zzz"]);
  const out = toMarkdown(resolveLinks(doc, (id) => (id === "abc-1" ? "/blog/oiling" : undefined)));
  assert.equal(out, "See [the oiling guide](/blog/oiling) and gone.\n");
});
