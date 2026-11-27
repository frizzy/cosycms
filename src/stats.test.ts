import { test } from "node:test";
import assert from "node:assert/strict";
import { countWords, entryStats, readingMinutes } from "./stats.ts";
import type { Field } from "./fields.ts";

const p = (t: string) => ({ type: "paragraph", content: [{ type: "text", text: t }] });
const doc = (...c: unknown[]) => ({ type: "doc", content: c });

test("counts words across paragraphs and marks, ignoring punctuation-only runs", () => {
  assert.equal(countWords(doc(p("One two three"), { type: "heading", content: [{ type: "text", text: "Four" }] }, p("— five"))), 5);
  assert.equal(countWords(doc({ type: "paragraph", content: [{ type: "text", text: "bold", marks: [{ type: "bold" }] }, { type: "text", text: "word" }] })), 1);
  assert.equal(countWords("a plain  string"), 3);
  assert.equal(countWords(undefined), 0);
});

test("reading time rounds up, at least a minute when there is text", () => {
  assert.deepEqual([0, 1, 200, 201, 1000].map(readingMinutes), [0, 1, 1, 2, 5]);
});

test("uses the body field, or all rich text fields without one", () => {
  const fields = [{ key: "intro", label: "Intro", type: "richtext" }, { key: "body", label: "Body", type: "richtext" }, { key: "t", label: "T", type: "text" }] as unknown as Field[];
  const data = { intro: doc(p("a b")), body: doc(p("c d e")), t: "ignored words here" };
  assert.deepEqual(entryStats(fields, data, "body"), { wordCount: 3, readingTime: 1 });
  assert.deepEqual(entryStats(fields, data), { wordCount: 5, readingTime: 1 });
});
