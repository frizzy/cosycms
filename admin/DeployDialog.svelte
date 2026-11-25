<script lang="ts">
  import { api } from "./api";
  import { toast } from "./toast.svelte";

  // Two steps. Build renders everything published (references resolved) and shows what would change, sending nothing.
  // Deploy then sends it; images go in batches, so it repeats until nothing is left, and the bar follows.
  type Built = Awaited<ReturnType<typeof api.build>>;
  let dlg: HTMLDialogElement;
  let stage = $state<"building" | "ready" | "deploying" | "done" | "failed">("building");
  let built = $state<Built>(), error = $state(""), sent = $state(0), warnings = $state<string[]>([]);
  const total = $derived(built ? built.pages + built.images + built.removed : 0);
  const portal = (node: HTMLElement) => { document.body.appendChild(node); return { destroy: () => node.remove() }; };
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

  export function open() { dlg.showModal(); runBuild(); }
  async function runBuild() {
    stage = "building"; error = ""; built = undefined; sent = 0;
    try { built = await api.build(); stage = built.error ? "failed" : "ready"; error = built.error ?? ""; }
    catch (e) { error = (e as Error).message; stage = "failed"; }
  }
  async function send() {
    stage = "deploying"; error = ""; sent = 0; warnings = [];
    try {
      for (;;) {
        const r = await api.publish();
        sent += r.changed; warnings = r.warnings ?? warnings;
        if (!r.remaining || !r.changed) break; // nothing left, or no progress (don't loop forever)
      }
      stage = "done";
      toast(`Deployed ${plural(sent, "change")}`);
    } catch (e) { error = (e as Error).message; stage = "failed"; }
  }
  const label = { page: "page", image: "image", delete: "removed" } as const;
</script>

<dialog bind:this={dlg} use:portal aria-labelledby="dp-title">
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
  .steps li.ok strong::after { content:" ✓"; color:var(--ok); }
  progress { width:100%; height:.6rem; accent-color:var(--accent); }
  .paths { max-height:12rem; overflow:auto; margin:.5rem 0 0; padding-left:1.1rem; font-size:.85rem; overflow-wrap:anywhere; }
</style>
