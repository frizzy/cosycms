<script lang="ts">
  import { api, type MediaHealth } from "./api";
  import { blobUrl } from "../src/images";
  import { toast } from "./toast.svelte";
  import { refreshCounts } from "./store.svelte";

  // Checks every image library for images nothing uses, files that are bigger than a web page needs, and alt text that says nothing.
  let health = $state<MediaHealth>(), loading = $state(true), error = $state("");
  let draft = $state<Record<string, string>>({}), saving = $state<string>(""), fixed = $state<string[]>([]); // fixed: saved alt text not yet published
  async function load() {
    loading = true; error = "";
    try { health = await api.mediaHealth(); draft = Object.fromEntries(health.weakAlt.map((r) => [r.id, r.alt ?? ""])); } catch (e) { error = (e as Error).message; }
    loading = false;
  }
  $effect(() => { load(); });

  const size = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  const dims = (f: { size: number; width?: number; height?: number }) => `${f.width && f.height ? `${f.width} × ${f.height}, ` : ""}${size(f.size)}`;

  async function saveAlt(r: MediaHealth["weakAlt"][number]) {
    const text = (draft[r.id] ?? "").trim();
    if (!text) return;
    saving = r.id; error = "";
    try {
      const e = await api.get(r.id);
      await api.update(r.id, { collection: e.collection, slug: e.slug, data: { ...e.data, [r.altKey]: text } });
      fixed = [...fixed, r.id];
      health!.weakAlt = health!.weakAlt.filter((x) => x.id !== r.id); health!.counts.weakAlt--;
    } catch (e) { error = (e as Error).message; }
    saving = "";
  }
  async function publishFixed() {
    try { const r = await api.bulk(fixed, "publish"); toast(r.failed.length ? `${r.failed.length} couldn't be published` : "Published"); fixed = r.failed.map((f) => f.id); refreshCounts(); }
    catch (e) { error = (e as Error).message; }
  }
</script>

<header><h1>Media health</h1><button type="button" class="ghost" onclick={load} disabled={loading}>{loading ? "Checking…" : "Check again"}</button></header>
{#if error}<p class="error">{error}</p>{/if}
{#if loading && !health}<div class="stack" aria-busy="true" aria-label="Loading"><div class="skel" style="height:44px"></div><div class="skel" style="height:44px"></div></div>
{:else if health}
  <p class="muted">{health.total.toLocaleString()} {health.total === 1 ? "image" : "images"} checked across your image libraries.</p>
  {#if fixed.length}<p class="notice">{fixed.length} {fixed.length === 1 ? "alt text is" : "alt texts are"} saved as draft changes. <button type="button" onclick={publishFixed}>Publish {fixed.length === 1 ? "it" : "them"}</button></p>{/if}

  {#snippet thumb(r: { id: string; collection: string; label: string; file: { key: string } })}
    <a href="#/{r.collection}/{r.id}" class="mh-pic"><img src={blobUrl(r.file.key)} alt="" loading="lazy" /></a>
  {/snippet}

  <section class="hits-group">
    <h2>Alt text that needs work <span class="muted">{health.counts.weakAlt}</span></h2>
    {#if health.weakAlt.length}
      <ul class="mh">
        {#each health.weakAlt as r (r.id)}
          <li>{@render thumb(r)}
            <form class="mh-alt" onsubmit={(e) => { e.preventDefault(); saveAlt(r); }}>
              <a href="#/{r.collection}/{r.id}">{r.label}</a><small class="muted">{r.why}</small>
              <span class="inline"><input bind:value={draft[r.id]} placeholder="Describe the image" aria-label="Alt text for {r.label}" style="flex:1" /><button type="submit" disabled={saving === r.id || !(draft[r.id] ?? "").trim()}>Save</button></span>
            </form>
          </li>
        {/each}
      </ul>
      {#if health.counts.weakAlt > health.weakAlt.length}<p class="tip muted">Showing {health.weakAlt.length}. Fix these and check again for the rest.</p>{/if}
    {:else}<p class="muted">All alt text looks fine. This only catches missing, file-name and placeholder text; it can't tell if the words describe the picture.</p>{/if}
  </section>

  <section class="hits-group">
    <h2>Large files <span class="muted">{health.counts.large}</span></h2>
    {#if health.large.length}
      <ul class="mh">{#each health.large as r (r.id)}<li>{@render thumb(r)}<span class="mh-alt"><a href="#/{r.collection}/{r.id}">{r.label}</a><small class="muted">{dims(r.file)}</small></span></li>{/each}</ul>
      <p class="tip muted">Over 1.5 MB or 3000 px on the longest side. Replace the file with an optimised one, or lower the field's max size so new uploads are shrunk.</p>
    {:else}<p class="muted">No large files.</p>{/if}
  </section>

  <section class="hits-group">
    <h2>Not used anywhere <span class="muted">{health.counts.unused}</span></h2>
    {#if health.unused.length}
      <ul class="mh">{#each health.unused as r (r.id)}<li>{@render thumb(r)}<span class="mh-alt"><a href="#/{r.collection}/{r.id}">{r.label}</a><small class="muted">{dims(r.file)}</small></span></li>{/each}</ul>
      <p class="tip muted">No entry, block or link points at these. They can be deleted from their library; a deleted image stays in the Trash for a while.</p>
    {:else}<p class="muted">Every image is used somewhere.</p>{/if}
  </section>
{/if}
