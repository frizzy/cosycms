<script lang="ts">
  import { api, type Entry } from "./api";
  import { store } from "./store.svelte";
  import { entryLabel } from "../src/fields";

  // Sets a link in the rich text: to a web address, or to an entry of any collection that has a page address. An entry link is stored as
  // cosy:entry/<id>, so it follows the entry (its slug can change) and is turned into the real address when published.
  const PREFIX = "cosy:entry/";
  type Hit = { id: string; label: string; collection: string; collectionLabel: string };
  let dlg: HTMLDialogElement;
  let mode = $state<"web" | "entry">("web"), url = $state(""), q = $state(""), hits = $state<Hit[]>([]), chosen = $state<Hit>();
  let existing = $state(false), searching = $state(false), done: (href: string | null) => void = () => {};
  const targets = $derived(store.collections.filter((c) => c.urlTemplate)); // only these can be linked to: they say where their entries live
  const uid = Math.random().toString(36).slice(2);

  export function open(href: string, save: (href: string | null) => void) {
    done = save; existing = !!href; chosen = undefined; q = ""; hits = [];
    mode = href.startsWith(PREFIX) ? "entry" : "web";
    url = mode === "web" ? href : "";
    if (mode === "entry") api.get(href.slice(PREFIX.length)).then((e) => { chosen = label(e); }, () => {});
    dlg.showModal();
    if (mode === "entry") find();
  }
  const label = (e: Entry): Hit => { const c = store.collections.find((x) => x.key === e.collection)!; return { id: e.id, label: entryLabel(c.fields, e.data, e.slug, c.titleField), collection: c.key, collectionLabel: c.label }; };

  let seq = 0;
  async function find() {
    const mine = ++seq; searching = true;
    const per = await Promise.all(targets.map((c) => api.search(c.key, { q, sort: q.trim() ? "title" : "updated", dir: q.trim() ? "asc" : "desc", limit: 6, offset: 0 }).then((r) => r.items.map(label), () => [])));
    if (mine === seq) { hits = per.flat(); searching = false; }
  }
  let timer: ReturnType<typeof setTimeout>;
  const typing = () => { clearTimeout(timer); timer = setTimeout(find, 250); };

  function submit(ev: SubmitEvent) {
    ev.preventDefault();
    const href = mode === "entry" ? (chosen ? PREFIX + chosen.id : "") : url.trim();
    if (!href) return;
    done(href); dlg.close();
  }
  function portal(node: HTMLElement) { document.body.appendChild(node); return { destroy: () => node.remove() }; }
</script>

<dialog bind:this={dlg} use:portal aria-labelledby="ld-{uid}">
  <header><h1 id="ld-{uid}">Link</h1><button type="button" class="icon-btn close" aria-label="Close" onclick={() => dlg.close()}>×</button></header>
  <form onsubmit={submit}>
    <div class="tabs" role="tablist">
      <a href="#link" role="tab" aria-selected={mode === "web"} class:active={mode === "web"} onclick={(e) => { e.preventDefault(); mode = "web"; }}>Web address</a>
      <a href="#link" role="tab" aria-selected={mode === "entry"} class:active={mode === "entry"} onclick={(e) => { e.preventDefault(); mode = "entry"; if (!hits.length) find(); }}>An entry</a>
    </div>
    {#if mode === "web"}
      <label>Address <input bind:value={url} placeholder="https://… or /page" autocomplete="off" /></label>
    {:else if !targets.length}
      <p class="muted">None of your collections has a page address yet, so there's nothing to link to. Set one in a collection's settings (the gear icon), like <code>/blog/{"{slug}"}</code>.</p>
    {:else}
      {#if chosen}<p>Linking to <strong>{chosen.label}</strong> <small class="muted">{chosen.collectionLabel}</small></p>{/if}
      <input type="search" bind:value={q} oninput={typing} placeholder="Search {targets.map((c) => c.label.toLowerCase()).join(", ")}" aria-label="Search entries" />
      <div class="picker-list" aria-busy={searching}>
        {#each hits as h (h.id)}
          <button type="button" class="ghost hit" class:on={chosen?.id === h.id} onclick={() => (chosen = h)}><span class="ell">{h.label}</span> <small class="muted">{h.collectionLabel}</small></button>
        {:else}{#if !searching}<p class="muted">Nothing found.</p>{/if}{/each}
      </div>
    {/if}
    <div class="dialog-actions">
      <span>
        <button type="submit" disabled={mode === "entry" ? !chosen : !url.trim()}>Set link</button>
        <button type="button" class="ghost" onclick={() => dlg.close()}>Cancel</button>
      </span>
      {#if existing}<button type="button" class="danger" onclick={() => { done(null); dlg.close(); }}>Remove link</button>{/if}
    </div>
  </form>
</dialog>
