<script lang="ts">
  import { api } from "./api";
  import { toast } from "./toast.svelte";
  let success = $state(false), loaded = $state(false), error = $state("");
  $effect(() => { api.notifySettings().then((s) => { success = s.success; loaded = true; }, (e) => (error = e.message)); });
  async function save(on: boolean) {
    error = "";
    try { await api.saveNotifySettings(on); success = on; toast("Saved"); } catch (e) { error = (e as Error).message; }
  }
</script>

<section class="stack">
  <h2>Notifications</h2>
  <p class="muted">Failures always show up in the Notifications list: a site build that failed, or a scheduled publish that gave up.</p>
  <label class="check"><input type="checkbox" checked={success} disabled={!loaded} onchange={(e) => save(e.currentTarget.checked)} />Also notify me when a site build passes</label>
  {#if error}<p class="error">{error}</p>{/if}
</section>
