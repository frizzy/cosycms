import { test } from "node:test";
import assert from "node:assert/strict";
import { ftsQuery, idsIn, indexText } from "./search.ts";
import type { Field } from "./fields.ts";

const f = (key: string, type: string, extra: object = {}) => ({ key, label: key, type, ...extra }) as unknown as Field;
const doc = (t: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: t }] }] });

test("indexText: title, tags, and the rest as body", () => {
  const fields = [f("title", "text"), f("description", "textarea"), f("tags", "select", { multiple: true }), f("category", "select"), f("body", "richtext"), f("order", "number")];
  const t = indexText({ fields, titleField: "title" }, { id: "1", collection: "posts", slug: "my-post", data: { title: "Clay plaster", description: "About walls", tags: ["lime", "clay"], category: "diy", body: doc("Mix the lime first"), order: 3 } });
  assert.deepEqual(t, { title: "Clay plaster", tags: "lime clay diy", body: "About walls\nMix the lime first", slug: "my-post" });
});

test("ftsQuery turns words into prefix terms and ignores punctuation", () => {
  assert.equal(ftsQuery('clay  plast"er!'), '"clay"* "plast"* "er"*');
  assert.equal(ftsQuery("café"), '"café"*');
  assert.equal(ftsQuery("  ?! "), null);
});

test("idsIn finds every id once, in any JSON", () => {
  const a = "11111111-1111-4111-8111-111111111111", b = "22222222-2222-4222-8222-222222222222";
  assert.deepEqual(idsIn({ x: [a, { y: `link cosy:entry/${b}` }], z: a }, null, { w: a }), [a, b]);
});
