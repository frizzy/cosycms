<script lang="ts">
  import { api } from "./api";
  import { toast } from "./toast.svelte";

  // Two steps. Build renders everything published (references resolved) and shows what would change, sending nothing.
  // Deploy then sends it; images go in batches, so it repeats until nothing is left, and the bar follows.
  type Built = Awaited<ReturnType<typeof api.build>>;
  let dlg: HTMLDialogElement;
  let stage = $state<"building" | "ready" | "deploying" | "done" | "failed">("building");
  let built = $state<Built>(), error = $state(""), sent = $state(0), warnings = $state<string[]>([]);
  // Step 3 watches the site's CI for the last commit we pushed, only while this dialog is open.
  type Ci = Awaited<ReturnType<typeof api.ci>>;
  let ci = $state<Ci>(), ciError = $state(""), ciWatch = $state(false), watchId = 0;
  const total = $derived(built ? built.pages + built.images + built.removed : 0);
  const portal = (node: HTMLElement) => { document.body.appendChild(node); return { destroy: () => node.remove() }; };
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

  export function open() { dlg.showModal(); runBuild(); }
  const POLL_MS = 4000, WAIT_FOR_RUN = 8, GIVE_UP = 150; // a run appears a few seconds after the push; stop after ~10 minutes
  async function watch(sha: string) {
    const me = ++watchId; ci = undefined; ciError = ""; ciWatch = true;
    for (let i = 0; i < GIVE_UP && me === watchId; i++) {
      try {
        ci = await api.ci(sha);
        if (ci.state === "success" || ci.state === "failed" || (ci.state === "none" && i >= WAIT_FOR_RUN)) break;
      } catch (e) { ciError = (e as Error).message; break; }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    if (me === watchId) ciWatch = false;
  }
  async function runBuild() {
    stage = "building"; error = ""; built = undefined; sent = 0;
    try { built = await api.build(); stage = built.error ? "failed" : "ready"; error = built.error ?? ""; }
    catch (e) { error = (e as Error).message; stage = "failed"; }
  }
  async function send() {
    stage = "deploying"; error = ""; sent = 0; warnings = []; watchId++; ci = undefined; ciError = ""; ciWatch = false;
    let sha = "";
    try {
      for (;;) {
        const r = await api.publish();
        sent += r.changed; warnings = r.warnings ?? warnings; sha = r.ref ?? sha;
        if (!r.remaining || !r.changed) break; // nothing left, or no progress (don't loop forever)
      }
      stage = "done";
      toast(`Deployed ${plural(sent, "change")}`);
      if (sha) watch(sha);
    } catch (e) { error = (e as Error).message; stage = "failed"; }
  }
  const label = { page: "page", image: "image", delete: "removed" } as const;
</script>

<dialog bind:this={dlg} use:portal aria-labelledby="dp-title" onclose={() => { watchId++; ciWatch = false; }}>
  <header><h1 id="dp-title">Deploy</h1><button type="button" class="icon-btn close" aria-label="Close" disabled={stage === "deploying"} onclick={() => dlg.close()}>×</button></header>

  <ol class="steps">
    <li class:on={stage === "building"} class:ok={stage !== "building" && !!built}>
      <strong>1. Build</strong>
      <span class="muted">{#if stage === "building"}Rendering everything that's published…{:else if built}{total ? `${plural(built.pages, "page")}, ${plural(built.images, "image")}, ${built.removed} removed` : "Nothing has changed since the last deploy."}{/if}</span>
    </li>
    <li class:on={stage === "deploying"} class:ok={stage === "done"}>
      <strong>2. Deploy</strong>
      <span class="muted">{#if stage === "deploying"}Sent {sent} of {total}{:else if stage === "done"}Sent {plural(sent, "change")}{:else}Waiting{/if}</span>
      {#if stage === "deploying" || stage === "done"}<progress max={total || 1} value={stage === "done" ? total || 1 : sent}></progress>{/if}
    </li>
    {#if stage === "done" && (ciWatch || ci || ciError)}
      <li class:on={ciWatch} class:ok={ci?.state === "success"} class:bad={ci?.state === "failed"}>
        <strong>3. Site build</strong>
        <span class="muted">
          {#if ciError}{ciError}
          {:else if !ci || ci.state === "none"}{ciWatch ? "Waiting for the build to start…" : "No GitHub workflow ran for this commit."}
          {:else if ci.state === "running"}Building…
          {:else if ci.state === "success"}Built
          {:else}Failed{/if}
        </span>
        {#if ciWatch && ci?.state !== "success" && ci?.state !== "failed"}<progress></progress>{/if}
        {#if ci?.runs.length}<span class="runs">{#each ci.runs as r}<a href={r.url} target="_blank" rel="noopener">{r.name}{r.state === "running" ? " …" : r.state === "failed" ? " (failed)" : ""}</a>{/each}</span>{/if}
      </li>
    {/if}
  </ol>

  {#if error}<p class="error">{error}</p>{/if}
  {#each [...(built?.warnings ?? []), ...(stage === "done" ? warnings.filter((w) => !built?.warnings.includes(w)) : [])] as w}<p class="notice">{w}</p>{/each}

  {#if built?.paths.length && (stage === "ready" || stage === "failed")}
    <details>
      <summary>What will be sent</summary>
      <ul class="paths">{#each built.paths as p}<li><span class="muted">{label[p.type]}</span> {p.path}</li>{/each}{#if built.more}<li class="muted">and {built.more} more</li>{/if}</ul>
    </details>
  {/if}

  <div class="dialog-actions">
    <span>
      {#if stage === "ready" && total}<button type="button" onclick={send}>Deploy {plural(total, "change")}</button>{/if}
      {#if stage === "done" || (stage === "ready" && !total)}<button type="button" onclick={() => dlg.close()}>Close</button>{/if}
      {#if stage === "ready" || stage === "failed"} <button type="button" class="ghost" onclick={runBuild}>Build again</button>{/if}
      {#if stage === "failed" && built && !built.error}<button type="button" onclick={send}>Try again</button>{/if}
    </span>
  </div>
</dialog>

<style>
  .steps { list-style:none; margin:0 0 1rem; padding:0; display:grid; gap:.9rem; }
  .steps li { display:grid; gap:.3rem; opacity:.6; } .steps li.on, .steps li.ok { opacity:1; }
  .steps li.bad { opacity:1; } .steps li.bad strong::after { content:" ✗"; color:var(--danger); }
  .runs { display:flex; flex-wrap:wrap; gap:.3rem 1rem; font-size:.85rem; }
  .steps li.ok strong::after { content:" ✓"; color:var(--ok); }
  progress { width:100%; height:.6rem; accent-color:var(--accent); }
  .paths { max-height:12rem; overflow:auto; margin:.5rem 0 0; padding-left:1.1rem; font-size:.85rem; overflow-wrap:anywhere; }
</style>
