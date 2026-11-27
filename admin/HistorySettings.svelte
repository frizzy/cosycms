<script lang="ts">
  import { api } from "./api";
  import { toast } from "./toast.svelte";
  let keep = $state(20), trashDays = $state(30), loaded = $state(false), error = $state("");
  $effect(() => { api.historySettings().then((s) => { keep = s.keep; trashDays = s.trashDays; loaded = true; }, (e) => (error = e.message)); });
  async function save() {
    error = "";
    try { await api.saveHistorySettings({ keep, trashDays }); toast("Saved"); } catch (e) { error = (e as Error).message; }
  }
</script>

<section class="stack">
  <h2>History</h2>
  <p class="muted">Every save keeps a copy of the draft as it was, so a change can be undone or compared first. Older copies are dropped past these limits; the Activity list itself stays.</p>
  <label>Versions kept per entry<input type="number" min="1" max="500" bind:value={keep} disabled={!loaded} /></label>
  <label>Days a deleted entry stays in the trash<input type="number" min="0" max="3650" bind:value={trashDays} disabled={!loaded} /></label>
  <p class="muted">Lowering a limit removes the copies beyond it right away.</p>
  {#if error}<p class="error">{error}</p>{/if}
  <div><button type="button" onclick={save} disabled={!loaded}>Save</button></div>
</section>
