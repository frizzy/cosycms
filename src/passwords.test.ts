import test from "node:test";
import assert from "node:assert/strict";
import { hashPassword, verifyPassword } from "./passwords.ts";
import { authorizeUrl, configured, credsFromEnv, verifiedEmail } from "./providers.ts";

test("passwords: right one verifies, wrong one and missing hash don't", async () => {
  const h = await hashPassword("correct horse battery");
  assert.ok(await verifyPassword("correct horse battery", h));
  assert.ok(!(await verifyPassword("wrong", h)));
  assert.ok(!(await verifyPassword("anything", null)));
  assert.notEqual(h, await hashPassword("correct horse battery")); // salted
});

const env = { GITHUB_CLIENT_ID: "gid", GITHUB_CLIENT_SECRET: "gs", GOOGLE_CLIENT_ID: "only-id" };
test("providers: shown only when id and secret are both set", () => {
  assert.deepEqual(configured(credsFromEnv(env)), [{ id: "github", name: "GitHub" }]);
  assert.equal(authorizeUrl("google", credsFromEnv(env), "http://x/cb", "s"), undefined);
  const u = new URL(authorizeUrl("github", credsFromEnv(env), "http://x/cb", "st")!);
  assert.equal(u.searchParams.get("state"), "st");
  assert.equal(u.searchParams.get("client_id"), "gid");
});

const reply = (b: unknown) => new Response(JSON.stringify(b));
test("github: only a primary verified email counts", async () => {
  const f = (async (url: string) => String(url).includes("access_token") ? reply({ access_token: "t" })
    : reply([{ email: "a@x.com", primary: false, verified: true }, { email: "B@x.com", primary: true, verified: true }])) as unknown as typeof fetch;
  assert.equal(await verifiedEmail("github", credsFromEnv(env), "c", "r", f), "b@x.com");
  const unverified = (async (url: string) => String(url).includes("access_token") ? reply({ access_token: "t" }) : reply([{ email: "b@x.com", primary: true, verified: false }])) as unknown as typeof fetch;
  assert.equal(await verifiedEmail("github", credsFromEnv(env), "c", "r", unverified), undefined);
});

test("google: unverified email is rejected", async () => {
  const e = { ...env, GOOGLE_CLIENT_SECRET: "s" };
  const f = (verified: boolean) => (async (url: string) => String(url).includes("token") ? reply({ access_token: "t" }) : reply({ email: "G@x.com", email_verified: verified })) as unknown as typeof fetch;
  assert.equal(await verifiedEmail("google", credsFromEnv(e), "c", "r", f(true)), "g@x.com");
  assert.equal(await verifiedEmail("google", credsFromEnv(e), "c", "r", f(false)), undefined);
});
