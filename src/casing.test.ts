import { test } from "node:test";
import assert from "node:assert/strict";
import { capitalise, capitaliseHeadings } from "./casing.ts";

test("each word: raises the first letter, leaves the rest alone", () => {
  assert.equal(capitalise("the dream, the work and NASA's iPhone", "words"), "The Dream, The Work And NASA's IPhone");
  assert.equal(capitalise("well-known (the) 3rd place", "words"), "Well-Known (The) 3rd Place");
});
test("title case: small words stay lowercase except first, last and after a colon", () => {
  assert.equal(capitalise("the dream and the work of a life", "title"), "The Dream and the Work of a Life");
  assert.equal(capitalise("what it is: from here to there", "title"), "What It is: From Here to There");
  assert.equal(capitalise("things to look forward to", "title"), "Things to Look Forward To");
  assert.equal(capitalise("The Dream And The Work", "title"), "The Dream and the Work");
  assert.equal(capitalise("don't stop", "title"), "Don't Stop");
});
test("links, addresses and lines", () => {
  assert.equal(capitalise("see https://x.test/a or me@x.test", "words"), "See https://x.test/a Or me@x.test");
  assert.equal(capitalise("one two\nthree four", "words"), "One Two\nThree Four");
});
test("rich text: only headings change, across marks", () => {
  const doc = { type: "doc", content: [
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "the dream " }, { type: "text", text: "and the work", marks: [{ type: "bold" }] }] },
    { type: "paragraph", content: [{ type: "text", text: "the body stays" }] },
  ] };
  const out = capitaliseHeadings(doc, "title") as typeof doc;
  assert.equal(out.content[0].content!.map((t: any) => t.text).join(""), "The Dream and the Work");
  assert.deepEqual((out.content[0].content![1] as any).marks, [{ type: "bold" }]);
  assert.equal((out.content[1].content![0] as any).text, "the body stays");
});

test("a field the person opted out of is left as typed", async () => {
  const { dataSchema } = await import("./fields.ts");
  const col = { fields: [{ key: "title", label: "Title", type: "text" as const, casing: "words" as const }, { key: "sub", label: "Sub", type: "text" as const, casing: "words" as const }] };
  assert.deepEqual(dataSchema(col).parse({ title: "a b", sub: "c d" }), { title: "A B", sub: "C D" });
  assert.deepEqual(dataSchema(col, { sub: ["c d"] }).parse({ title: "a b", sub: "c d" }), { title: "A B", sub: "c d" });
  assert.deepEqual(dataSchema(col, { sub: ["other"] }).parse({ title: "a b", sub: "c d" }), { title: "A B", sub: "C D" }); // a different text is asked about afresh
});

test("rich text: a heading kept as typed stays, the others change", () => {
  const h = (t: string) => ({ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: t }] });
  const out = capitaliseHeadings({ type: "doc", content: [h("keep me here"), h("change me here")] }, "words", ["keep me here"]) as any;
  assert.deepEqual(out.content.map((n: any) => n.content[0].text), ["keep me here", "Change Me Here"]);
});
