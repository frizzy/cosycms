<script lang="ts">
  import { api } from "./api";
  import { toast } from "./toast.svelte";
  let status = $state<Awaited<ReturnType<typeof api.searchStatus>>>(), busy = $state(false), error = $state("");
  const load = () => api.searchStatus().then((s) => (status = s), (e) => (error = e.message));
  $effect(() => { load(); });
  async function rebuild() {
    busy = true; error = "";
    try { await api.rebuildSearch(); toast("Search index rebuilt"); await load(); } catch (e) { error = (e as Error).message; }
    busy = false;
  }
</script>

<section class="stack">
  <h2>Search</h2>
  <p class="muted">Search and "where is this used" read from an index that is updated on every save. If results ever look stale (after editing the data directly, say), rebuild it. It takes a few seconds.</p>
  {#if status}<p>{status.indexed} of {status.entries} entries searchable, {status.links} links between entries tracked.</p>{/if}
  <div><button type="button" class="ghost" onclick={rebuild} disabled={busy}>{busy ? "Rebuilding…" : "Rebuild the index"}</button></div>
  {#if error}<p class="error">{error}</p>{/if}
</section>
