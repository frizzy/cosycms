#!/usr/bin/env node
// Deploys cosyCMS: first-time setup and updates, for a person (prompts) or an agent (flags, --yes, --json).
//   node scripts/deploy.mjs                      ask everything
//   node scripts/deploy.mjs --check ...          only look: change nothing, report what is missing
//   --target docker      a Docker host over SSH (or --host local). Pulls the repo, keeps SETTINGS_KEY, runs compose.
//   --target cloudflare  a Worker environment from wrangler.jsonc (--env <name>): checks D1/R2, secrets, migrates, deploys.
// Common: --yes (never prompt), --json (result as JSON on stdout, progress on stderr), --settings-key, --setup-token.
// Docker:  --host user@server  --dir ~/Server/cosycms  --repo <git url>  --branch main  --url https://public.example
// A secret that already exists is never replaced: SETTINGS_KEY encrypts the stored GitHub token, so changing it loses it.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const BOOL = new Set(["yes", "json", "check", "help"]);
const PORT = 8787; // matches compose.yaml

export function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const [k, v] = argv[i].replace(/^--/, "").split(/=(.*)/s);
    o[k] = BOOL.has(k) ? true : (v ?? argv[++i]);
  }
  return o;
}

/** Fills in KEY=value lines that are missing or empty; a value that is already there is kept. */
export function mergeEnv(text, want) {
  const have = new Map(text.split("\n").map((l) => l.match(/^([A-Z_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]]));
  const added = Object.keys(want).filter((k) => !have.get(k));
  const lines = text.split("\n").filter((l) => !added.some((k) => l.startsWith(k + "=")) && l !== "");
  return { text: [...lines, ...added.map((k) => `${k}=${want[k]}`)].join("\n") + "\n", added };
}

const secret = () => randomBytes(32).toString("base64url");

// ---- running things -----------------------------------------------------------------------------------------------------
const say = (m) => console.error(m);
/** Runs a shell script on the host over SSH (or here for "local"); the script goes in on stdin, so there is no quoting to get wrong. */
const sh = (host, script) => spawnSync(...(host === "local" ? ["sh", ["-s"]] : ["ssh", ["-o", "BatchMode=yes", host, "sh", "-s"]]), { input: script, encoding: "utf8" });
const wr = (args, input) => spawnSync("node_modules/.bin/wrangler", args, { input, encoding: "utf8" });
const out = (r) => `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();

// ---- Docker target ------------------------------------------------------------------------------------------------------
async function docker(o, report) {
  const dir = (o.dir ?? "~/Server/cosycms").replace(/^~/, "$HOME");
  const D = `"${dir}"`;
  const probe = sh(o.host, `command -v docker >/dev/null && docker compose version >/dev/null 2>&1 && echo docker=ok || echo docker=missing
command -v git >/dev/null && echo git=ok || echo git=missing
command -v openssl >/dev/null && echo openssl=ok || echo openssl=missing
[ -d ${D}/.git ] && echo checkout=git || { [ -d ${D} ] && echo checkout=plain || echo checkout=none; }
[ -s ${D}/.dev.vars ] && echo env=present || echo env=none`);
  if (probe.status !== 0) { report.error = `Can't reach ${o.host}: ${out(probe)}`; return; }
  const found = Object.fromEntries(probe.stdout.trim().split("\n").map((l) => l.split("=")));
  report.checks = found;
  const missing = ["docker", "git", "openssl"].filter((k) => found[k] !== "ok");
  if (missing.length) { report.error = `Missing on the host: ${missing.join(", ")}`; return; }
  report.mode = found.checkout === "git" ? "update" : found.checkout === "plain" ? "adopt existing folder" : "first install";
  if (o.check) return;

  // 1. Code: clone, adopt a copied folder (data, certs and .dev.vars are untracked and survive), or fast-forward.
  say(`Fetching ${o.repo} (${o.branch})…`);
  const git = sh(o.host, `set -e; mkdir -p ${D}; cd ${D}
[ -d .git ] || { git init -q -b ${o.branch}; git remote add origin '${o.repo}'; }
git fetch -q origin ${o.branch} && git reset -q --hard FETCH_HEAD && git log -1 --format=%h
mkdir -p data certs`);
  if (git.status !== 0) { report.error = `git failed: ${out(git)}`; return; }
  report.commit = git.stdout.trim();

  // 2. Secrets in .dev.vars: only what is missing is added.
  const cur = sh(o.host, `cat ${D}/.dev.vars 2>/dev/null || true`).stdout;
  const fresh = !/^SETTINGS_KEY=./m.test(cur);
  const { text, added } = mergeEnv(cur, { SETTINGS_KEY: o.settingsKey ?? secret(), TICK_TOKEN: secret(), ...(o.setupToken || fresh ? { SETUP_TOKEN: o.setupToken ?? secret() } : {}) });
  if (added.length) {
    const w = sh(o.host, `echo ${Buffer.from(text).toString("base64")} | base64 -d > ${D}/.dev.vars && chmod 600 ${D}/.dev.vars`);
    if (w.status !== 0) { report.error = `Writing .dev.vars failed: ${out(w)}`; return; }
    report.created = added;
    if (added.includes("SETUP_TOKEN")) report.setupToken = text.match(/^SETUP_TOKEN=(.*)$/m)[1]; // shown once: it creates the owner account on a public address
  }

  // The scheduler (scheduled publishing) needs something to call it every minute; a Docker host has no cron trigger, so use the host's cron.
  const cron = sh(o.host, `chmod +x ${D}/scripts/tick.sh; (crontab -l 2>/dev/null | grep -v 'scripts/tick.sh'; echo "* * * * * ${dir}/scripts/tick.sh >/dev/null 2>&1") | crontab -`);
  report.scheduler = cron.status === 0 ? "cron installed" : `could not install the cron job: ${out(cron)}`;

  // 3. Self-signed certificate for the local HTTPS the Worker needs (see Dockerfile), then build and start.
  say("Building and starting (the first build takes a few minutes)…");
  const up = sh(o.host, `set -e; cd ${D}
[ -f certs/cert.pem ] || openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj /CN=localhost -addext subjectAltName=DNS:localhost,IP:127.0.0.1 -keyout certs/key.pem -out certs/cert.pem 2>/dev/null
chmod 644 certs/*.pem
docker compose up -d --build 2>&1 | tail -3
for i in $(seq 1 60); do curl -sk https://localhost:${PORT}/api/auth && exit 0; sleep 2; done; exit 1`);
  if (up.status !== 0) { report.error = `It did not come up: ${out(up)}. See: ssh ${o.host} 'cd ${dir} && docker compose logs --tail 40'`; return; }
  try { report.needsSetup = JSON.parse(up.stdout.slice(up.stdout.indexOf("{"))).needsSetup; } catch { /* the app answered, which is what counts */ }
  report.ok = true;

  if (o.url) { // the tunnel is yours to set up; this only tells you whether it works
    const r = await fetch(o.url).catch((e) => ({ status: 0, why: e.message }));
    report.url = { status: r.status, hint: r.status === 502 ? "Tunnel can't verify the app's self-signed certificate: turn on No TLS Verify for the route." : r.status === 200 ? "ok" : r.why ?? "unexpected status" };
  }
}

// ---- Cloudflare target --------------------------------------------------------------------------------------------------
async function cloudflare(o, report) {
  const cfg = JSON.parse(readFileSync("wrangler.jsonc", "utf8").replace(/^\s*\/\/.*$/gm, "")); // shortcut: only whole-line comments are stripped
  const env = cfg.env?.[o.env];
  if (!env) { report.error = `No environment "${o.env}" in wrangler.jsonc (has: ${Object.keys(cfg.env ?? {}).join(", ") || "none"}). Add one first.`; return; }
  const db = env.d1_databases[0], bucket = env.r2_buckets[0].bucket_name;
  const checks = (report.checks = {});

  const who = out(wr(["whoami"]));
  checks.login = /not authenticated/i.test(who) ? "no: run `wrangler login` or set CLOUDFLARE_API_TOKEN" : "ok";
  if (checks.login !== "ok") { report.error = "Not signed in to Cloudflare."; return; }
  const dbs = wr(["d1", "list", "--json"]);
  let dbRow; try { dbRow = JSON.parse(dbs.stdout).find((d) => d.name === db.database_name); } catch { /* unreadable: reported below */ }
  checks.d1 = dbs.status !== 0 ? `unavailable: ${out(dbs).slice(0, 200)}` : dbRow ? (dbRow.uuid === db.database_id ? "ok" : `exists with a different id: put ${dbRow.uuid} in wrangler.jsonc`) : "database missing";
  const r2 = wr(["r2", "bucket", "list"]);
  checks.r2 = r2.status !== 0 ? `unavailable (enable R2 in the dashboard first): ${out(r2).slice(0, 200)}` : out(r2).includes(bucket) ? "ok" : "bucket missing";
  const sec = wr(["secret", "list", "--env", o.env, "--format", "json"]);
  const have = (() => { try { return JSON.parse(sec.stdout).map((s) => s.name); } catch { return []; } })();
  checks.secrets = ["SETTINGS_KEY", "SETUP_TOKEN"].filter((k) => !have.includes(k)).join(", ") || "ok";
  if (/unavailable|different id/.test(checks.d1 + checks.r2)) { report.error = "A Cloudflare service isn't ready; see checks."; return; }
  report.mode = have.includes("SETTINGS_KEY") ? "update" : "first install";
  if (o.check) return;

  const step = (label, r) => { say(label); if (r.status !== 0) { report.error = `${label} failed: ${out(r).slice(-400)}`; return false; } return true; };
  if (checks.d1 === "database missing") {
    const r = wr(["d1", "create", db.database_name]);
    report.error = r.status === 0 ? `Created the database. Put its id in wrangler.jsonc, then run this again:\n${out(r)}` : `D1 create failed: ${out(r)}`; return;
  }
  if (checks.r2 === "bucket missing" && !step(`Creating bucket ${bucket}`, wr(["r2", "bucket", "create", bucket]))) return;
  for (const k of ["SETTINGS_KEY", "SETUP_TOKEN"]) {
    if (have.includes(k)) continue;
    const v = (k === "SETTINGS_KEY" ? o.settingsKey : o.setupToken) ?? secret();
    if (!step(`Setting ${k}`, wr(["secret", "put", k, "--env", o.env], v))) return;
    if (k === "SETUP_TOKEN") report.setupToken = v;
  }
  if (!step("Building the admin", spawnSync("node_modules/.bin/vite", ["build"], { encoding: "utf8" }))) return;
  if (!step("Applying migrations", wr(["d1", "migrations", "apply", db.database_name, "--env", o.env, "--remote"], "y\n"))) return;
  const dep = wr(["deploy", "--env", o.env]);
  if (!step("Deploying", dep)) return;
  report.ok = true;
  report.deployedAt = out(dep).match(/https:\/\/\S+/g)?.pop();
}

// ---- main ---------------------------------------------------------------------------------------------------------------
async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) return console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n"));
  const interactive = process.stdin.isTTY && !o.yes && !o.json;
  const rl = interactive ? createInterface({ input: process.stdin, output: process.stderr }) : null;
  const ask = async (key, question, def, options) => {
    if (o[key] !== undefined) return;
    if (rl) { o[key] = (await rl.question(`${question}${options ? ` (${options.join("/")})` : ""}${def ? ` [${def}]` : ""}: `)).trim() || def; }
    else o[key] = def;
  };
  await ask("target", "Where are you deploying", undefined, ["docker", "cloudflare"]);
  const report = { target: o.target };
  const fail = (m) => { report.error = m; };
  if (o.target === "docker") {
    await ask("host", "SSH host (user@host, or local)", undefined);
    await ask("dir", "Folder on that host", "~/Server/cosycms");
    await ask("branch", "Branch to deploy", "main");
    await ask("repo", "Git URL of the repo", spawnSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" }).stdout.trim() || undefined);
    await ask("url", "Public URL to check afterwards (blank to skip)", "");
    for (const k of ["host", "repo"]) if (!o[k]) fail(`--${k} is required`);
    o.branch ??= "main";
  } else if (o.target === "cloudflare") {
    await ask("env", "Wrangler environment", undefined);
    if (!o.env) fail("--env is required");
  } else fail("--target must be docker or cloudflare");
  rl?.close();

  if (!report.error) await (o.target === "docker" ? docker : cloudflare)(o, report);

  if (o.json) console.log(JSON.stringify(report, null, 2));
  else {
    for (const [k, v] of Object.entries(report)) console.log(`${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`);
    if (report.setupToken) console.log("\nKeep the setupToken: it is needed once, to create the first owner on a public address.");
  }
  process.exitCode = report.error ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
