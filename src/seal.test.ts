import test from "node:test";
import assert from "node:assert/strict";
import { isSealed, seal, unseal } from "./seal.ts";

const k = Buffer.alloc(32, 7).toString("base64");
test("seal round-trips and never contains the plaintext", async () => {
  const s = await seal("ghp_secret", k, "github.token");
  assert.ok(isSealed(s) && !s.includes("ghp_secret"));
  assert.equal(await unseal(s, k, "github.token"), "ghp_secret");
  assert.notEqual(s, await seal("ghp_secret", k, "github.token")); // fresh IV each time
});
test("wrong key, wrong setting name, tampering and bad key length all fail", async () => {
  const s = await seal("x", k, "github.token");
  await assert.rejects(unseal(s, Buffer.alloc(32, 8).toString("base64"), "github.token"), /can't be decrypted/);
  await assert.rejects(unseal(s, k, "github.repo"), /can't be decrypted/);
  await assert.rejects(unseal(s.slice(0, -2) + "AA", k, "github.token"), /can't be decrypted/);
  await assert.rejects(seal("x", "c2hvcnQ=", "n"), /32 random bytes/);
});
