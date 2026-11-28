<script lang="ts">
  import { api, type ContentToken } from "./api";
  import { toast } from "./toast.svelte";
  import { ask } from "./confirm.svelte";
  import { store } from "./store.svelte";

  // Lets a site pull its content from here instead of (or as well as) receiving commits. A token is shown once, when it is made.
  let tokens = $state<ContentToken[]>([]), error = $state(""), label = $state(""), channel = $state<"live" | "preview">("preview"), made = $state("");
  const load = () => api.contentTokens().then((t) => (tokens = t), (e) => (error = e.message));
  $effect(() => { load(); });
  async function create(ev: SubmitEvent) {
    ev.preventDefault(); error = "";
    try { made = (await api.createContentToken(label.trim(), channel)).secret; label = ""; await load(); } catch (e) { error = (e as Error).message; }
  }
  async function revoke(t: ContentToken) {
    if (!(await ask({ title: `Revoke "${t.label}"?`, message: "Anything using it stops getting content.", confirm: "Revoke", danger: true }))) return;
    try { await api.revokeContentToken(t.id); toast("Revoked"); await load(); } catch (e) { error = (e as Error).message; }
  }
  const copy = (s: string) => navigator.clipboard.writeText(s).then(() => toast("Copied"), () => {});
  const sample = $derived(`curl -H "Authorization: Bearer ${made || "cosy_c_…"}" ${location.origin}/api/content`);
</script>

<section class="stack">
  <p class="muted">A read-only way for your site to fetch its content. A <strong>live</strong> token gets what a live deploy would send; a <strong>preview</strong> token gets that plus entries scheduled for later (marked <code>scheduledFor</code>). It needs no branch.{#if store.preview} You also have a preview branch set up; this is an alternative to it.{/if}</p>
  <form onsubmit={create} class="inline">
    <input bind:value={label} placeholder="Name, like “Preview site build”" aria-label="Name" required style="flex:1;min-width:14rem" />
    <select bind:value={channel} aria-label="Channel" style="width:auto"><option value="preview">Preview</option><option value="live">Live</option></select>
    <button type="submit" style="white-space:nowrap">Create token</button>
  </form>
  {#if made}
    <p class="notice">Copy this now, it isn't shown again.<br /><code>{made}</code> <button type="button" class="ghost" onclick={() => copy(made)}>Copy</button></p>
  {/if}
  {#if error}<p class="error">{error}</p>{/if}
  {#each tokens as t (t.id)}
    <div class="inline">
      <span style="flex:1"><strong>{t.label}</strong> <small class="muted">{t.channel === "live" ? "Live" : "Preview"}, made {new Date(t.at).toLocaleDateString()}</small></span>
      <button type="button" class="danger" onclick={() => revoke(t)}>Revoke</button>
    </div>
  {/each}
  <h2>Using it</h2>
  <p class="muted">The response lists every file with its text, and images with a download address that needs the same token. Add <code>?prefix=posts/</code> to fetch one folder.</p>
  <pre class="sample">{sample}</pre>
</section>

<style>
  .sample { overflow:auto; padding:.7rem .9rem; border:1px solid var(--line); border-radius:6px; font-size:.85rem; margin:0; }
  code { overflow-wrap:anywhere; }
</style>
