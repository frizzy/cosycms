<script lang="ts">
  import { api, type Entry } from "./api";
  import { store } from "./store.svelte";
  import { entryLabel, fileFieldOf, type Field } from "../src/fields";
  import { blobUrl, type FileValue } from "../src/images";
  import PickerDialog from "./PickerDialog.svelte";
  import PlusIcon from "./PlusIcon.svelte";
  import OpenLink from "./OpenLink.svelte";

  type RefField = Extract<Field, { type: "reference" }>;
  let { field, value = $bindable() }: { field: RefField; value?: string | string[] } = $props();

  const target = $derived(store.collections.find((c) => c.key === field.collection));
  const fileField = $derived(target && fileFieldOf(target)); // an image library: show thumbnails
  const ids = $derived(field.multiple ? (value as string[] | undefined) ?? [] : value ? [value as string] : []);
  const noun = $derived(fileField ? "image" : "entry");

  let entries = $state<Entry[]>([]);
  let loaded = $state(false);
  let picker: PickerDialog;

  // Loaded to name what's selected; the picker hands back a fresh list whenever something changes.
  $effect(() => { if (target) api.list(target.key).then((e) => { entries = e; loaded = true; }, () => { loaded = true; }); });

  const byId = $derived(new Map(entries.map((e) => [e.id, e])));
  const thumb = (e: Entry) => { const v = fileField && (e.data[fileField.key] as FileValue | undefined); return v ? blobUrl(v.key) : undefined; };
  const labelOf = (e: Entry) => (target ? entryLabel(target.fields, e.data, e.slug, target.titleField) : e.slug);
  const unselect = (id: string) => (value = field.multiple ? ids.filter((x) => x !== id) : undefined);
  function picked(next: string[], all: Entry[]) { entries = all; loaded = true; value = field.multiple ? next : next[0]; }
</script>

<div class="refs">
  {#each ids as id (id)}
    {@const e = byId.get(id)}
    {@const name = !loaded ? "Loading…" : e ? labelOf(e) : "Missing entry"}
    {#if fileField}
      <figure class="tile">
        {#if e && thumb(e)}<button type="button" class="zoom" title="View larger" aria-label="View {name} larger" onclick={() => (store.zoom = { src: thumb(e)!, alt: name })}><img src={thumb(e)} alt="" /></button>{:else}<div class="noimg"></div>{/if}
        <figcaption title={name}>{name}</figcaption>
        <button type="button" class="x" aria-label="Remove {name}" onclick={() => unselect(id)}>×</button>
        {#if e}<OpenLink href="#/{field.collection}/{id}" label="Open {name}" />{/if}
      </figure>
    {:else}
      <span class="chip">{name}{#if e}<OpenLink href="#/{field.collection}/{id}" label="Open {name}" />{/if}<button type="button" aria-label="Remove {name}" onclick={() => unselect(id)}>×</button></span>
    {/if}
  {/each}
  {#if field.multiple}
    <button type="button" class="icon-btn" aria-label="Add {noun}" title="Add {noun}" onclick={() => picker.open()}><PlusIcon /></button>
  {:else}
    <button type="button" class="ghost" onclick={() => picker.open()}>{ids.length ? "Change" : `Choose ${noun}`}</button>
  {/if}
</div>

<PickerDialog bind:this={picker} collection={field.collection} multiple={field.multiple} selected={ids} onchange={picked} />
