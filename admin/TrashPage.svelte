<script lang="ts">
  import { api, type Trashed } from "./api";
  import { refreshCounts, store } from "./store.svelte";
  import { toast } from "./toast.svelte";
  import { ask } from "./confirm.svelte";
  let items = $state<Trashed[]>([]), days = $state(30), loading = $state(true), error = $state("");
  async function load() {
    try { const r = await api.trash(); items = r.items; days = r.days; } catch (e) { error = (e as Error).message; }
    loading = false;
  }
  $effect(() => { load(); });
  const colLabel = (k: string) => store.collections.find((c) => c.key === k)?.label ?? k;
  const when = (at: string) => new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  async function restore(t: Trashed) {
    if (!(await ask({ title: "Bring this entry back?", message: `“${t.label}” comes back as a draft in ${colLabel(t.collection)}.`, confirm: "Bring back" }))) return;
    try { await api.undo(t.id); toast("Restored"); await load(); refreshCounts(); } catch (e) { toast((e as Error).message, "error"); }
  }
</script>

<header><h1>Trash</h1></header>
<p class="muted">Deleted entries stay here for {days} day{days === 1 ? "" : "s"}, then they are gone for good. Restoring brings one back as a draft.</p>
{#if error}<p class="error">{error}</p>
{:else if loading}<p class="muted" aria-busy="true">Loading…</p>
{:else if !items.length}<p class="muted">Nothing deleted lately.</p>
{:else}
  <ol class="activity trash">
    {#each items as t (t.id)}
      <li>
        <time datetime={t.at}>{when(t.at)}</time>
        <span class="what"><strong>{t.label}</strong> <span class="muted">in {colLabel(t.collection)}, deleted by {t.actor}</span>
          <button type="button" class="ghost undo" onclick={() => restore(t)}>Restore</button></span>
      </li>
    {/each}
  </ol>
{/if}
