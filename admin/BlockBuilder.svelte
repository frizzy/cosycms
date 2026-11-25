<script lang="ts">
  import { api } from "./api";
  import { store, refreshCollections } from "./store.svelte";
  import { toast } from "./toast.svelte";
  import PlusIcon from "./PlusIcon.svelte";
  import { saveShortcut } from "./keys";
  import { fileFieldOf } from "../src/fields";
  import { BlockDef } from "../src/blocks";

  // Edits one content block: its name (the tag used in MDX), what it holds, and its properties.
  let { bkey }: { bkey?: string } = $props();
  const existing = bkey ? store.blocks.find((b) => b.key === bkey) : undefined;

  type Row = { uid: string; key: string; label: string; type: string; options: string; library: string; rooted: boolean; isNew: boolean; touched: boolean };
  const TYPES = [["text", "Text"], ["number", "Number"], ["boolean", "Yes / no"], ["select", "Choice"], ["images", "Images from a library"]];
  const camel = (s: string) => s.replace(/[^a-zA-Z0-9]+(.)?/g, (_, c) => (c ?? "").toUpperCase()).replace(/^[^a-zA-Z]+/, "").replace(/^./, (c) => c.toLowerCase());

  let label = $state(existing?.label ?? ""), key = $state(existing?.key ?? ""), content = $state(existing?.content ?? "none");
  let keyTouched = $state(!!existing), error = $state(""), busy = $state(false);
  let rows = $state<Row[]>((existing?.props ?? []).map((p) => ({ uid: crypto.randomUUID(), key: p.key, label: p.label, type: p.type, options: p.type === "select" ? p.options.join("\n") : "",
    library: p.type === "images" ? p.library : "", rooted: p.type === "images" && !!p.rooted, isNew: false, touched: true })));
  const libraries = $derived(store.collections.filter((c) => fileFieldOf(c)));
  const pascal = (s: string) => s.replace(/[^a-zA-Z0-9]+(.)?/g, (_, c) => (c ?? "").toUpperCase()).replace(/^[^a-zA-Z]+/, "").replace(/^./, (c) => c.toUpperCase());

  async function save(ev: SubmitEvent) {
    ev.preventDefault(); error = ""; busy = true;
    try {
      const body = BlockDef.parse({ key, label, content, props: rows.map((r) => ({
        key: r.key, label: r.label, type: r.type,
        ...(r.type === "select" ? { options: r.options.split("\n").map((o) => o.trim()).filter(Boolean) } : {}),
        ...(r.type === "images" ? { library: r.library, ...(r.rooted ? { rooted: true } : {}) } : {}),
      })) });
      await api.saveBlock(body);
      await refreshCollections();
      toast("Saved");
      location.hash = "#/blocks";
    } catch (e) { error = e instanceof Error && "issues" in e ? (e as any).issues.map((i: any) => i.message).join("; ") : (e as Error).message; }
    busy = false;
  }
  async function remove() {
    if (!existing || !confirm(`Delete the "${existing.label}" block?`)) return;
    try { await api.deleteBlock(existing.key); await refreshCollections(); toast("Deleted"); location.hash = "#/blocks"; }
    catch (e) { error = (e as Error).message; }
  }
</script>

{#if bkey && !existing}
  <p class="error">No such block.</p>
{:else}
  <header><h1>{existing ? existing.label : "New block"}</h1><a href="#/blocks">← Back</a></header>
  <form onsubmit={save} use:saveShortcut>
    <label>Name <input bind:value={label} required placeholder="Call-out box" oninput={() => !existing && !keyTouched && (key = pascal(label))} /></label>
    <label>Component name <input bind:value={key} required disabled={!!existing} pattern="[A-Z][A-Za-z0-9]*" placeholder="Callout" oninput={() => (keyTouched = true)} />
      <small class="muted">The tag this block is published as, like &lt;Callout&gt;. It can't be changed later.</small></label>
    <label>It holds
      <select bind:value={content}>
        <option value="none">Nothing, only settings (a button, a gallery)</option>
        <option value="inline">One run of text with bold and links (a caption)</option>
        <option value="blocks">Paragraphs, lists and images (a call-out box)</option>
      </select>
    </label>

    <h2>Settings</h2>
    {#each rows as row, i (row.uid)}
      <fieldset class="fieldrow">
        <div class="cols">
          <label>Label <input bind:value={row.label} required oninput={() => row.isNew && !row.touched && (row.key = camel(row.label))} /></label>
          <label>Key <input bind:value={row.key} required disabled={!row.isNew} pattern="[a-z][a-zA-Z0-9]*" oninput={() => (row.touched = true)} /></label>
          <label>Type <select bind:value={row.type} disabled={!row.isNew}>{#each TYPES as [v, l]}<option value={v}>{l}</option>{/each}</select></label>
        </div>
        {#if row.type === "select"}
          <label>Choices (one per line)<textarea rows="3" bind:value={row.options}></textarea></label>
        {:else if row.type === "images"}
          <div class="inline">
            <label>Library
              <select bind:value={row.library} required>
                <option value="" disabled>{libraries.length ? "Choose an image library" : "Create an image library first"}</option>
                {#each libraries as c (c.key)}<option value={c.key}>{c.label}</option>{/each}
              </select>
            </label>
            <label class="check keep"><input type="checkbox" bind:checked={row.rooted} />Publish paths from the project root (/src/…)</label>
          </div>
        {/if}
        <div class="inline">
          <span class="spacer"></span>
          <button type="button" class="ghost danger-text" onclick={() => rows.splice(i, 1)}>Remove</button>
        </div>
      </fieldset>
    {:else}
      <p class="muted">No settings.</p>
    {/each}
    <div><button type="button" class="icon-btn" aria-label="Add setting" title="Add setting" onclick={() => rows.push({ uid: crypto.randomUUID(), key: "", label: "", type: "text", options: "", library: "", rooted: false, isNew: true, touched: false })}><PlusIcon /></button></div>

    <div class="actions">
      <button type="submit" disabled={busy}>{existing ? "Save" : "Create"}</button>
      {#if existing}<button type="button" class="danger" onclick={remove}>Delete block</button>{/if}
      <span class="status">{#if error}<span class="error">{error}</span>{/if}</span>
    </div>
  </form>
{/if}
