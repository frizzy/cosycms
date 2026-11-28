<script lang="ts">
  import { api, type LinkProblem } from "./api";

  // Links between entries that don't work: the target is gone, or (on the live site) it isn't published.
  let rows = $state<LinkProblem[]>(), loading = $state(true), error = $state("");
  async function load() {
    loading = true; error = "";
    try { rows = await api.linkCheck(); } catch (e) { error = (e as Error).message; }
    loading = false;
  }
  $effect(() => { load(); });
</script>

<header><h1>Broken links</h1><button type="button" class="ghost" onclick={load} disabled={loading}>{loading ? "Checking…" : "Check again"}</button></header>
{#if error}<p class="error">{error}</p>{/if}
{#if loading && !rows}<div class="stack" aria-busy="true" aria-label="Loading"><div class="skel" style="height:44px"></div><div class="skel" style="height:44px"></div></div>
{:else if rows}
  <p class="muted">Links to other entries, in text and reference fields. Web addresses to other sites aren't checked.</p>
  {#if !rows.length}<p class="notice">No broken links.</p>
  {:else}
    <ul class="lc">
      {#each rows as r (r.id + r.target)}
        <li>
          <a href="#/{r.collection}/{r.id}">{r.label}</a>
          <span class="muted">{r.kind === "missing" ? "links to an entry that was deleted" : `links to “${r.targetLabel}”, which isn't published`}{r.where === "live" ? " · on the live site" : " · in the draft"}</span>
        </li>
      {/each}
    </ul>
  {/if}
{/if}
