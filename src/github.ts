import type { BlobStore } from "./blobs.ts";
import type { Change, Target } from "./targets.ts";

export type GithubOpts = { token: string; repo: string; branch?: string; dir?: string };

function client(o: GithubOpts, fetchFn: typeof fetch) {
  return async function gh<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    const res = await fetchFn(`https://api.github.com/repos/${o.repo}${path && "/" + path}`, {
      method,
      headers: {
        authorization: `Bearer ${o.token}`,
        accept: "application/vnd.github+json",
        "user-agent": "cosycms",
        "x-github-api-version": "2022-11-28",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw Object.assign(new Error(`GitHub ${method} ${path}: ${res.status} ${await res.text()}`), { status: res.status });
    return res.json() as Promise<T>;
  };
}

export type CiRun = { id: number; name: string; state: "running" | "success" | "failed"; url: string };
export type CiStatus = { state: "none" | "running" | "success" | "failed"; runs: CiRun[] };

/** What the site's GitHub Actions did for one commit. Matching by commit means other runs in progress never get mixed in. */
export async function githubRuns(o: GithubOpts, sha: string, fetchFn: typeof fetch = fetch): Promise<CiStatus> {
  const res = await client(o, fetchFn)<{ workflow_runs: { id: number; name: string | null; status: string; conclusion: string | null; html_url: string }[] }>(`actions/runs?head_sha=${sha}&per_page=20`);
  const runs = res.workflow_runs.map((r): CiRun => ({
    id: r.id, name: r.name ?? "Workflow", url: r.html_url,
    state: r.status !== "completed" ? "running" : ["success", "skipped", "neutral"].includes(r.conclusion ?? "") ? "success" : "failed",
  }));
  const state = !runs.length ? "none" : runs.some((r) => r.state === "failed") ? "failed" : runs.some((r) => r.state === "running") ? "running" : "success";
  return { state, runs };
}

/** Which job and step broke a run, e.g. "build › Build site", so a notification can say more than "failed". */
export async function githubFailedStep(o: GithubOpts, runId: number, fetchFn: typeof fetch = fetch): Promise<string | undefined> {
  const res = await client(o, fetchFn)<{ jobs: { name: string; conclusion: string | null; steps?: { name: string; conclusion: string | null }[] }[] }>(`actions/runs/${runId}/jobs`);
  const job = res.jobs.find((j) => j.conclusion === "failure"), step = job?.steps?.find((s) => s.conclusion === "failure");
  return job ? (step ? `${job.name} › ${step.name}` : job.name) : undefined;
}

export type AccessCheck = { name: string; ok: boolean; detail: string; optional?: boolean };

/** Tries what a deploy needs, one thing at a time, and says which permission is missing. The write test creates an unreferenced blob: nothing visible changes. */
export async function githubCheck(o: GithubOpts, fetchFn: typeof fetch = fetch): Promise<AccessCheck[]> {
  const gh = client(o, fetchFn), branch = o.branch || "main";
  const step = async (name: string, denied: string, run: () => Promise<unknown>, optional = false): Promise<AccessCheck> => {
    try { await run(); return { name, ok: true, detail: "OK", optional }; }
    catch (e) {
      const s = (e as { status?: number }).status;
      return { name, ok: false, optional, detail: s === 401 ? "GitHub doesn't accept this token (wrong, expired or revoked)." : s === 403 || s === 404 ? denied : (e as Error).message };
    }
  };
  const repo = await step("Repository", `Can't see ${o.repo}. Check the name, and that the token is granted this repository.`, () => gh(""));
  if (!repo.ok) return [repo];
  return [repo,
    await step("Branch", `Branch "${branch}" wasn't found. It has to exist before a deploy (create it first).`, () => gh(`git/ref/heads/${branch}`)),
    await step("Write access", "The token can't write. Give it Contents: read & write.", () => gh("git/blobs", "POST", { content: "cosycms access check", encoding: "utf-8" })),
    await step("Site build status", "Needs Actions: read. Only used to show the site build after a deploy.", () => gh("actions/runs?per_page=1"), true),
  ];
}

// Commits all changes in one commit via the Git Data API (no git binary needed, so it runs on Workers).
// shortcut: needs an existing branch (empty repos fail) and assumes deleted files exist; add handling when it bites.
export function githubTarget(o: GithubOpts, fetchFn: typeof fetch = fetch, blobs?: BlobStore): Target {
  const branch = o.branch ?? "main";
  const prefix = o.dir ? o.dir.replace(/\/?$/, "/") : "";
  const gh = client(o, fetchFn);

  // btoa on 32 KB slices: spreading a whole image into String.fromCharCode would overflow the stack.
  const base64 = (b: Uint8Array) => { let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); };

  // Images are uploaded as git blobs one at a time (keeps memory flat), then referenced by sha in the tree.
  async function entry(c: Change) {
    const path = prefix + c.path;
    if (c.type === "delete") return { path, mode: "100644", type: "blob", sha: null };
    if ("content" in c) return { path, mode: "100644", type: "blob", content: c.content };
    const obj = await blobs?.get(c.file);
    if (!obj) throw new Error(`The image for ${c.path} is missing from storage (${c.file})`);
    const bytes = new Uint8Array(await new Response(obj.body).arrayBuffer());
    const blob = await gh<{ sha: string }>("git/blobs", "POST", { content: base64(bytes), encoding: "base64" });
    return { path, mode: "100644", type: "blob", sha: blob.sha };
  }

  return {
    name: "github",
    async publish(changes) {
      const head = (await gh<{ object: { sha: string } }>(`git/ref/heads/${branch}`)).object.sha;
      const base = (await gh<{ tree: { sha: string } }>(`git/commits/${head}`)).tree.sha;
      const entries = [];
      for (const c of changes) entries.push(await entry(c));
      const tree = await gh<{ sha: string }>("git/trees", "POST", { base_tree: base, tree: entries });
      const commit = await gh<{ sha: string }>("git/commits", "POST", {
        message: `Publish ${changes.length} change${changes.length === 1 ? "" : "s"} from cosycms`,
        tree: tree.sha, parents: [head],
      });
      await gh(`git/refs/heads/${branch}`, "PATCH", { sha: commit.sha });
      return commit.sha;
    },
  };
}
