import { test } from "node:test";
import assert from "node:assert/strict";
import { backoff, futureTime } from "./schedule.ts";

test("only a real time in the future is scheduled", () => {
  const now = Date.parse("2026-12-01T10:00:00Z");
  assert.equal(futureTime("2026-12-01T10:00:01Z", now)?.toISOString(), "2026-12-01T10:00:01.000Z");
  for (const v of ["2026-12-01T10:00:00Z", "2026-11-30T10:00:00Z", "", "soon", null, undefined, 5]) assert.equal(futureTime(v, now), null);
});

test("retries back off", () => assert.deepEqual([1, 2].map(backoff), [300_000, 600_000]));
