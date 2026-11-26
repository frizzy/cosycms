<script lang="ts">
  import { tick } from "svelte";
  import { api } from "./api";
  import { slugify } from "../src/fields";
  import { store, refreshCounts } from "./store.svelte";
  import { toast } from "./toast.svelte";
  import { saveShortcut } from "./keys";
  import FieldInput from "./FieldInput.svelte";
  import LiveIcon from "./LiveIcon.svelte";
  import { isEmpty } from "./util";
  let { collection, id }: { collection: string; id?: string } = $props();

  const c = store.collections.find((x) => x.key === collection)!;
  let slug = $state("");
  let published = $state(false), pending = $state(false); // has a published version; the draft has moved on from it
  let data = $state<Record<string, unknown>>({});
  let loading = $state(!!id);
  let saving = $state(false);
  let error = $state("");

  // Slug source: while unlocked the slug follows that field. Typing in the slug locks it (clearing it unlocks
  // and regenerates); saved entries start locked. Only the lock stops generation.
  const source = c.slugSource ?? undefined;
  let locked = $state(!!id && !!source);
  let lastSource: unknown; // plain variable on purpose: only a *change* of the source should rewrite the slug
  $effect(() => {
    if (!source) return;
    const v = data[source];
    if (v === lastSource) return;
    lastSource = v;
    if (!locked) slug = slugify(String(v ?? ""));
  });
  function onSlugInput(e: Event) {
    if (!source) return;
    if ((e.currentTarget as HTMLInputElement).value.trim() === "") { locked = false; slug = slugify(String(data[source] ?? "")); }
    else locked = true;
  }

  // Live uniqueness check: debounced, and a stale response never overwrites a newer one.
  let savedSlug = "";
  let slugStatus = $state<"" | "ok" | "taken">("");
  let suggestion = $state("");
  $effect(() => {
    const s = slug, skip = s === savedSlug || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(s);
    slugStatus = "";
    if (skip) return;
    let stale = false;
    const t = setTimeout(() => api.slugAvailable(collection, s, id).then(
      (r) => { if (!stale) { slugStatus = r.available ? "ok" : "taken"; suggestion = r.suggestion ?? ""; } }, () => {}), 300);
    return () => { stale = true; clearTimeout(t); };
  });

  // Unsaved-changes tracking. Empty values are normalised away so a form that merely rendered isn't "dirty".
  const present = (v: unknown) => !(v === "" || v == null || v === false || (Array.isArray(v) && !v.length) || (typeof v === "number" && Number.isNaN(v)));
  const fingerprint = () => JSON.stringify([slug, Object.entries(data).filter(([, v]) => present(v)).sort(([x], [y]) => (x < y ? -1 : 1))]);
  let baseline = $state<string>();
  const rebase = () => (baseline = fingerprint());
  const dirty = $derived(!loading && baseline !== undefined && fingerprint() !== baseline);
  $effect(() => { if (!loading) tick().then(rebase); }); // after bindings and the editor have settled
  $effect(() => {
    store.dirty = dirty;
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    addEventListener("beforeunload", warn);
    return () => removeEventListener("beforeunload", warn);
  });
  $effect(() => () => { store.dirty = false; });

  $effect(() => {
    if (!id) return;
    api.get(id).then((e) => { savedSlug = e.slug; ({ slug, data, published, pending } = e); loading = false; }, (e) => { error = e.message; loading = false; });
  });

  // Where this entry is used (an image in a post, a link from another entry): shown below the form when there is anything.
  let usage = $state<{ id: string; collection: string; slug: string }[]>([]);
  $effect(() => { if (id) api.usage(id).then((r) => (usage = r.items), () => {}); });
  const collLabel = (key: string) => store.collections.find((x) => x.key === key)?.label ?? key;

  // Saving only ever changes the draft. Returns whether it saved.
  async function persist() {
    error = "";
    if (slugStatus === "taken") { error = "That slug is already used by another entry in this collection."; return false; }
    // Drop empty values so optional fields don't fail validation.
    const clean = Object.fromEntries(Object.entries(data).filter(([, v]) => !isEmpty(v)));
    saving = true;
    try {
      const body = { collection, slug, data: clean };
      let target = id;
      if (id) { const e = await api.update(id, body); ({ published, pending } = e); refreshCounts(); } else target = (await api.create(body)).id;
      savedSlug = slug; if (source) locked = true;
      rebase(); store.dirty = false; // clean before navigating so the leave-guard stays quiet
      location.hash = `#/${collection}/${target}`;
      saving = false;
      return true;
    } catch (e) { error = (e as Error).message; }
    saving = false;
    return false;
  }
  async function save(ev: SubmitEvent) { ev.preventDefault(); if (await persist()) toast("Draft saved"); }

  // Publishing saves any open edits first, then makes the draft the live version.
  async function publish() {
    if (!id || (dirty && !(await persist()))) return;
    try { ({ published, pending } = await api.publishEntry(id)); toast("Published. It goes to the site on the next Deploy."); refreshCounts(); } catch (e) { error = (e as Error).message; }
  }
  async function unpublish() {
    if (!id || !confirm("Take this off the site? The draft stays.")) return;
    try { ({ published, pending } = await api.unpublishEntry(id)); toast("Unpublished"); refreshCounts(); } catch (e) { error = (e as Error).message; }
  }
  async function revert() {
    if (!id || !confirm("Throw away the draft changes and go back to the published version?")) return;
    try { await api.revertEntry(id); store.dirty = false; loading = true; const e = await api.get(id); savedSlug = e.slug; ({ slug, data, published, pending } = e); loading = false; toast("Back to the published version"); refreshCounts(); }
    catch (e) { error = (e as Error).message; loading = false; }
  }

  async function remove() {
    if (!id || !confirm("Delete this entry?")) return;
    error = "";
    try { await api.remove(id); } catch (e) { error = (e as Error).message; return; } // e.g. still used by another entry
    store.dirty = false;
    toast("Deleted"); refreshCounts();
    location.hash = `#/${collection}`;
  }
</script>

{#snippet state()}{#if id && !loading}<span class="livestate" class:edited={pending || dirty}>{#if published}<LiveIcon />{pending || dirty ? "Published · draft has changes" : "Published"}{:else}Draft{/if}</span>{/if}{/snippet}
<div class="crumbs"><span class="muted">{c.label}</span>{@render state()}<span class="spacer"></span>{#if id}<a href="#/activity/{id}">History</a>{/if}{#if !c.single}<a href="#/{collection}">← Back</a>{/if}</div>
<header><h1>{id ? (c.titleField && String(data[c.titleField] ?? "").trim()) || slug || "Edit" : "New"}</h1></header>
{#if loading}
  <div class="stack" aria-busy="true" aria-label="Loading">
    {#each [40, 56, 56, 220] as h}<div class="skel" style="height:{h}px"></div>{/each}
  </div>
{:else}
  <form onsubmit={save} use:saveShortcut>
    <div class="field">Slug
      <div class="inline">
        <input bind:value={slug} required pattern="[a-z0-9]+(-[a-z0-9]+)*" aria-invalid={slugStatus === "taken"} oninput={onSlugInput} style="flex:1" />
        {#if source}<label class="check"><input type="checkbox" bind:checked={locked} />Locked</label>{/if}
      </div>
      <!-- Always rendered at a fixed height so messages appearing or changing never move the form. -->
      <div class="hint" aria-live="polite">
        {#if slugStatus === "taken"}
          <span class="error">✗ Already taken{#if suggestion}&nbsp;— <button type="button" class="link" onclick={() => { slug = suggestion; if (source) locked = true; }}>use {suggestion}</button>{/if}</span>
        {:else if slugStatus === "ok"}<span class="ok">✓ Available</span>
        {:else if id && published && slug !== savedSlug}<span class="muted">The file moves when you publish this change.</span>{/if}
      </div>
    </div>
    {#each c.fields as f (f.key)}<FieldInput field={f} bind:value={data[f.key]} />{/each}
    <div class="actions">
      <button type="submit" class={id && (!published || pending || dirty) ? "ghost" : ""} disabled={saving}>Save draft</button>
      {#if id && (!published || pending || dirty)}<button type="button" onclick={publish} disabled={saving}>{published ? "Publish changes" : "Publish"}</button>{/if}
      {#if id && published && pending && !dirty}<button type="button" class="ghost" onclick={revert}>Discard draft changes</button>{/if}
      {#if id && published}<button type="button" class="ghost" onclick={unpublish}>Unpublish</button>{/if}
      {#if id}<button type="button" class="danger" onclick={remove}>Delete</button>{/if}
      <span class="status">{#if error}<span class="error">{error}</span>{:else if dirty}<span class="dirty">Unsaved changes</span>{/if}</span>
    </div>
  </form>
  {#if usage.length}
    <section class="usage">
      <h2>Used in {usage.length}{usage.length === 50 ? "+" : ""} {usage.length === 1 ? "place" : "places"}</h2>
      <ul>{#each usage as u (u.id)}<li><a href="#/{u.collection}/{u.id}">{u.slug}</a> <span class="muted">{collLabel(u.collection)}</span></li>{/each}</ul>
    </section>
  {/if}
{/if}

<style>
  .usage { margin-top: 2rem; }
  .usage h2 { font-size: 1rem; margin: 0 0 .5rem; }
  .usage ul { list-style: none; margin: 0; padding: 0; display: grid; gap: .3rem; max-height: 14rem; overflow: auto; }
  .usage li { overflow-wrap: anywhere; }
</style>
