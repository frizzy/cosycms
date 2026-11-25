<script lang="ts">
  import type { BlockDef, PropDef } from "../src/blocks";
  import type { Entry } from "./api";
  import { store } from "./store.svelte";
  import { entryLabel, fileFieldOf } from "../src/fields";
  import { blobUrl, type FileValue } from "../src/images";
  import PickerDialog from "./PickerDialog.svelte";
  import PlusIcon from "./PlusIcon.svelte";
  import OpenLink from "./OpenLink.svelte";

  // Edits one block's settings. Opened for a new block (nothing filled in) or an existing one.
  type Item = { entry: string; src: string; alt: string };
  let dlg: HTMLDialogElement;
  let def = $state<BlockDef>();
  let props = $state<Record<string, any>>({});
  let done: (p: Record<string, unknown>) => void = () => {};
  const pickers: Record<string, PickerDialog> = {};
  const uid = Math.random().toString(36).slice(2);

  export function open(d: BlockDef, current: Record<string, unknown>, save: (p: Record<string, unknown>) => void) {
    def = d; props = structuredClone($state.snapshot(current)); done = save; dlg.showModal();
  }
  function portal(node: HTMLElement) { document.body.appendChild(node); return { destroy: () => node.remove() }; }

  const items = (p: PropDef): Item[] => (props[p.key] as Item[] | undefined) ?? [];
  function picked(p: Extract<PropDef, { type: "images" }>, ids: string[], all: Entry[]) {
    const lib = store.collections.find((c) => c.key === p.library), ff = lib && fileFieldOf(lib), have = new Map(items(p).map((i) => [i.entry, i]));
    props[p.key] = ids.flatMap((id): Item[] => {
      const e = all.find((x) => x.id === id), f = e && ff && (e.data[ff.key] as FileValue | undefined);
      const kept = have.get(id);
      return kept ? [kept] : e && f && lib ? [{ entry: id, src: blobUrl(f.key), alt: entryLabel(lib.fields, e.data, e.slug, lib.titleField) }] : [];
    });
  }
  function move(p: PropDef, i: number, d: number) { const l = [...items(p)]; [l[i], l[i + d]] = [l[i + d], l[i]]; props[p.key] = l; }

  function submit(ev: SubmitEvent) {
    ev.preventDefault();
    done(Object.fromEntries(Object.entries($state.snapshot(props)).filter(([, v]) => v != null && v !== "" && !(Array.isArray(v) && !v.length) && !(typeof v === "number" && Number.isNaN(v)))));
    dlg.close();
  }
</script>

<dialog bind:this={dlg} use:portal aria-labelledby="bd-{uid}">
  <header><h1 id="bd-{uid}">{def?.label ?? "Block"}</h1><button type="button" class="icon-btn close" aria-label="Close" onclick={() => dlg.close()}>×</button></header>
  {#if def}
    <form onsubmit={submit}>
      {#each def.props as p (p.key)}
        {#if p.type === "images"}
          <div class="field">{p.label}
            <div class="inline">
              {#each items(p) as it, i (it.entry)}
                <figure class="tile">
                  <img src={it.src} alt={it.alt} /><figcaption title={it.alt}>{it.alt}</figcaption>
                  <button type="button" class="x" aria-label="Remove {it.alt}" onclick={() => (props[p.key] = items(p).filter((x) => x.entry !== it.entry))}>×</button>
                  <OpenLink href="#/{p.library}/{it.entry}" label="Open {it.alt}" />
                  <span class="reorder">
                    <button type="button" class="ghost" disabled={i === 0} aria-label="Move earlier" onclick={() => move(p, i, -1)}>←</button>
                    <button type="button" class="ghost" disabled={i === items(p).length - 1} aria-label="Move later" onclick={() => move(p, i, 1)}>→</button>
                  </span>
                </figure>
              {/each}
              <button type="button" class="icon-btn" aria-label="Add images" title="Add images" onclick={() => pickers[p.key].open()}><PlusIcon /></button>
            </div>
          </div>
        {:else if p.type === "boolean"}
          <label class="check"><input type="checkbox" bind:checked={props[p.key]} />{p.label}</label>
        {:else if p.type === "select"}
          <label>{p.label}<select bind:value={props[p.key]}><option value="">—</option>{#each p.options as o}<option>{o}</option>{/each}</select></label>
        {:else if p.type === "number"}
          <label>{p.label}<input type="number" step="any" bind:value={props[p.key]} /></label>
        {:else}
          <label>{p.label}<input bind:value={props[p.key]} /></label>
        {/if}
      {/each}
      <div class="dialog-actions"><span><button type="submit">Done</button> <button type="button" class="ghost" onclick={() => dlg.close()}>Cancel</button></span></div>
    </form>
    {#each def.props.filter((p) => p.type === "images") as p (p.key)}
      {#if p.type === "images"}<PickerDialog bind:this={pickers[p.key]} collection={p.library} multiple selected={items(p).map((i) => i.entry)} onchange={(ids, all) => picked(p, ids, all)} />{/if}
    {/each}
  {/if}
</dialog>
