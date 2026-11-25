import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeEnv, parseArgs } from "./deploy.mjs";

test("mergeEnv keeps an existing secret and fills only what is missing", () => {
  const r = mergeEnv("SETTINGS_KEY=keep\nGITHUB_CLIENT_ID=abc\n", { SETTINGS_KEY: "new", SETUP_TOKEN: "t" });
  assert.deepEqual(r.added, ["SETUP_TOKEN"]);
  assert.equal(r.text, "SETTINGS_KEY=keep\nGITHUB_CLIENT_ID=abc\nSETUP_TOKEN=t\n");
});

test("mergeEnv replaces an empty value and handles an empty file", () => {
  assert.equal(mergeEnv("SETTINGS_KEY=\n", { SETTINGS_KEY: "k" }).text, "SETTINGS_KEY=k\n");
  assert.equal(mergeEnv("", { A: "1" }).text, "A=1\n");
});

test("parseArgs takes values, --k=v, and bare booleans", () => {
  assert.deepEqual(parseArgs(["--target", "docker", "--host=me@box", "--yes", "--json"]), { target: "docker", host: "me@box", yes: true, json: true });
});
