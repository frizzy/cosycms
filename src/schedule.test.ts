import { test } from "node:test";
import assert from "node:assert/strict";
import { backoff, futureTime } from "./schedule.ts";

test("only a real time in the future is scheduled", () => {
  const now = Date.parse("2026-12-01T10:00:00Z");
  assert.equal(futureTime("2026-12-01T10:00:01Z", now)?.toISOString(), "2026-12-01T10:00:01.000Z");
  for (const v of ["2026-12-01T10:00:00Z", "2026-11-30T10:00:00Z", "", "soon", null, undefined, 5]) assert.equal(futureTime(v, now), null);
});

test("retries back off", () => assert.deepEqual([1, 2].map(backoff), [300_000, 600_000]));

import { render, type RenderCtx } from "./plan.ts";
const col = (format: string | null) => ({ fields: [{ key: "title", label: "Title", type: "text" as const }], format, dates: true });
const ctx = (format: string | null): RenderCtx => ({ collections: new Map([["posts", col(format)]]), entries: new Map() });
const entry = { id: "1", collection: "posts", slug: "a", data: { title: "T", publishedAt: "2026-01-02T03:04:05.000Z", revisedAt: "2026-02-03T04:05:06.000Z" } };

test("collections with dates publish publishedAt and revisedAt", () => {
  assert.match(render(entry, ctx("markdown")).content, /publishedAt: 2026-01-02T03:04:05.000Z\nrevisedAt: 2026-02-03T04:05:06.000Z/);
  assert.equal(JSON.parse(render(entry, ctx(null)).content).publishedAt, "2026-01-02T03:04:05.000Z");
});

test("without dates the keys are not added", () => {
  const plain: RenderCtx = { collections: new Map([["posts", { fields: col(null).fields, format: "markdown" }]]), entries: new Map() };
  assert.doesNotMatch(render(entry, plain).content, /publishedAt/);
});
