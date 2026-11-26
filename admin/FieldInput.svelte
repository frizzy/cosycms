<script lang="ts">
  import type { Field } from "../src/fields";
  import { imageOptions, type FileValue } from "../src/images";
  import RichText from "./RichText.svelte";
  import TagsInput from "./TagsInput.svelte";
  import FileInput from "./FileInput.svelte";
  import ReferenceInput from "./ReferenceInput.svelte";
  import DateTimeInput from "./DateTimeInput.svelte";
  import { store } from "./store.svelte";

  // One input per field definition. Used by the entry editor and by the picker's quick-create form.
  let { field: f, value = $bindable(), locked = "" }: { field: Field; value?: unknown; locked?: string } = $props(); // locked: read-only, and why
  const name = $derived(f.label + (f.required && f.type !== "boolean" && f.type !== "richtext" ? " *" : ""));
  const uid = Math.random().toString(36).slice(2);


  function toggle(option: string) {
    const cur = (value as string[] | undefined) ?? [];
    value = cur.includes(option) ? cur.filter((x) => x !== option) : [...cur, option];
  }
</script>

{#if f.type === "file"}
  <div class="field">{name}<FileInput bind:value={value as FileValue} options={imageOptions(f)} /></div>
{:else if f.type === "reference"}
  <div class="field">{name}<ReferenceInput field={f} bind:value={value as string | string[] | undefined} /></div>
{:else if f.type === "richtext"}
  <div class="field">{name}<RichText bind:value library={f.imageLibrary} imageComponent={f.imageComponent} blocks={(f.blocks ?? []).flatMap((k) => store.blocks.filter((b) => b.key === k))} templates={(f.templates ?? []).flatMap((k) => store.templates.filter((t) => t.key === k && t.body))} /></div>
{:else if f.type === "select" && f.multiple && f.allowCustom}
  <div class="field">{name}<TagsInput bind:value={value as string[]} suggestions={f.options} /></div>
{:else if f.type === "select" && f.multiple}
  <div class="field">{name}
    <div class="checks">
      {#each f.options as o}
        <label class="check"><input type="checkbox" checked={((value as string[]) ?? []).includes(o)} onchange={() => toggle(o)} />{o}</label>
      {/each}
    </div>
  </div>
{:else}
  <label>{name}
    {#if f.type === "textarea"}
      <textarea rows="8" bind:value={value as string} required={f.required}></textarea>
    {:else if f.type === "select" && f.allowCustom}
      <input list="opts-{uid}" bind:value={value as string} required={f.required} />
      <datalist id="opts-{uid}">{#each f.options as o}<option value={o}></option>{/each}</datalist>
    {:else if f.type === "select"}
      <select bind:value={value as string} required={f.required}>
        <option value="">—</option>{#each f.options as o}<option>{o}</option>{/each}
      </select>
    {:else if f.type === "datetime" && f.autoSet === "save"}
      <input value={value ? new Date(String(value)).toLocaleString() : "Set when you save"} disabled />
    {:else if f.type === "datetime"}
      <DateTimeInput bind:value={value as string | undefined} disabled={!!locked} />
      {#if locked}<small class="muted">{locked}</small>{/if}
      {#if f.autoSet === "create" && !value}<small class="muted">Filled in with the time you save, if left empty.</small>{/if}
    {:else if f.type === "boolean"}
      <input type="checkbox" bind:checked={value as boolean} />
    {:else if f.type === "number"}
      <input type="number" step="any" bind:value={value as number} required={f.required} />
    {:else}
      <input type={f.type} bind:value={value as string} required={f.required} />
    {/if}
  </label>
{/if}
