import { test } from "node:test";
import assert from "node:assert/strict";
import { draftWarnings, entryFiles, filePath, plan, relative, render, type PublishedEntry, type RenderCtx } from "./plan.ts";
import { githubRuns, githubTarget } from "./github.ts";
import { frontmatter } from "./frontmatter.ts";
import { IMAGE_DEFAULTS, KEY_RE, blobKey, fitWithin, imageOptions, isAnimated, outputType, sniffImage } from "./images.ts";
import { CollectionCreate, CollectionDef, dataSchema, entryLabel, folderError, nextFreeSlug, shapeChanges, slugify, type Field } from "./fields.ts";

const e = (id: string, slug: string, title = "T"): PublishedEntry => ({ id, collection: "posts", slug, data: { title } });
const stateOf = async (x: PublishedEntry) => {
  const p = await plan([x], []);
  return p.upserts[0];
};

test("first publish upserts everything", async () => {
  const p = await plan([e("1", "a"), e("2", "b")], []);
  assert.deepEqual(p.changes.map((c) => [c.type, c.path]), [["upsert", "posts/a.json"], ["upsert", "posts/b.json"]]);
});

test("unchanged entries are skipped, edited ones re-sent", async () => {
  const a = e("1", "a"), s = await stateOf(a);
  assert.equal((await plan([a], [s])).changes.length, 0);
  assert.equal((await plan([e("1", "a", "new")], [s])).changes.length, 1);
});

test("slug rename deletes the old path", async () => {
  const s = await stateOf(e("1", "a"));
  const p = await plan([e("1", "renamed")], [s]);
  assert.deepEqual(p.changes.map((c) => [c.type, c.path]), [["delete", "posts/a.json"], ["upsert", "posts/renamed.json"]]);
});

test("drafted or deleted entries are removed from the target", async () => {
  const s = await stateOf(e("1", "a"));
  const p = await plan([], [s]);
  assert.deepEqual(p.changes.map((c) => [c.type, c.path]), [["delete", "posts/a.json"]]);
  assert.deepEqual(p.removed, ["1"]);
});

test("github target makes one commit with upserts and deletes", async () => {
  const calls: { method: string; url: string; body?: any }[] = [];
  const fake: typeof fetch = async (url, init) => {
    const u = String(url).split("/repos/o/r/")[1], method = init?.method ?? "GET";
    calls.push({ method, url: u, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const out = u.startsWith("git/ref/") ? { object: { sha: "H" } } : u.startsWith("git/commits/") ? { tree: { sha: "BT" } }
      : u === "git/trees" ? { sha: "NT" } : u === "git/commits" ? { sha: "NC" } : {};
    return new Response(JSON.stringify(out));
  };
  const ref = await githubTarget({ token: "t", repo: "o/r", dir: "content" }, fake).publish([
    { type: "upsert", id: "1", path: "posts/a.json", content: "{}" },
    { type: "delete", id: "2", path: "posts/b.json" },
  ]);
  assert.equal(ref, "NC");
  const tree = calls.find((c) => c.url === "git/trees")!.body;
  assert.equal(tree.base_tree, "BT");
  assert.deepEqual(tree.tree.map((t: any) => [t.path, t.content ?? t.sha]), [["content/posts/a.json", "{}"], ["content/posts/b.json", null]]);
  assert.deepEqual(calls.at(-1), { method: "PATCH", url: "git/refs/heads/main", body: { sha: "NC" } });
});

const ok = (fields: Field[], data: unknown) => dataSchema({ fields }).safeParse(data).success;

test("richtext accepts Tiptap docs and rejects strings", () => {
  const f: Field[] = [{ key: "body", label: "Body", type: "richtext" }];
  assert.ok(ok(f, { body: { type: "doc", content: [] } }));
  assert.ok(!ok(f, { body: "plain" }));
});

test("required text, number and url rules", () => {
  const f: Field[] = [{ key: "t", label: "T", type: "text", required: true }, { key: "n", label: "N", type: "number" }, { key: "u", label: "U", type: "url" }];
  assert.ok(ok(f, { t: "x", n: 3, u: "https://a.com" }));
  assert.ok(!ok(f, { t: "" }), "empty required text");
  assert.ok(!ok(f, { t: "x", n: "3" }), "number as string");
  assert.ok(!ok(f, { t: "x", u: "javascript:alert(1)" }), "non-http url");
});

test("select: single, multi, required and free-form tags", () => {
  const sel = (o: object): Field[] => [{ key: "c", label: "C", type: "select", options: ["a", "b"], ...o }];
  assert.ok(ok(sel({}), { c: "a" }) && !ok(sel({}), { c: "z" }), "single is closed");
  assert.ok(ok(sel({}), {}), "optional");
  assert.ok(!ok(sel({ required: true }), {}), "required");
  assert.ok(ok(sel({ multiple: true }), { c: ["a", "b"] }) && !ok(sel({ multiple: true }), { c: ["z"] }), "multi is closed");
  assert.ok(!ok(sel({ multiple: true, required: true }), { c: [] }), "required multi needs one");
  assert.ok(ok(sel({ multiple: true, allowCustom: true }), { c: ["anything"] }), "tags are free-form");
});

test("unknown data keys are stripped, not rejected", () => {
  const r = dataSchema({ fields: [{ key: "t", label: "T", type: "text" }] }).parse({ t: "x", old: 1 });
  assert.deepEqual(r, { t: "x" });
});

test("collection definition rules", () => {
  const f = (o: object) => ({ label: "L", key: "k", fields: [{ key: "a", label: "A", type: "text", ...o }] });
  assert.ok(CollectionCreate.safeParse(f({})).success);
  assert.ok(!CollectionCreate.safeParse({ ...f({}), key: "settings" }).success, "reserved key");
  assert.ok(!CollectionCreate.safeParse({ ...f({}), fields: [f({}).fields[0], f({}).fields[0]] }).success, "duplicate field keys");
  assert.ok(!CollectionCreate.safeParse(f({ type: "select", options: [] })).success, "closed select needs options");
  assert.ok(CollectionCreate.safeParse(f({ type: "select", options: [], allowCustom: true })).success);
});

test("type or single/multi changes are detected", () => {
  const t = (type: any, extra = {}) => [{ key: "a", label: "A", type, ...extra }] as Field[];
  assert.deepEqual(shapeChanges(t("text"), t("number")), ["a"]);
  assert.deepEqual(shapeChanges(t("select", { options: [] }), t("select", { options: [], multiple: true })), ["a"]);
  assert.deepEqual(shapeChanges(t("select", { options: [] }), t("select", { options: ["x"], allowCustom: true })), []);
});

test("slugify", () => {
  assert.equal(slugify("  Hello, World!  "), "hello-world");
  assert.equal(slugify("Café Münster -- 2026"), "cafe-munster-2026");
  assert.equal(slugify("日本語"), ""); // known ASCII-only limit
});

test("slugSource must point at a text field", () => {
  const title = { key: "title", label: "Title", type: "text" }, n = { key: "n", label: "N", type: "number" };
  const ok = (slugSource: string | undefined, fields: object[]) => CollectionCreate.safeParse({ key: "k", label: "L", slugSource, fields }).success;
  assert.ok(ok("title", [title]));
  assert.ok(ok(undefined, [title]), "optional");
  assert.ok(!ok("missing", [title]), "unknown field");
  assert.ok(!ok("n", [n]), "not a text field");
  assert.ok(CollectionDef.safeParse({ label: "L", slugSource: null, fields: [title] }).success, "null clears it");
});

test("nextFreeSlug increments an existing suffix instead of stacking one", () => {
  assert.equal(nextFreeSlug("hello", ["hello"]), "hello-2");
  assert.equal(nextFreeSlug("hello", ["hello", "hello-2"]), "hello-3", "skips taken");
  assert.equal(nextFreeSlug("hello-2", ["hello", "hello-2"]), "hello-3", "increments, not hello-2-2");
  assert.equal(nextFreeSlug("hello-2", ["hello-2", "hello-3", "hello-4"]), "hello-5");
  assert.equal(nextFreeSlug("2024", ["2024"]), "2024-2", "a bare number has no suffix");
});

const bytes = (...n: number[]) => new Uint8Array([...n, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

test("sniffImage identifies real images by magic bytes and rejects everything else", () => {
  assert.equal(sniffImage(bytes(0x89, ...ascii("PNG"))), "image/png");
  assert.equal(sniffImage(bytes(0xff, 0xd8, 0xff)), "image/jpeg");
  assert.equal(sniffImage(bytes(...ascii("GIF89a"))), "image/gif");
  assert.equal(sniffImage(bytes(...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WEBP"))), "image/webp");
  assert.equal(sniffImage(bytes(0, 0, 0, 0, ...ascii("ftypavif"))), "image/avif");
  assert.equal(sniffImage(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>")), undefined, "svg");
  assert.equal(sniffImage(new TextEncoder().encode("<html>")), undefined);
  assert.equal(sniffImage(new Uint8Array()), undefined, "empty");
});

test("blob keys are content-addressed and validated", () => {
  const key = blobKey("a".repeat(64), "image/jpeg");
  assert.equal(key, `media/${"a".repeat(64)}.jpg`);
  assert.ok(KEY_RE.test(key));
  for (const bad of ["media/../../etc/passwd", "media/abc.png", `media/${"a".repeat(64)}.svg`, `other/${"a".repeat(64)}.png`])
    assert.ok(!KEY_RE.test(bad), bad);
});

test("file field validates the stored value", () => {
  const f: Field[] = [{ key: "img", label: "Img", type: "file", required: true }];
  const v = { key: blobKey("b".repeat(64), "image/png"), name: "a.png", size: 100, mime: "image/png" };
  assert.ok(ok(f, { img: v }));
  assert.ok(ok(f, { img: { ...v, width: 10, height: 20 } }));
  assert.ok(!ok(f, {}), "required");
  assert.ok(!ok(f, { img: { ...v, key: "media/../x.png" } }), "bad key");
  assert.ok(!ok(f, { img: { ...v, mime: "image/svg+xml" } }), "svg mime");
  assert.ok(!ok(f, { img: { ...v, size: 11 * 1024 * 1024 } }), "too big");
});

test("image option defaults: cap 2400, keep format, quality 82, strip metadata", () => {
  assert.deepEqual(imageOptions({}), { maxSize: 2400, format: "keep", quality: 82, strip: true });
  assert.deepEqual(imageOptions({ maxSize: 0, format: "webp", quality: 70, stripMetadata: false }), { maxSize: 0, format: "webp", quality: 70, strip: false }, "explicit values win, including 0");
  assert.equal(IMAGE_DEFAULTS.maxSize, 2400);
});

test("fitWithin scales to the longest side and never enlarges", () => {
  assert.deepEqual(fitWithin(4000, 3000, 2400), { width: 2400, height: 1800 });
  assert.deepEqual(fitWithin(3000, 4000, 2400), { width: 1800, height: 2400 }, "portrait");
  assert.deepEqual(fitWithin(800, 600, 2400), { width: 800, height: 600 }, "small stays small");
  assert.deepEqual(fitWithin(4000, 3000, 0), { width: 4000, height: 3000 }, "0 = no limit");
  assert.deepEqual(fitWithin(10000, 1, 100), { width: 100, height: 1 }, "never collapses to 0");
});

test("outputType: AVIF can't be encoded, formats convert", () => {
  assert.equal(outputType("image/png", "keep"), "image/png");
  assert.equal(outputType("image/avif", "keep"), undefined);
  assert.equal(outputType("image/avif", "webp"), "image/webp");
  assert.equal(outputType("image/png", "jpeg"), "image/jpeg");
});

test("animated images are detected so they are left alone", () => {
  const webp = (flags: number) => { const b = new Uint8Array(32); b.set(ascii("RIFF"), 0); b.set(ascii("WEBP"), 8); b.set(ascii("VP8X"), 12); b[20] = flags; return b; };
  assert.equal(isAnimated(webp(0x02), "image/webp"), true);
  assert.equal(isAnimated(webp(0x00), "image/webp"), false, "still webp");
  assert.equal(isAnimated(new Uint8Array(32), "image/gif"), true);
  assert.equal(isAnimated(bytes(0, 0, 0, 0, ...ascii("ftypavis")), "image/avif"), true);
  assert.equal(isAnimated(bytes(0, 0, 0, 0, ...ascii("ftypavif")), "image/avif"), false);
  const apng = new Uint8Array(64); apng.set([0x89, ...ascii("PNG")], 0); apng.set(ascii("acTL"), 30);
  assert.equal(isAnimated(apng, "image/png"), true);
  assert.equal(isAnimated(bytes(0x89, ...ascii("PNG")), "image/png"), false);
  assert.equal(isAnimated(bytes(0xff, 0xd8, 0xff), "image/jpeg"), false);
});

test("image field options are validated", () => {
  const f = (o: object) => CollectionCreate.safeParse({ key: "k", label: "L", fields: [{ key: "img", label: "Img", type: "file", ...o }] }).success;
  assert.ok(f({}) && f({ maxSize: 0, format: "webp", quality: 70, stripMetadata: false }));
  assert.ok(!f({ quality: 0 }) && !f({ quality: 101 }), "quality 1-100");
  assert.ok(!f({ format: "png" }) && !f({ maxSize: -1 }) && !f({ maxSize: 20000 }) && !f({ maxSize: 12.5 }));
});

const refCtx = (slugOf: [string, string][]): RenderCtx => ({
  collections: new Map([["posts", { fields: [
    { key: "hero", label: "Hero", type: "reference", collection: "media" },
    { key: "gallery", label: "Gallery", type: "reference", collection: "media", multiple: true },
  ] as Field[] }]]),
  entries: new Map(slugOf.map(([id, slug]) => [id, { collection: "media", slug, data: {} }])),
});

test("references are published as slugs, single and multiple", () => {
  const ctx = refCtx([["m1", "sunrise"], ["m2", "sunset"]]);
  const out = JSON.parse(render({ id: "p", collection: "posts", slug: "a", data: { title: "T", hero: "m1", gallery: ["m1", "m2"] } }, ctx).content);
  assert.deepEqual(out, { title: "T", hero: "sunrise", gallery: ["sunrise", "sunset"] });
  assert.deepEqual(JSON.parse(render({ id: "p", collection: "posts", slug: "a", data: { title: "T" } }, ctx).content), { title: "T" }, "absent stays absent");
});

test("renaming a referenced entry's slug re-publishes the entries that point at it", async () => {
  const post: PublishedEntry = { id: "p", collection: "posts", slug: "a", data: { hero: "m1" } };
  const first = await plan([post], [], refCtx([["m1", "sunrise"]]));
  assert.equal(first.changes.length, 1);
  assert.equal((await plan([post], first.upserts, refCtx([["m1", "sunrise"]]))).changes.length, 0, "unchanged");
  assert.equal((await plan([post], first.upserts, refCtx([["m1", "dawn"]]))).changes.length, 1, "slug renamed");
});

test("reference fields: shape, validation and target changes", () => {
  const r = (o: object = {}): Field[] => [{ key: "h", label: "H", type: "reference", collection: "media", ...o } as Field];
  assert.ok(ok(r(), { h: "some-id" }) && ok(r(), {}) && !ok(r({ required: true }), {}));
  assert.ok(ok(r({ multiple: true }), { h: ["a", "b"] }) && !ok(r({ multiple: true }), { h: "a" }) && !ok(r({ multiple: true, required: true }), { h: [] }));
  assert.deepEqual(shapeChanges(r(), r({ collection: "other" })), ["h"], "target change");
  assert.deepEqual(shapeChanges(r(), r({ multiple: true })), ["h"], "single to many");
  assert.deepEqual(shapeChanges(r(), r({ label: "Renamed", required: true })), [], "label and required are free to change");
  assert.ok(!CollectionCreate.safeParse({ key: "k", label: "L", fields: [{ key: "h", label: "H", type: "reference" }] }).success, "needs a collection");
});

test("publishing warns about references to drafts, and only those", () => {
  const ctx = refCtx([]);
  const all = new Map([["m1", { collection: "media", slug: "sunrise", status: "published" }], ["m2", { collection: "media", slug: "sunset", status: "draft" }]]);
  const post = (data: Record<string, unknown>): PublishedEntry => ({ id: "p", collection: "posts", slug: "a", data });
  assert.deepEqual(draftWarnings([post({ hero: "m1", gallery: ["m1"] })], all, ctx), []);
  assert.deepEqual(draftWarnings([post({ hero: "m1", gallery: ["m1", "m2"] })], all, ctx), ["posts/a uses media/sunset, which is still a draft"]);
  assert.deepEqual(draftWarnings([post({})], all, ctx), [], "no references");
});

const mdCtx = (extra: Partial<{ format: string | null; bodyField: string | null }> = {}): RenderCtx => ({
  collections: new Map([["posts", { format: "markdown", bodyField: "body", ...extra, fields: [
    { key: "title", label: "Title", type: "text", required: true },
    { key: "published", label: "Published", type: "date" },
    { key: "draft", label: "Draft", type: "boolean" },
    { key: "views", label: "Views", type: "number" },
    { key: "tags", label: "Tags", type: "select", options: [], multiple: true, allowCustom: true },
    { key: "cover", label: "Cover", type: "reference", collection: "images" },
    { key: "summary", label: "Summary", type: "richtext" },
    { key: "body", label: "Body", type: "richtext" },
    { key: "on", label: "On", type: "text" },
  ] as Field[] }]]),
  entries: new Map([["img1", { collection: "images", slug: "panda", data: {} }]]),
});
const doc = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });

test("markdown collections publish .md with frontmatter and a markdown body", () => {
  const out = render({ id: "p", collection: "posts", slug: "hello", data: {
    title: 'Say "hi": a #1 post', published: "2026-11-25", draft: false, views: 12, tags: ["large garden", "yes"],
    cover: "img1", summary: doc("Short *one*"), body: doc("Body text"), on: "x", unset: "ignored",
  } }, mdCtx());
  assert.equal(out.path, "posts/hello.md");
  assert.equal(out.content, `---
title: "Say \\"hi\\": a #1 post"
published: 2026-11-25
draft: false
views: 12
tags:
  - "large garden"
  - "yes"
cover: "panda"
summary: "Short \\\\*one\\\\*"
"on": "x"
---

Body text
`);
});

test("markdown output edge cases: no body, no frontmatter, no body field", () => {
  const e = (data: Record<string, unknown>) => ({ id: "p", collection: "posts", slug: "a", data });
  assert.equal(render(e({ title: "T" }), mdCtx()).content, '---\ntitle: "T"\n---\n', "no body: frontmatter only");
  assert.equal(render(e({ body: doc("Only body") }), mdCtx()).content, "Only body\n", "no frontmatter: body only");
  assert.equal(render(e({ title: "T", body: doc("kept") }), mdCtx({ bodyField: null })).content, '---\ntitle: "T"\nbody: "kept"\n---\n', "no body field: rich text is kept in the frontmatter, not lost");
  assert.equal(render(e({}), mdCtx()).content, "\n", "empty entry still yields a file");
  assert.equal(render(e({ title: "T" })).path, "posts/a.json", "no collection info falls back to JSON");
});

test("switching a collection to markdown moves its files", async () => {
  const post: PublishedEntry = { id: "p", collection: "posts", slug: "a", data: { title: "T" } };
  const asJson = await plan([post], [], { ...mdCtx(), collections: new Map([["posts", { format: null, fields: [] }]]) });
  const asMd = await plan([post], asJson.upserts, mdCtx());
  assert.deepEqual(asMd.changes.map((c) => [c.type, c.path]), [["delete", "posts/a.json"], ["upsert", "posts/a.md"]]);
});

test("frontmatter quotes ambiguous keys and skips empties", () => {
  const f = [{ key: "no", label: "No", type: "text" }, { key: "tags", label: "T", type: "select", options: [], multiple: true }, { key: "x", label: "X", type: "text" }] as Field[];
  assert.equal(frontmatter(f, { no: "a", tags: [], x: null }), '---\n"no": "a"\n---\n');
  assert.equal(frontmatter(f, {}), "");
});

test("collection format and body field are validated", () => {
  const base = { key: "k", label: "L", fields: [{ key: "body", label: "B", type: "richtext" }, { key: "t", label: "T", type: "text" }] };
  const ok = (o: object) => CollectionCreate.safeParse({ ...base, ...o }).success;
  assert.ok(ok({}) && ok({ format: "json" }) && ok({ format: "markdown" }) && ok({ format: "markdown", bodyField: "body" }));
  assert.ok(!ok({ format: "html" }), "unknown format");
  assert.ok(!ok({ format: "markdown", bodyField: "t" }), "body must be rich text");
  assert.ok(!ok({ format: "markdown", bodyField: "missing" }), "body must exist");
  assert.ok(!ok({ format: "json", bodyField: "body" }), "body only applies to markdown");
});

// ---- images: published as files, resolved in content ------------------------------------------------------------------
const KEY = (c: string, ext = "webp") => `media/${c.repeat(64)}.${ext}`;
const file = (c: string, ext = "webp", extra = {}) => ({ key: KEY(c, ext), name: "x." + ext, size: 10, mime: "image/" + ext, width: 800, height: 600, ...extra });
const imgCtx = (format: string | null = null): RenderCtx => ({
  collections: new Map<string, { fields: Field[]; format?: string | null; bodyField?: string | null }>([
    ["images", { fields: [{ key: "image", label: "Image", type: "file" }, { key: "alt", label: "Alt", type: "text" }, { key: "credit", label: "Credit", type: "text" }] as Field[] }],
    ["posts", { format, bodyField: format ? "body" : null, fields: [
      { key: "title", label: "T", type: "text" }, { key: "cover", label: "C", type: "reference", collection: "images" },
      { key: "gallery", label: "G", type: "reference", collection: "images", multiple: true }, { key: "own", label: "O", type: "file" },
      { key: "body", label: "B", type: "richtext", imageLibrary: "images" }] as Field[] }],
  ]),
  entries: new Map([
    ["i1", { collection: "images", slug: "panda", data: { image: file("a"), alt: "A panda", credit: "Me" } }],
    ["i2", { collection: "images", slug: "cat", data: { image: file("b", "gif", { width: undefined }), alt: "A cat" } }],
  ]),
});

test("image file paths and relative links", () => {
  const f = [{ key: "a", label: "A", type: "file" }, { key: "b", label: "B", type: "file" }] as Field[];
  assert.equal(filePath({ collection: "images", slug: "panda" }, [f[0]], f[0], { key: KEY("a"), name: "Panda.PNG" }), "images/panda.webp");
  assert.equal(filePath({ collection: "posts", slug: "x" }, f, f[1], { key: KEY("a", "gif"), name: "n.gif" }), "posts/x.b.gif", "several image fields are told apart by key");
  assert.equal(relative("posts/a.md", "images/panda.webp"), "../images/panda.webp");
  assert.equal(relative("images/panda.json", "images/panda.webp"), "./panda.webp");
  assert.equal(relative("a/b/c.md", "a/x.png"), "../x.png");
});

test("a reference to an image library publishes the file path, size and the entry's own fields", () => {
  const out = JSON.parse(render({ id: "p", collection: "posts", slug: "a", data: { title: "T", cover: "i1", gallery: ["i1", "i2"], own: file("c", "png") } }, imgCtx()).content);
  assert.deepEqual(out.cover, { slug: "panda", src: "../images/panda.webp", width: 800, height: 600, alt: "A panda", credit: "Me" });
  assert.equal(out.gallery[1].src, "../images/cat.gif");
  assert.equal("width" in out.gallery[1], false, "unknown size is left out");
  assert.deepEqual(out.own, { src: "./a.png", width: 800, height: 600 }, "an entry's own upload sits next to it");
  const img = JSON.parse(render({ id: "i1", collection: "images", slug: "panda", data: { image: file("a"), alt: "A panda" } }, imgCtx()).content);
  assert.deepEqual(img.image, { src: "./panda.webp", width: 800, height: 600 });
});

test("images in a markdown body and frontmatter", () => {
  const body = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Hi" }] }, { type: "libraryImage", attrs: { entry: "i1", src: "/api/blobs/x.webp", alt: "stale" } }] };
  const out = render({ id: "p", collection: "posts", slug: "a", data: { title: "T", cover: "i1", gallery: ["i1", "i2"], body } }, imgCtx("markdown")).content;
  assert.ok(out.includes("![A panda](../images/panda.webp)"), "alt and path come from the library entry, not the editor's stale copy");
  assert.ok(out.includes(`cover:\n  slug: "panda"\n  src: \"../images/panda.webp\"\n  width: 800\n  height: 600\n  alt: "A panda"\n  credit: "Me"`), out);
  assert.ok(out.includes(`gallery:\n  - slug: "panda"\n    src: "../images/panda.webp"`), "lists of images are YAML lists of mappings");
  // JSON output keeps the document but swaps the editor's id for the published path
  const json = JSON.parse(render({ id: "p", collection: "posts", slug: "a", data: { body } }, imgCtx()).content);
  assert.deepEqual(json.body.content[1], { type: "libraryImage", attrs: { src: "../images/panda.webp", alt: "A panda" } });
});

test("a missing library image falls back instead of crashing", () => {
  const body = { type: "doc", content: [{ type: "libraryImage", attrs: { entry: "gone", src: "/api/blobs/x.webp", alt: "Lost" } }] };
  assert.ok(render({ id: "p", collection: "posts", slug: "a", data: { body } }, imgCtx("markdown")).content.includes("![Lost](/api/blobs/x.webp)"));
});

test("image files are planned alongside their entry and follow renames and replacements", async () => {
  const e: PublishedEntry = { id: "i1", collection: "images", slug: "panda", data: { image: file("a"), alt: "A" } };
  const first = await plan([e], [], imgCtx());
  assert.deepEqual(first.changes.map((c) => [c.type, c.path, "file" in c ? c.file : "text"]), [["upsert", "images/panda.json", "text"], ["upsert", "images/panda.webp", KEY("a")]]);
  assert.equal((await plan([e], first.upserts, imgCtx())).changes.length, 0, "nothing new, nothing sent");
  const swapped = await plan([{ ...e, data: { ...e.data, image: file("b") } }], first.upserts, imgCtx());
  assert.deepEqual(swapped.changes.map((c) => [c.type, c.path]), [["upsert", "images/panda.webp"]], "a replaced image is sent; the unchanged JSON is not");
  const renamed = await plan([{ ...e, slug: "bear" }], first.upserts, imgCtx());
  assert.deepEqual(renamed.changes.map((c) => [c.type, c.path]).sort(), [["delete", "images/panda.json"], ["delete", "images/panda.webp"], ["upsert", "images/bear.json"], ["upsert", "images/bear.webp"]].sort());
  const gone = await plan([], first.upserts, imgCtx());
  assert.deepEqual(gone.changes.map((c) => [c.type, c.path]).sort(), [["delete", "images/panda.json"], ["delete", "images/panda.webp"]]);
  assert.deepEqual(entryFiles(e, imgCtx()).map((f) => f.id), ["i1#image"]);
});

test("body images are checked for drafts", () => {
  const all = new Map([["i1", { collection: "images", slug: "panda", status: "draft" }]]);
  const body = { type: "doc", content: [{ type: "libraryImage", attrs: { entry: "i1" } }] };
  assert.deepEqual(draftWarnings([{ id: "p", collection: "posts", slug: "a", data: { body } }], all, imgCtx()), ["posts/a uses images/panda, which is still a draft"]);
});

test("github target uploads images as base64 blobs and references them by sha", async () => {
  const calls: { method: string; url: string; body?: any }[] = [];
  const fake: typeof fetch = async (url, init) => {
    const u = String(url).split("/repos/o/r/")[1], method = init?.method ?? "GET";
    calls.push({ method, url: u, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const out = u.startsWith("git/ref/") ? { object: { sha: "H" } } : u.startsWith("git/commits/") ? { tree: { sha: "BT" } } : u === "git/blobs" ? { sha: "BLOB1" }
      : u === "git/trees" ? { sha: "NT" } : u === "git/commits" ? { sha: "NC" } : {};
    return new Response(JSON.stringify(out));
  };
  const bytes = new Uint8Array(70000).map((_, i) => i % 251); // bigger than one base64 slice
  const store = { async get(key: string) { return key === "k" ? { body: new Response(bytes).body!, contentType: "image/png", size: bytes.length } : null; }, async put() {}, async head() { return null; } };
  const target = githubTarget({ token: "t", repo: "o/r", dir: "content" }, fake, store);
  await target.publish([{ type: "upsert", id: "1", path: "images/a.png", file: "k" }, { type: "upsert", id: "2", path: "images/a.json", content: "{}" }]);
  const blob = calls.find((c) => c.url === "git/blobs")!.body;
  assert.equal(blob.encoding, "base64");
  assert.ok(Buffer.from(blob.content, "base64").equals(Buffer.from(bytes)), "bytes survive the round trip");
  const tree = calls.find((c) => c.url === "git/trees")!.body.tree;
  assert.deepEqual(tree.map((t: any) => [t.path, t.sha ?? t.content]), [["content/images/a.png", "BLOB1"], ["content/images/a.json", "{}"]]);
  await assert.rejects(() => target.publish([{ type: "upsert", id: "3", path: "images/b.png", file: "missing" }]), /missing from storage/);
});

test("title field: must be a single-line text field; shown when filled, otherwise the usual fallbacks", () => {
  const name: Field = { key: "name", label: "Name", type: "text" };
  const blurb: Field = { key: "blurb", label: "Blurb", type: "textarea" };
  assert.ok(CollectionDef.safeParse({ label: "L", titleField: "name", fields: [name] }).success);
  assert.ok(CollectionDef.safeParse({ label: "L", titleField: null, fields: [name] }).success, "null clears it");
  assert.ok(!CollectionDef.safeParse({ label: "L", titleField: "blurb", fields: [blurb] }).success, "textarea isn't a title");
  assert.ok(!CollectionDef.safeParse({ label: "L", titleField: "gone", fields: [name] }).success, "must exist");
  assert.equal(entryLabel([name, blurb], { name: "Chosen", blurb: "x" }, "slug", "name"), "Chosen");
  assert.equal(entryLabel([name, blurb], { name: "  " }, "slug", "name"), "slug", "blank title falls back");
  assert.equal(entryLabel([name], { name: "First text" }, "slug"), "First text", "unset keeps the old behaviour");
});

// ---- a site laid out like the first real one: content in src/content, images in src/assets, dates and a cover path ----
const siteFields = [
  { key: "title", label: "Title", type: "text" }, { key: "pubDate", label: "Published", type: "datetime" },
  { key: "cover", label: "Cover", type: "file", folder: "src/assets/{collection}/{slug}", keepName: true, publishAs: "path" },
  { key: "body", label: "Body", type: "richtext" },
] as Field[];
const siteCtx = (): RenderCtx => ({ collections: new Map([["posts", { fields: siteFields, format: "mdx", bodyField: "body", folder: "src/content/posts" }]]), entries: new Map() });
const para = (t: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: t }] }] });

test("datetime fields validate as UTC timestamps", () => {
  const s = dataSchema({ fields: [{ key: "at", label: "At", type: "datetime", required: true }] as Field[] });
  assert.ok(s.safeParse({ at: "2026-11-19T15:00:04.305Z" }).success);
  assert.ok(s.safeParse({ at: "2026-11-19T15:00:00Z" }).success);
  assert.ok(!s.safeParse({ at: "2026-11-19" }).success, "a bare date isn't a timestamp");
  assert.ok(!s.safeParse({ at: "yesterday" }).success);
  assert.ok(!s.safeParse({}).success, "required");
});

test("folders: placeholders only where allowed, no escaping the target", () => {
  assert.equal(folderError("src/content/posts", false), null);
  assert.equal(folderError("src/assets/{collection}/{slug}", true), null);
  assert.ok(folderError("src/{slug}", false), "collection folders have no placeholders");
  assert.ok(folderError("../x", false) && folderError("/abs", false) && folderError("a//b", false) && folderError("a/", false) && folderError("a/{nope}", true));
  const f = { key: "i", label: "I", type: "file" as const };
  assert.ok(!CollectionDef.safeParse({ label: "L", folder: "../x", fields: [f] }).success);
  assert.ok(!CollectionDef.safeParse({ label: "L", fields: [{ ...f, folder: "a/../b" }] }).success);
  assert.ok(!CollectionDef.safeParse({ label: "L", fields: [{ ...f, keepName: true }] }).success, "keeping names needs a folder");
  assert.ok(CollectionDef.safeParse({ label: "L", format: "mdx", folder: "content/posts", fields: [f] }).success);
});

test("image folder and file name templates", () => {
  const e = { collection: "posts", slug: "my-post" };
  const keep = siteFields[2], plain = { ...keep, keepName: false } as Field;
  assert.equal(filePath(e, siteFields, keep, { key: KEY("a", "jpg"), name: "Caroline Badran – E Z8ie.JPG" }), "src/assets/posts/my-post/caroline-badran-e-z8ie.jpg", "the uploaded name, made safe");
  assert.equal(filePath(e, siteFields, keep, { key: KEY("a", "webp"), name: "photo.jpg" }), "src/assets/posts/my-post/photo.webp", "the extension follows the stored (re-encoded) file");
  assert.equal(filePath(e, siteFields, plain, { key: KEY("a", "jpg"), name: "x.jpg" }), "src/assets/posts/my-post/my-post.jpg", "without keepName: the slug");
  assert.equal(filePath(e, siteFields, keep, { key: KEY("a", "png"), name: "???.png" }), "src/assets/posts/my-post/image.png", "nothing usable in the name");
});

test("an MDX collection publishes .mdx into its folder, with a path-string cover and an unquoted timestamp", () => {
  const out = render({ id: "p", collection: "posts", slug: "my-post", data: { title: "Hi", pubDate: "2026-11-19T15:00:04.305Z", cover: file("a", "jpg", { name: "Big Photo.jpg" }), body: para("Hello") } }, siteCtx());
  assert.equal(out.path, "src/content/posts/my-post.mdx");
  assert.equal(out.content, `---\ntitle: "Hi"\npubDate: 2026-11-19T15:00:04.305Z\ncover: "../../assets/posts/my-post/big-photo.jpg"\n---\n\nHello\n`);
});

test("MDX text escapes the characters MDX would read as code; Markdown does not", () => {
  const body = para("Under <40cm and {braces} and <b>tags</b>");
  const mdx = render({ id: "p", collection: "posts", slug: "a", data: { title: "T", body } }, siteCtx()).content;
  assert.ok(mdx.includes("Under \\<40cm and \\{braces} and \\<b>tags\\</b>"), mdx);
  const md = render({ id: "p", collection: "posts", slug: "a", data: { title: "T", body } }, { collections: new Map([["posts", { fields: siteFields, format: "markdown", bodyField: "body" }]]), entries: new Map() }).content;
  assert.ok(md.includes("Under <40cm and {braces} and \\<b>tags\\</b>"), md);
});

test("the image file is planned at its template path, and a path both files want is a conflict", async () => {
  const mk = (id: string, slug: string): PublishedEntry => ({ id, collection: "posts", slug, data: { title: "T", cover: file("a", "jpg", { name: "same.jpg" }) } });
  const solo = await plan([mk("1", "one")], [], siteCtx());
  assert.deepEqual(solo.changes.map((c) => c.path).sort(), ["src/assets/posts/one/same.jpg", "src/content/posts/one.mdx"]);
  assert.deepEqual(solo.conflicts, []);
  const ctx = siteCtx();
  ctx.collections.get("posts")!.fields = [siteFields[0], { ...siteFields[2], folder: "src/assets/shared" } as Field];
  const clash = await plan([mk("1", "one"), mk("2", "two")], [], ctx);
  assert.deepEqual(clash.conflicts, ["src/assets/shared/same.jpg"], "two entries uploading same.jpg into one folder");
});

test("thumbnail field: an image or a reference only", () => {
  const img: Field = { key: "cover", label: "Cover", type: "file" }, ref: Field = { key: "pic", label: "Pic", type: "reference", collection: "media" };
  const txt: Field = { key: "name", label: "Name", type: "text" };
  assert.ok(CollectionDef.safeParse({ label: "L", thumbField: "cover", fields: [img, txt] }).success);
  assert.ok(CollectionDef.safeParse({ label: "L", thumbField: "pic", fields: [ref] }).success);
  assert.ok(CollectionDef.safeParse({ label: "L", thumbField: null, fields: [txt] }).success, "null clears it");
  assert.ok(!CollectionDef.safeParse({ label: "L", thumbField: "name", fields: [txt] }).success, "text isn't an image");
  assert.ok(!CollectionDef.safeParse({ label: "L", thumbField: "gone", fields: [img] }).success, "must exist");
});

test("a link to another entry publishes as that collection's page address", () => {
  const ctx = siteCtx();
  ctx.collections.set("posts", { ...ctx.collections.get("posts")!, urlTemplate: "/blog/{slug}" });
  ctx.collections.set("notes", { fields: [], format: "json" });
  ctx.entries.set("t1", { collection: "posts", slug: "oiling", data: {} });
  ctx.entries.set("t2", { collection: "notes", slug: "n", data: {} }); // a collection with no page address
  const body = { type: "doc", content: [{ type: "paragraph", content: [
    { type: "text", text: "guide", marks: [{ type: "link", attrs: { href: "cosy:entry/t1" } }] }, { type: "text", text: " and " },
    { type: "text", text: "note", marks: [{ type: "link", attrs: { href: "cosy:entry/t2" } }] }] }] };
  const e = { id: "p", collection: "posts", slug: "a", data: { title: "T", body } };
  assert.ok(render(e, ctx).content.includes("[guide](/blog/oiling) and note"));
  const warn = draftWarnings([e], new Map([["t1", { collection: "posts", slug: "oiling", status: "published" }], ["t2", { collection: "notes", slug: "n", status: "published" }]]), ctx);
  assert.equal(warn.length, 1);
  assert.match(warn[0], /notes has no page address/);
});

test("githubRuns: looks up runs by commit and reduces them to one state", async () => {
  const run = (status: string, conclusion: string | null, name = "Deploy") => ({ name, status, conclusion, html_url: `https://x/${name}` });
  const ask = async (runs: unknown[]) => {
    let url = "";
    const fake: typeof fetch = async (u) => { url = String(u); return new Response(JSON.stringify({ workflow_runs: runs })); };
    const r = await githubRuns({ token: "t", repo: "o/r" }, "abc", fake);
    return { ...r, url };
  };
  const a = await ask([]);
  assert.equal(a.state, "none");
  assert.match(a.url, /repos\/o\/r\/actions\/runs\?head_sha=abc/);
  assert.equal((await ask([run("queued", null)])).state, "running");
  assert.equal((await ask([run("completed", "success"), run("in_progress", null, "Lint")])).state, "running");
  assert.equal((await ask([run("completed", "success"), run("completed", "skipped", "Lint")])).state, "success");
  assert.equal((await ask([run("completed", "success"), run("completed", "failure", "Lint")])).state, "failed");
  assert.equal((await ask([run("completed", "cancelled")])).state, "failed");
  const denied: typeof fetch = async () => new Response("nope", { status: 403 });
  await assert.rejects(() => githubRuns({ token: "t", repo: "o/r" }, "abc", denied), (e: any) => e.status === 403);
});
