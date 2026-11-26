<script lang="ts">
  import GearIcon from "./GearIcon.svelte";
  import PlusIcon from "./PlusIcon.svelte";
  import { dataSchema, entryLabel } from "../src/fields";
  import { api, type Entry } from "./api";
  import { blobUrl } from "../src/images";
  import { store } from "./store.svelte";
  import LiveIcon from "./LiveIcon.svelte";
  let { collection }: { collection: string } = $props();
  const col = $derived(store.collections.find((c) => c.key === collection)!);
  const schema = $derived(dataSchema(col));

  // List or grid (grid only where entries have a thumbnail), remembered per collection in this browser.
  const KEY = $derived(`cosy.view.${collection}`);
  const stored = () => { try { return localStorage.getItem(KEY) === "grid"; } catch { return false; } };
  let chosen = $state(stored());
  $effect(() => { chosen = stored(); });
  const grid = $derived(chosen && !!col.thumbField);
  const SIZE = $derived(grid ? 24 : 25);
  function setView(g: boolean) { chosen = g; page = 0; try { localStorage.setItem(KEY, g ? "grid" : "list"); } catch {} }

  // Filters, remembered per collection: status ones everywhere, plus "no <field>" for optional fields that can be left empty.
  const FKEY = $derived(`cosy.filter.${collection}`);
  const filters = $derived([
    { value: "", text: "All" }, { value: "attention", text: "Needs publishing" }, { value: "draft", text: "Drafts" }, { value: "edited", text: "Edited" },
    ...col.fields.filter((f) => !f.required && ["text", "textarea", "url", "reference", "file"].includes(f.type)).map((f) => ({ value: `empty:${f.key}`, text: `No ${f.label.toLowerCase()}` })),
  ]);
  const storedFilter = () => { try { return localStorage.getItem(FKEY) ?? ""; } catch { return ""; } };
  let chosenFilter = $state(storedFilter());
  $effect(() => { chosenFilter = storedFilter(); });
  const filter = $derived(filters.some((f) => f.value === chosenFilter) ? chosenFilter : "");
  function setFilter(v: string) { chosenFilter = v; page = 0; try { v ? localStorage.setItem(FKEY, v) : localStorage.removeItem(FKEY); } catch {} }

  // Owner-only, run by hand: entries no other entry points at, shown in place of the list (the scan reads every entry, so it is never automatic).
  let unused = $state<Awaited<ReturnType<typeof api.unused>>>(), scanning = $state(false);
  $effect(() => { collection; unused = undefined; });
  async function scan() {
    scanning = true; error = "";
    try { unused = await api.unused(collection); } catch (e) { error = (e as Error).message; }
    scanning = false;
  }

  // The list is searched, sorted and paged on the server, so it stays quick however many entries there are.
  let q = $state(""), sort = $state("updated"), dir = $state<"asc" | "desc">("desc"), page = $state(0);
  let rows = $state<Entry[] | undefined>(), total = $state(0), error = $state(""), busy = $state(false);

  let first = true; // the first load is immediate; typing is debounced
  $effect(() => {
    const query = q.trim(), s = sort, d = dir, p = page, f = filter;
    let stale = false;
    const t = setTimeout(() => {
      busy = true;
      api.search(collection, { q: query, sort: s, dir: d, limit: SIZE, offset: p * SIZE, filter: f }).then((r) => {
        if (stale) return;
        // A deletion elsewhere can leave this page past the end: go back to the last real page.
        if (!r.items.length && p > 0) { page = Math.max(0, Math.ceil(r.total / SIZE) - 1); return; }
        // A single-entry collection has no list worth showing: go to its entry (or to the form for it).
        if (col.single && !query && !f && r.total <= 1) { location.replace(r.total ? `#/${collection}/${r.items[0].id}` : `#/${collection}/new`); return; }
        rows = r.items; total = r.total; error = ""; busy = false;
      }, (e) => { if (!stale) { error = e.message; busy = false; } });
    }, first ? 0 : 250);
    first = false;
    return () => { stale = true; clearTimeout(t); };
  });

  const shown = $derived(unused ? unused.items : rows);
  const titled = $derived(!!col.titleField);
  const nameCol = $derived(titled ? "title" : "slug");
  function sortBy(key: string) {
    if (sort === key) dir = dir === "asc" ? "desc" : "asc";
    else { sort = key; dir = key === "updated" ? "desc" : "asc"; }
    page = 0;
  }
  const aria = (key: string) => (sort === key ? (dir === "asc" ? "ascending" : "descending") : "none");
  const pages = $derived(Math.max(1, Math.ceil(total / SIZE)));
  const label = (e: Entry) => (titled ? entryLabel(col.fields, e.data, e.slug, col.titleField) : e.slug);
  const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
</script>

<header>
  <span class="titlebar"><h1>{col.label}</h1>{#if store.me?.role === "owner"}<a class="icon-btn quiet" href="#/collections/{col.key}" aria-label="Collection settings" title="Collection settings"><GearIcon /></a>{/if}</span>
  {#if !(col.single && total)}<a class="icon-btn" href="#/{collection}/new" aria-label="New entry" title="New entry"><PlusIcon /></a>{/if}
</header>

<div class="listbar">
  <input type="search" class="search" placeholder="Search {col.label.toLowerCase()}" aria-label="Search entries" bind:value={q} oninput={() => (page = 0)} />
  <select aria-label="Filter" value={filter} onchange={(e) => setFilter(e.currentTarget.value)}>{#each filters as f (f.value)}<option value={f.value}>{f.text}</option>{/each}</select>
  {#if col.thumbField}
    {#if grid}<select aria-label="Sort by" value={sort} onchange={(e) => { sort = e.currentTarget.value; dir = sort === "updated" ? "desc" : "asc"; page = 0; }}><option value="updated">Updated</option><option value={nameCol}>{titled ? "Title" : "Slug"}</option><option value="status">Status</option></select>{/if}
    {#if store.me?.role === "owner"}<button type="button" class="ghost" aria-pressed={!!unused} onclick={scan} disabled={scanning} title="List entries that no other entry links to. Reads everything, so it runs only when you ask.">{scanning ? "Scanning…" : "Find unlinked"}</button>{/if}
    <div class="seg" role="group" aria-label="View"><button type="button" class="ghost" aria-pressed={!grid} aria-label="List view" title="List view" onclick={() => setView(false)}><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" /></svg></button><button type="button" class="ghost" aria-pressed={grid} aria-label="Grid view" title="Grid view" onclick={() => setView(true)}><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="4" width="6.5" height="6.5" rx="1" /><rect x="13.5" y="4" width="6.5" height="6.5" rx="1" /><rect x="4" y="13.5" width="6.5" height="6.5" rx="1" /><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1" /></svg></button></div>
  {/if}
</div>

{#if unused}
  <p class="notice scanned">{unused.total ? `${unused.total} of ${unused.scanned} aren't linked from any other entry` : `Everything is linked from somewhere (${unused.scanned} checked)`}.{#if unused.total > unused.items.length} Showing the {unused.items.length} most recently updated.{/if}
    <button type="button" class="ghost" onclick={() => (unused = undefined)}>Show all</button></p>
{/if}

{#if error}<p class="error">{error}</p>
{:else if !shown}
  <div class="stack" aria-busy="true" aria-label="Loading">{#each [1, 2, 3, 4] as _}<div class="skel" style="height:44px"></div>{/each}</div>
{:else}
  {#if grid}
    <div class="grid" class:busy>
      {#each shown as e (e.id)}
        <a class="gtile" href="#/{collection}/{e.id}" title={label(e)}>
          {#if e.thumb}<img src={blobUrl(e.thumb)} alt="" loading="lazy" />{:else}<span class="noimg"></span>{/if}
          <span class="cap"><span class="ell">{label(e)}</span>{#if e.published}<span class:edited={e.pending} title={e.pending ? "Published, with draft changes" : "Published"}><LiveIcon /></span>{/if}</span>
        </a>
      {:else}
        <p class="empty">{#if q.trim() || filter}No entries match{q.trim() ? ` “${q.trim()}”` : ""}{filter ? " this filter" : ""}.{:else}Nothing here yet. <a href="#/{collection}/new">Create the first entry.</a>{/if}</p>
      {/each}
    </div>
  {:else}
  <table class="list" class:busy>
    <thead><tr>
      {#each [[nameCol, titled ? "Title" : "Slug"], ["status", "Status"], ["updated", "Updated"]] as [key, text] (key)}
        <th aria-sort={aria(key)} class="c-{key}">
          <button type="button" class="sort" onclick={() => sortBy(key)}>{text}<span aria-hidden="true">{sort === key ? (dir === "asc" ? "▲" : "▼") : ""}</span></button>
        </th>
      {/each}
    </tr></thead>
    <tbody>
      {#each shown as e (e.id)}
        <tr>
          <td class="name"><div class="cell">
            {#if col.thumbField}{#if e.thumb}<img class="thumb" src={blobUrl(e.thumb)} alt="" loading="lazy" />{:else}<span class="thumb none" aria-hidden="true"></span>{/if}{/if}
            <a class="ell" href="#/{collection}/{e.id}" title={label(e)}>{label(e)}</a>
            {#if !schema.safeParse(e.data).success}<span class="warn" title="Doesn't match the current fields — open and fix it">⚠ needs attention</span>{/if}
          </div></td>
          <td class="c-status">{#if e.published}<span class:edited={e.pending} title={e.pending ? "Published, with changes in the draft that aren't live yet" : "Has a published version"}><LiveIcon />{e.pending ? "Edited" : "Published"}</span>{:else}Draft{/if}</td><td class="c-updated">{when(e.updatedAt)}</td>
        </tr>
      {:else}
        <tr><td colspan="3" class="empty">
          {#if q.trim() || filter}No entries match{q.trim() ? ` “${q.trim()}”` : ""}{filter ? " this filter" : ""}.{:else}Nothing here yet. <a href="#/{collection}/new">Create the first entry.</a>{/if}
        </td></tr>
      {/each}
    </tbody>
  </table>
  {/if}
  {#if unused}{:else if total > SIZE}
    <div class="pager" role="navigation" aria-label="Pages">
      <span class="muted">{page * SIZE + 1}–{Math.min(total, (page + 1) * SIZE)} of {total}</span>
      <span class="spacer"></span>
      <button type="button" class="ghost" disabled={page === 0} onclick={() => page--}>Previous</button>
      <button type="button" class="ghost" disabled={page >= pages - 1} onclick={() => page++}>Next</button>
    </div>
  {:else if total}<p class="muted count">{total} {total === 1 ? "entry" : "entries"}</p>{/if}
{/if}
