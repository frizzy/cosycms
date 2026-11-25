<script lang="ts">
  import { api, type Entry } from "./api";
  import { store } from "./store.svelte";
  import { entryLabel, fileFieldOf, slugify } from "../src/fields";
  import { blobUrl, type FileValue } from "../src/images";
  import { isEmpty } from "./util";
  import FieldInput from "./FieldInput.svelte";

  // A modal for choosing entries from a collection (thumbnails for an image library), or creating one on the spot.
  type Props = { collection: string; multiple?: boolean; selected?: string[]; onchange: (ids: string[], entries: Entry[]) => void };
  let { collection, multiple = false, selected = [], onchange }: Props = $props();

  const target = $derived(store.collections.find((c) => c.key === collection));
  const fileField = $derived(target && fileFieldOf(target)); // an image library: show thumbnails
  const textFields = $derived(target?.fields.filter((f) => f.type === "text") ?? []);
  const noun = $derived(fileField ? "image" : "entry");

  let entries = $state<Entry[]>([]);
  let loaded = $state(false);
  let dlg: HTMLDialogElement;
  let mode = $state<"pick" | "create">("pick");
  let q = $state(""), draft = $state<Record<string, unknown>>({});
  let busy = $state(false), error = $state("");
  const tid = `pick-${Math.random().toString(36).slice(2)}`;

  const load = () => api.list(collection).then((e) => { entries = e; loaded = true; }, () => { loaded = true; });
  const thumb = (e: Entry) => { const v = fileField && (e.data[fileField.key] as FileValue | undefined); return v ? blobUrl(v.key) : undefined; };
  const labelOf = (e: Entry) => (target ? entryLabel(target.fields, e.data, e.slug, target.titleField) : e.slug);
  const filtered = $derived(entries.filter((e) => !q.trim() || `${labelOf(e)} ${e.slug}`.toLowerCase().includes(q.trim().toLowerCase())));

  // The dialog lives on <body> so it is never inside the entry's own <form> (which would submit it on Enter).
  function portal(node: HTMLElement) { document.body.appendChild(node); return { destroy: () => node.remove() }; }

  // The list is fetched each time it opens, so entries added elsewhere show up.
  export function open() { mode = "pick"; q = ""; dlg.showModal(); load(); }

  function choose(id: string) {
    const ids = multiple ? (selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]) : [id];
    onchange(ids, entries);
    if (!multiple) dlg.close();
  }

  async function create(ev: SubmitEvent) {
    ev.preventDefault();
    if (!target) return;
    error = ""; busy = true;
    try {
      const data = Object.fromEntries(Object.entries(draft).filter(([, v]) => !isEmpty(v)));
      // Slug comes from the collection's slug source, else its first text, else the file name.
      const seed = (target.slugSource && String(data[target.slugSource] ?? "")) || textFields.map((f) => String(data[f.key] ?? "")).find(Boolean)
        || String((fileField && (data[fileField.key] as FileValue | undefined)?.name) ?? "").replace(/\.[^.]*$/, "");
      const base = slugify(seed) || "item", check = await api.slugAvailable(target.key, base);
      // Images are library assets, so they start published; other quick-created entries start as drafts.
      let e = await api.create({ collection: target.key, slug: check.available ? base : check.suggestion ?? `${base}-2`, data });
      if (fileField) e = await api.publishEntry(e.id);
      entries = [e, ...entries];
      mode = "pick";
      choose(e.id);
    } catch (e) { error = (e as Error).message; }
    busy = false;
  }
</script>

<dialog bind:this={dlg} use:portal aria-labelledby={tid} onclose={() => (mode = "pick")}>
  <header>
    <h1 id={tid}>{mode === "create" ? `New ${noun}` : target?.label ?? "Choose"}</h1>
    <button type="button" class="icon-btn close" aria-label="Close" onclick={() => dlg.close()}>×</button>
  </header>
  {#if !target}
    <p class="error">This points at a collection that no longer exists.</p>
  {:else if mode === "pick"}
    <input type="search" placeholder="Search…" bind:value={q} onkeydown={(e) => e.key === "Enter" && e.preventDefault()} />
    {#if !loaded}
      <div class="picker-grid" aria-busy="true">{#each [1, 2, 3, 4] as _}<div class="skel" style="aspect-ratio:1"></div>{/each}</div>
    {:else if !filtered.length}
      <p class="empty">{entries.length ? "No matches." : `No ${noun}s yet. Use “${fileField ? "Upload new" : "Create new"}” to add the first.`}</p>
    {:else}
      <div class={fileField ? "picker-grid" : "picker-list"}>
        {#each filtered as e (e.id)}
          <button type="button" class="pick" class:selected={selected.includes(e.id)} aria-pressed={multiple ? selected.includes(e.id) : undefined}
            aria-label={labelOf(e)} onclick={() => choose(e.id)}>
            {#if fileField}
              {#if thumb(e)}<img src={thumb(e)} alt="" loading="lazy" />{:else}<div class="noimg"></div>{/if}
              <span>{labelOf(e)}</span>
            {:else}{labelOf(e)} <small class="muted">{e.slug}</small>{/if}
          </button>
        {/each}
      </div>
    {/if}
    <div class="dialog-actions">
      <button type="button" class="ghost" onclick={() => { draft = {}; error = ""; mode = "create"; }}>{fileField ? "Upload new" : "Create new"}</button>
      {#if multiple}<button type="button" onclick={() => dlg.close()}>Done</button>{/if}
    </div>
  {:else}
    <form onsubmit={create}>
      {#each target.fields as f (f.key)}<FieldInput field={f} bind:value={draft[f.key]} />{/each}
      <div class="dialog-actions">
        <span><button type="submit" disabled={busy}>{fileField ? "Add to library" : "Create"}</button>
          <button type="button" class="ghost" onclick={() => (mode = "pick")}>Back</button></span>
        <span class="status">{#if error}<span class="error">{error}</span>{/if}</span>
      </div>
    </form>
  {/if}
</dialog>
