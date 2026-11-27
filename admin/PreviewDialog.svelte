<script lang="ts">
  import type { Field } from "../src/fields";
  import { entryLabel, fileFieldOf } from "../src/fields";
  import { blobUrl, type FileValue } from "../src/images";
  import { api, type Entry } from "./api";
  import { store } from "./store.svelte";
  import RichText from "./RichText.svelte";

  // A read-only view of what is in the form now (saved or not), field by field. It is not styled like the site: the site is built elsewhere.
  let { open, fields, data, titleField, onclose }: { open: boolean; fields: Field[]; data: Record<string, unknown>; titleField?: string | null; onclose: () => void } = $props();
  let dlg = $state<HTMLDialogElement>();
  const portal = (node: HTMLElement) => { document.body.appendChild(node); return { destroy: () => node.remove() }; };
  $effect(() => { if (open && dlg && !dlg.open) dlg.showModal(); else if (!open && dlg?.open) dlg.close(); });

  // Referenced entries are looked up for their name (and picture, for an image library).
  let refs = $state<Record<string, Entry>>({});
  $effect(() => {
    if (!open) return;
    for (const f of fields) if (f.type === "reference") for (const id of [data[f.key]].flat().filter((x): x is string => typeof x === "string"))
      if (!refs[id]) api.get(id).then((e) => (refs[id] = e), () => {});
  });
  const refLabel = (e: Entry) => { const col = store.collections.find((x) => x.key === e.collection); return col ? entryLabel(col.fields, e.data, e.slug, col.titleField) : e.slug; };
  const refPic = (e: Entry) => { const col = store.collections.find((x) => x.key === e.collection), ff = col && fileFieldOf(col); return ff ? (e.data[ff.key] as FileValue | undefined) : undefined; };
  const shown = $derived(fields.filter((f) => { const v = data[f.key]; return v != null && v !== "" && !(Array.isArray(v) && !v.length) && !(f.type === "datetime" && f.autoSet === "save"); }));
</script>

{#if open}
  <dialog bind:this={dlg} use:portal class="preview" aria-labelledby="pv-title" oncancel={(e) => { e.preventDefault(); onclose(); }} onclick={(e) => { if (e.target === dlg) onclose(); }}>
    <header><h1 id="pv-title">Preview</h1><button type="button" class="icon-btn close" aria-label="Close preview" onclick={onclose}>×</button></header>
    <p class="muted">The content as it stands in the form, saved or not. It isn't styled like your site.</p>
    <!-- Any picture opens larger in the lightbox. -->
    <article class="pv" role="presentation" onclick={(e) => { const i = e.target; if (i instanceof HTMLImageElement) store.zoom = { src: i.src, alt: i.alt }; }}>
      {#each shown as f (f.key)}
        {@const v = data[f.key]}
        <section>
          {#if f.key === titleField}<h2>{v}</h2>
          {:else}
            <h3>{f.label}</h3>
            {#if f.type === "richtext"}
              <RichText readonly value={v} library={f.imageLibrary} blocks={(f.blocks ?? []).flatMap((k) => store.blocks.filter((b) => b.key === k))} />
            {:else if f.type === "textarea"}<p class="pv-text">{v}</p>
            {:else if f.type === "file"}<img class="pv-img" src={blobUrl((v as FileValue).key)} alt={(v as FileValue).name} />
            {:else if f.type === "reference"}
              <div class="pv-refs">{#each [v].flat() as id}{@const e = refs[id as string]}{#if e}{@const pic = refPic(e)}<figure>{#if pic}<img src={blobUrl(pic.key)} alt={refLabel(e)} />{/if}<figcaption>{refLabel(e)}</figcaption></figure>{/if}{/each}</div>
            {:else if f.type === "select" && Array.isArray(v)}<div class="chips">{#each v as t}<span class="chip">{t}</span>{/each}</div>
            {:else if f.type === "boolean"}<p>{v ? "Yes" : "No"}</p>
            {:else if f.type === "datetime"}<p>{new Date(String(v)).toLocaleString()}</p>
            {:else}<p>{v}</p>{/if}
          {/if}
        </section>
      {/each}
    </article>
  </dialog>
{/if}
