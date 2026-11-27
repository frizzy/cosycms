import { test } from "node:test";
import assert from "node:assert/strict";
import { testEnv } from "./testenv.ts";

// A dated collection with a title, and one entry in it.
async function setup() {
  const t = testEnv();
  const made = await t.call("POST", "/collections", { key: "posts", label: "Posts", dates: true, titleField: "title", slugSource: "title", fields: [{ key: "title", label: "Title", type: "text" }] });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const e = await t.call("POST", "/entries", { collection: "posts", slug: "hello", data: { title: "Hello" } });
  assert.equal(e.status, 201, JSON.stringify(e.body));
  return { ...t, id: e.body.id as string };
}
const hours = (n: number) => new Date(Date.now() + n * 3_600_000).toISOString();
const put = (c: Awaited<ReturnType<typeof setup>>, extra: Record<string, unknown>) => c.call("PUT", `/entries/${c.id}`, { collection: "posts", slug: "hello", data: { title: "Hello" }, ...extra });

test("a take-down must come after the go-live time", async () => {
  const c = await setup();
  const bad = await put(c, { publishAt: hours(5), unpublishAt: hours(2) });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /after the go-live/);
  assert.equal((await put(c, { publishAt: hours(2), unpublishAt: hours(5) })).status, 200);
});

test("a future take-down is scheduled and shown on the entry; a past one is not scheduled", async () => {
  const c = await setup();
  const ok = await put(c, { unpublishAt: hours(3) });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.takeDown?.at, "the entry reports its take-down");
  assert.equal((await c.call("GET", "/schedule")).body.filter((j: { kind: string }) => j.kind === "entry.unpublish").length, 1);
  await put(c, { unpublishAt: hours(-3) });
  assert.equal((await c.call("GET", "/schedule")).body.filter((j: { kind: string }) => j.kind === "entry.unpublish").length, 0);
});

test("the scheduler takes a published entry down at its time, logs it and clears the time", async () => {
  const c = await setup();
  assert.equal((await c.call("POST", `/entries/${c.id}/publish`)).status, 200);
  await put(c, { unpublishAt: hours(1) });
  const due = Date.now() - 1000; // the time arrives
  c.db.prepare("update schedule set runAt = ? where kind = 'entry.unpublish'").run(due);
  c.db.prepare("update entries set unpublishAt = ? where id = ?").run(due, c.id);
  await c.tick();
  const e = (await c.call("GET", `/entries/${c.id}`)).body;
  assert.equal(e.published, false);
  assert.equal(e.unpublishAt, null);
  const done = (await c.call("GET", "/activity?scheduled=1")).body.items;
  assert.ok(done.some((a: { action: string; detail: string }) => a.action === "entry.unpublish" && /scheduled/.test(a.detail)));
});

test("unpublishing clears a go-live time that has passed, and keeps one still ahead", async () => {
  const c = await setup();
  await c.call("POST", `/entries/${c.id}/publish`);
  c.db.prepare("update entries set publishAt = ? where id = ?").run(Date.now() - 86_400_000, c.id);
  assert.equal((await c.call("POST", `/entries/${c.id}/unpublish`)).body.publishAt, null);
  await put(c, { publishAt: hours(4) });
  assert.ok((await c.call("POST", `/entries/${c.id}/unpublish`)).body.publishAt);
});

test("members see scheduled entries but not the system's jobs", async () => {
  const c = await setup();
  await put(c, { publishAt: hours(2) });
  const mine = (await c.call("GET", "/schedule", undefined, c.member)).body as { kind: string }[];
  assert.ok(mine.length && mine.every((j) => j.kind.startsWith("entry.")));
});

test("select all matching returns every id the search and filter match", async () => {
  const c = await setup();
  for (const n of ["two", "three"]) await c.call("POST", "/entries", { collection: "posts", slug: n, data: { title: `Post ${n}` } });
  assert.equal((await c.call("GET", "/entries/matching?collection=posts")).body.ids.length, 3);
  const m = (await c.call("GET", "/entries/matching?collection=posts&q=three")).body;
  assert.deepEqual([m.ids.length, m.total], [1, 1]);
  assert.equal((await c.call("GET", "/entries/matching?collection=posts&filter=edited")).body.ids.length, 0);
  assert.equal((await c.call("GET", "/entries/matching?collection=nope")).status, 400);
});

test("the profile accepts a name and a preset picture, and nothing else", async () => {
  const c = await setup();
  const ok = await c.call("PUT", "/profile", { name: "  Sam  ", avatar: "cat" });
  assert.deepEqual([ok.status, ok.body.name, ok.body.avatar], [200, "Sam", "cat"]);
  assert.equal((await c.call("GET", "/session")).body.name, "Sam");
  assert.equal((await c.call("PUT", "/profile", { name: "x", avatar: "../../etc" })).status, 400);
  assert.equal((await c.call("PUT", "/profile", { name: "x".repeat(61), avatar: null })).status, 400);
  assert.equal((await c.call("PUT", "/profile", { name: "", avatar: null })).body.name, null);
});

test("media health flags weak alt text, unused images and large files", async () => {
  const t = testEnv();
  await t.call("POST", "/collections", { key: "media", label: "Media", titleField: "alt", fields: [{ key: "image", label: "Image", type: "file" }, { key: "alt", label: "Alt text", type: "text" }] });
  const upload = async (ch: string, size: number) => { // the server reads a file's real size from storage
    const key = `media/${ch.repeat(64)}.png`;
    await t.env.BLOBS.put(key, new Uint8Array(size), { httpMetadata: { contentType: "image/png" } });
    return { key, name: "kitchen.png", size, mime: "image/png", width: 800, height: 600 };
  };
  await t.call("POST", "/entries", { collection: "media", slug: "a", data: { image: await upload("a", 2_000_000), alt: "kitchen" } });
  await t.call("POST", "/entries", { collection: "media", slug: "b", data: { image: await upload("b", 10_000), alt: "A bright kitchen with an oak table" } });
  const h = (await t.call("GET", "/media-health")).body;
  assert.deepEqual([h.total, h.counts.weakAlt, h.counts.large, h.counts.unused], [2, 1, 1, 2]);
  assert.equal(h.weakAlt[0].why, "Same as the file name");
  assert.equal((await t.call("GET", "/media-health", undefined, t.member)).status, 403, "owners only");
});

const r2 = { type: "r2", accountId: "0123456789abcdef0123456789abcdef", bucket: "my-backups", accessKeyId: "AKIATESTKEY12345", secret: "it's a $secret; rm -rf /" };

test("the backup destination is validated, stored encrypted and never shown back", async () => {
  const c = testEnv();
  assert.equal((await c.call("PUT", "/backup/destination", { ...r2, bucket: "Bad Bucket" })).status, 400);
  assert.equal((await c.call("PUT", "/backup/destination", { type: "ssh", host: "-oProxyCommand=evil", user: "u", path: "/x" })).status, 400, "a host can't smuggle ssh options");
  assert.equal((await c.call("PUT", "/backup/destination", { ...r2, secret: undefined })).status, 400, "the first save needs the secret");
  const saved = await c.call("PUT", "/backup/destination", r2);
  assert.equal(saved.status, 200);
  assert.ok(saved.body.newPassword, "the repository password is shown once, when it is made");
  assert.deepEqual([saved.body.dest.hasSecret, "secret" in saved.body.dest && saved.body.dest.secret !== undefined], [true, false]);
  assert.doesNotMatch(JSON.stringify((await c.call("GET", "/backup/destination")).body), /rm -rf/, "the secret never comes back");
  const stored = (c.db.prepare("select value from settings where key = 'backup.dest'").get() as { value: string }).value;
  assert.doesNotMatch(stored, /rm -rf|AKIA|my-backups/, "stored sealed");
  const again = await c.call("PUT", "/backup/destination", { ...r2, secret: undefined, bucket: "other-bucket" }); // keeps the saved secret
  assert.equal(again.status, 200);
  assert.equal(again.body.newPassword, undefined, "no second password");
  assert.ok((await c.call("GET", "/backup/password")).body.password);
  assert.equal((await c.call("PUT", "/backup/destination", r2, c.member)).status, 403, "owners only");
});

test("the host asks for the destination as quoted shell assignments, and claims a queued test once", async () => {
  const c = testEnv();
  assert.equal((await c.script("GET", "/api/backup/job")).text, "COSY_DEST='none'\nCOSY_TEST='0'\n");
  await c.call("PUT", "/backup/destination", r2);
  const job = (await c.script("GET", "/api/backup/job")).text;
  assert.match(job, /COSY_DEST='r2'/);
  assert.match(job, /RESTIC_REPOSITORY='s3:https:\/\/0123456789abcdef0123456789abcdef\.r2\.cloudflarestorage\.com\/my-backups'/);
  assert.ok(job.includes(`AWS_SECRET_ACCESS_KEY='it'\\''s a $secret; rm -rf /'`), "quotes in a value can't break out of the shell string");
  assert.match(job, /COSY_TEST='0'/);
  await c.call("POST", "/backup/test");
  assert.match((await c.script("GET", "/api/backup/job")).text, /COSY_TEST='1'/);
  assert.match((await c.script("GET", "/api/backup/job")).text, /COSY_TEST='0'/, "a second ask doesn't run it again");
  assert.equal((await c.call("GET", "/backup/destination")).body.test.state, "running");
  await c.script("POST", "/api/backup/test-result", { ok: false, detail: "permission denied" });
  assert.deepEqual((await c.call("GET", "/backup/destination")).body.test.detail, "permission denied");
});

test("only the tick token reaches the host endpoints, and an ssh destination reports its key", async () => {
  const c = testEnv();
  const bare = await (await import("./index.ts")).default.fetch(new Request("http://localhost/api/backup/job"), c.env as never, {} as never);
  assert.equal(bare.status, 401);
  await c.call("PUT", "/backup/destination", { type: "ssh", host: "nas.local", port: 2222, user: "backup", path: "/srv/b" });
  assert.match((await c.script("GET", "/api/backup/job")).text, /RESTIC_REPOSITORY='sftp:backup@nas\.local:\/srv\/b'\nCOSY_SSH_PORT='2222'|COSY_SSH_PORT='2222'/);
  assert.equal((await c.script("POST", "/api/backup/pubkey", { key: "not a key" })).status, 400);
  assert.equal((await c.script("POST", "/api/backup/pubkey", { key: "ssh-ed25519 AAAAC3Nza cosycms-backup" })).status, 204);
  assert.equal((await c.call("GET", "/backup/destination")).body.pubkey, "ssh-ed25519 AAAAC3Nza cosycms-backup");
  assert.equal((await c.call("POST", "/backup/test")).body.test.state, "pending");
  await c.call("PUT", "/backup/destination", { type: "none" });
  assert.equal((await c.call("GET", "/backup/destination")).body.dest, null);
  assert.equal((await c.call("POST", "/backup/test")).status, 400, "nothing to test");
});
