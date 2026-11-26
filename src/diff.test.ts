import { test } from "node:test";
import assert from "node:assert/strict";
import { collapse, docText, fieldChanges, lineDiff } from "./diff.ts";
import type { Field } from "./fields.ts";

const f = (key: string, type: string, extra: object = {}) => ({ key, label: key[0].toUpperCase() + key.slice(1), type, ...extra }) as unknown as Field;

test("lineDiff finds added, removed and kept lines", () => {
  const d = lineDiff(["a", "b", "c"], ["a", "x", "c", "d"]);
  assert.deepEqual(d.map((l) => l.t + ":" + l.s), ["same:a", "del:b", "add:x", "same:c", "add:d"]);
});

test("collapse hides long unchanged runs but keeps context", () => {
  const lines = lineDiff(["1", "2", "3", "4", "5", "6", "7"], ["1", "2", "3", "4", "5", "6", "7!"]);
  const c = collapse(lines, 1);
  assert.deepEqual(c.map((l) => l.t), ["gap", "same", "del", "add"]);
  assert.equal((c[0] as { n: number }).n, 5);
});

test("docText flattens an editor document into lines", () => {
  const doc = { type: "doc", content: [
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Title" }] },
    { type: "paragraph", content: [{ type: "text", text: "Hello " }, { type: "text", text: "world" }] },
    { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }] }] },
    { type: "libraryImage", attrs: { alt: "A cat" } },
  ] };
  assert.equal(docText(doc), "## Title\nHello world\n• one\n[image: A cat]");
});

test("fieldChanges reports only what changed, by kind", () => {
  const fields = [f("title", "text"), f("tags", "select", { multiple: true }), f("body", "richtext"), f("draft", "boolean"), f("cover", "reference")];
  const doc = (t: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: t }] }] });
  const c = fieldChanges(fields, { title: "Old", tags: ["a", "b"], body: doc("x"), draft: false, cover: "1" }, { title: "New", tags: ["b", "c"], body: doc("y"), draft: undefined, cover: "2" });
  assert.deepEqual(c.map((x) => x.key + ":" + x.kind), ["title:value", "tags:list", "body:lines", "cover:note"]);
  const tags = c[1] as { added: string[]; removed: string[] };
  assert.deepEqual([tags.added, tags.removed], [["c"], ["a"]]);
});

test("empty values count as equal", () => {
  assert.deepEqual(fieldChanges([f("a", "text"), f("t", "select", { multiple: true })], { a: "", t: [] }, { t: undefined }), []);
});

test("fields the system sets on every save are not listed as changes", () => {
  const c = fieldChanges([f("updated", "datetime", { autoSet: "save" }), f("title", "text")], { updated: "2026-01-01T00:00:00.000Z", title: "a" }, { updated: "2026-02-02T00:00:00.000Z", title: "b" });
  assert.deepEqual(c.map((x) => x.key), ["title"]);
});
