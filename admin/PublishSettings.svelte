<script lang="ts">
  import { api } from "./api";
  import { toast } from "./toast.svelte";
  import { saveShortcut } from "./keys";
  let repo = $state(""), branch = $state(""), dir = $state(""), token = $state("");
  let hasToken = $state(false), tokenError = $state(""), loading = $state(true), error = $state("");

  const load = () => api.settings().then((s) => {
    ({ repo = "", branch = "", dir = "", hasToken, tokenError = "" } = s); token = ""; loading = false;
  }, (e) => { error = e.message; loading = false; });
  $effect(() => { load(); });

  async function save(ev: SubmitEvent) {
    ev.preventDefault(); error = "";
    try { await api.saveSettings({ repo, branch, dir, token: token || undefined }); toast("Saved"); await load(); }
    catch (e) { error = (e as Error).message; }
  }
</script>

{#if loading}<p class="muted">Loading…</p>
{:else}
  <form onsubmit={save} use:saveShortcut>
    <h2>GitHub deploy target</h2>
    <label>Repository <input bind:value={repo} placeholder="owner/name" /></label>
    <label>Branch <input bind:value={branch} placeholder="main" /></label>
    <label>Folder <input bind:value={dir} placeholder="content (optional)" /></label>
    <label>Access token
      <input type="password" bind:value={token} autocomplete="off"
        placeholder={hasToken ? "•••••••• saved — leave blank to keep" : "github_pat_…"} />
      <small class="muted">Needs Contents: read &amp; write on the repo, and Actions: read to show the site build after a deploy. Stored encrypted and never shown again.</small>
      {#if tokenError}<small class="error">{tokenError}</small>{/if}
    </label>
    <div class="actions">
      <button type="submit">Save</button>
      <span class="status">{#if error}<span class="error">{error}</span>{/if}</span>
    </div>
  </form>
{/if}
