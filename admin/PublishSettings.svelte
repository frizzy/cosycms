<script lang="ts">
  import { api } from "./api";
  import { toast } from "./toast.svelte";
  import { saveShortcut } from "./keys";
  import { refreshCollections } from "./store.svelte";
  let repo = $state(""), branch = $state(""), dir = $state(""), token = $state(""), previewBranch = $state(""), previewDir = $state("");
  let hasToken = $state(false), tokenError = $state(""), loading = $state(true), error = $state("");
  let checks = $state<Awaited<ReturnType<typeof api.checkAccess>>["checks"]>(), checking = $state(false);

  const load = () => api.settings().then((s) => {
    ({ repo = "", branch = "", dir = "", previewBranch = "", previewDir = "", hasToken, tokenError = "" } = s); token = ""; loading = false;
  }, (e) => { error = e.message; loading = false; });
  $effect(() => { load(); });

  let siteUrl = $state(""), previewUrl = $state("");
  $effect(() => { api.siteUrl().then((r) => { siteUrl = r.url; previewUrl = r.previewUrl; }, () => {}); });
  async function saveSite(ev: SubmitEvent) {
    ev.preventDefault(); error = "";
    try { await api.saveSiteUrl(siteUrl.trim(), previewUrl.trim()); await refreshCollections(); toast("Saved"); }
    catch (e) { error = (e as Error).message; }
  }

  // Tests what is in the form, saved or not (a blank token means the saved one).
  async function check() {
    checking = true; error = ""; checks = undefined;
    try { checks = (await api.checkAccess({ repo, branch, token: token || undefined })).checks; }
    catch (e) { error = (e as Error).message; }
    checking = false;
  }
  async function save(ev: SubmitEvent) {
    ev.preventDefault(); error = "";
    try { await api.saveSettings({ repo, branch, dir, previewBranch: previewBranch.trim(), previewDir: previewDir.trim(), token: token || undefined }); toast("Saved"); await load(); await refreshCollections(); }
    catch (e) { error = (e as Error).message; }
  }
</script>

{#if loading}<p class="muted">Loading…</p>
{:else}
  <form onsubmit={saveSite} use:saveShortcut>
    <h2>Your site</h2>
    <label>Site address <input type="url" bind:value={siteUrl} placeholder="https://example.com" />
      <small class="muted">Used for "View on site" on published entries, together with each collection's page address.</small>
    </label>
    <label>Preview site address <input type="url" bind:value={previewUrl} placeholder="https://preview.example.com" />
      <small class="muted">Where the preview branch is built, for "View on preview". Only needed if you use a preview branch.</small>
    </label>
    <div class="actions"><button type="submit">Save</button></div>
  </form>
  <form onsubmit={save} use:saveShortcut>
    <h2>GitHub deploy target</h2>
    <label>Repository <input bind:value={repo} placeholder="owner/name" /></label>
    <label>Branch <input bind:value={branch} placeholder="main" /></label>
    <label>Folder <input bind:value={dir} placeholder="content (optional)" /></label>
    <label>Preview branch <input bind:value={previewBranch} placeholder="empty = no preview" />
      <small class="muted">A second branch of this repository for checking before you publish live. It gets what is published plus what is scheduled, and is created from the branch above the first time. Leave empty if production is handled elsewhere.</small>
    </label>
    {#if previewBranch.trim()}<label>Preview folder <input bind:value={previewDir} placeholder="same as the folder above" /></label>{/if}
    <label>Access token
      <input type="password" bind:value={token} autocomplete="off"
        placeholder={hasToken ? "•••••••• saved — leave blank to keep" : "github_pat_…"} />
      <small class="muted">Needs Contents: read &amp; write on the repo, and Actions: read to show the site build after a deploy. Stored encrypted and never shown again.</small>
      {#if tokenError}<small class="error">{tokenError}</small>{/if}
    </label>
    <div class="actions">
      <button type="submit">Save</button>
      <button type="button" class="ghost" onclick={check} disabled={checking}>{checking ? "Checking…" : "Check access"}</button>
      <span class="status">{#if error}<span class="error">{error}</span>{/if}</span>
    </div>
    {#if checks}
      <ul class="checks" aria-live="polite">
        {#each checks as c}
          <li><span class={c.ok ? "ok" : c.optional ? "muted" : "error"} aria-hidden="true">{c.ok ? "✓" : c.optional ? "!" : "✗"}</span> <strong>{c.name}</strong>{#if !c.ok} <span class="muted">{c.detail}</span>{/if}</li>
        {/each}
      </ul>
    {/if}
  </form>
{/if}

<style>
  .checks { list-style:none; margin:1rem 0 0; padding:0; display:grid; gap:.4rem; }
</style>
