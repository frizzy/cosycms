<script lang="ts">
  import GearIcon from "./GearIcon.svelte";
  import PlusIcon from "./PlusIcon.svelte";
  import { dataSchema, entryLabel } from "../src/fields";
  import { api, type Entry } from "./api";
  import { blobUrl } from "../src/images";
  import { tick } from "svelte";
  import { refreshCounts, store } from "./store.svelte";
  import { toast } from "./toast.svelte";
  import { ask } from "./confirm.svelte";
  import LiveIcon from "./LiveIcon.svelte";
  import ClockIcon from "./ClockIcon.svelte";
  let { collection }: { collection: string } = $props();
  const col = $derived(store.collections.find((c) => c.key === collection)!);
  const schema = $derived(dataSchema(col));

  // List or grid (grid only where entries have a thumbnail), remembered per collection in this browser.
  const KEY = $derived(`cosy.view.${collection}`);
  const stored = () => { try { return localStorage.getItem(KEY) === "grid"; } catch { return false; } };
  let chosen = $state(stored());
  $effect(() => { chosen = stored(); });
  const grid = $derived(chosen && !!col.thumbField);
  function setView(g: boolean) { chosen = g; try { localStorage.setItem(KEY, g ? "grid" : "list"); } catch {} }

  // Filters, remembered per collection: status ones everywhere, plus "no <field>" for optional fields that can be left empty.
  const FKEY = $derived(`cosy.filter.${collection}`);
  const filters = $derived([
    { value: "", text: "All" }, { value: "attention", text: "Needs publishing" }, { value: "draft", text: "Drafts" }, { value: "edited", text: "Edited" }, ...(col.dates ? [{ value: "scheduled", text: "Scheduled" }] : []),
    ...col.fields.filter((f) => !f.required && ["text", "textarea", "url", "reference", "file"].includes(f.type)).map((f) => ({ value: `empty:${f.key}`, text: `No ${f.label.toLowerCase()}` })),
  ]);
  const storedFilter = () => { try { return localStorage.getItem(FKEY) ?? ""; } catch { return ""; } };
  let chosenFilter = $state(storedFilter());
  $effect(() => { chosenFilter = storedFilter(); });
  const filter = $derived(filters.some((f) => f.value === chosenFilter) ? chosenFilter : "");
  function setFilter(v: string) { chosenFilter = v; try { v ? localStorage.setItem(FKEY, v) : localStorage.removeItem(FKEY); } catch {} }

  // Owner-only, run by hand: entries no other entry points at, shown in place of the list (the scan reads every entry, so it is never automatic).
  let unused = $state<Awaited<ReturnType<typeof api.unused>>>(), scanning = $state(false);
  $effect(() => { collection; unused = undefined; });
  async function scan() {
    scanning = true; error = "";
    try { unused = await api.unused(collection); } catch (e) { error = (e as Error).message; }
    scanning = false;
  }

  // The list is searched and sorted on the server and grows as you scroll: each batch is fetched when the end comes near.
  const BATCH = 50;
  let q = $state(""), sort = $state("updated"), dir = $state<"asc" | "desc">("desc");
  let rows = $state<Entry[] | undefined>(), total = $state(0), error = $state(""), busy = $state(false), loadingMore = $state(false);
  let gen = 0; // bumped whenever the list is reloaded, so a batch still in flight for the old list is dropped
  const query = () => ({ q: q.trim(), sort, dir, limit: BATCH, filter });

  /** Fetches batches until at least `until` rows are loaded (or just the next one). */
  async function loadMore(until = 0) {
    if (!rows || loadingMore || rows.length >= total) return;
    loadingMore = true;
    const g = gen;
    try {
      do {
        const r: { items: Entry[]; total: number } = await api.search(collection, { ...query(), offset: rows!.length });
        if (g !== gen) return;
        const have: Entry[] = rows!, seen = new Set<string>(have.map((e) => e.id));
        rows = [...have, ...r.items.filter((e) => !seen.has(e.id))]; total = r.total;
        if (!r.items.length) break;
      } while (rows.length < until && rows.length < total);
    } catch (e) { if (g === gen) error = (e as Error).message; }
    finally { if (g === gen) loadingMore = false; }
  }

  // Coming back from an entry puts the list where it was: how much was loaded and how far it was scrolled, kept for this tab only.
  const POS = $derived(`cosy.pos.${collection}`);
  const sig = () => `${filter}|${q.trim()}|${sort}|${dir}`;
  function remember() { try { sessionStorage.setItem(POS, JSON.stringify({ n: rows?.length ?? 0, y: scrollY, sig: sig(), at: Date.now() })); } catch {} }
  function recall(): { n: number; y: number } | null {
    try { const v = JSON.parse(sessionStorage.getItem(POS) ?? "null"); sessionStorage.removeItem(POS); return v && v.sig === sig() && Date.now() - v.at < 30 * 60_000 ? v : null; } catch { return null; }
  }

  // Selection for bulk actions. It is cleared whenever the search, filter or sort changes, so an action never reaches an entry that isn't on screen.
  let sel = $state<string[]>([]), reload = $state(0), working = $state(false), failed = $state<{ id: string; label: string; error: string }[]>([]);
  const toggle = (id: string) => (sel = sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id]);
  const verb = { publish: "Published", unpublish: "Unpublished", delete: "Deleted" } as const;
  async function bulk(action: "publish" | "unpublish" | "delete") {
    const n = sel.length, what = `${n} ${n === 1 ? "entry" : "entries"}`;
    const ask_ = { publish: { title: `Publish ${what}?`, message: "Each goes live on the next Deploy.", confirm: "Publish" },
      unpublish: { title: `Take ${what} off the site?`, message: "The drafts stay. They come off the site on the next Deploy.", confirm: "Unpublish" },
      delete: { title: `Delete ${what}?`, message: "They move to the Trash, where they can be restored for a while. Entries still linked from elsewhere are skipped.", confirm: "Delete", danger: true } }[action];
    if (!(await ask(ask_))) return;
    working = true; error = "";
    try {
      const r = await api.bulk(sel, action);
      failed = r.failed;
      if (r.done) toast(`${verb[action]} ${r.done} ${r.done === 1 ? "entry" : "entries"}`);
      reload++; refreshCounts();
    } catch (e) { error = (e as Error).message; }
    working = false;
  }

  let first = true; // the first load is immediate and may restore a position; typing is debounced
  $effect(() => {
    query(); reload; filter; collection;
    const keep = reload && rows ? rows.length : 0, was = first ? recall() : null;
    sel = []; if (!reload) failed = [];
    let stale = false;
    const t = setTimeout(async () => {
      busy = true; const g = ++gen; loadingMore = false;
      try {
        const r = await api.search(collection, { ...query(), offset: 0 });
        if (stale || g !== gen) return;
        // A single-entry collection has no list worth showing: go to its entry (or to the form for it).
        if (col.single && !q.trim() && !filter && r.total <= 1) { location.replace(r.total ? `#/${collection}/${r.items[0].id}` : `#/${collection}/new`); return; }
        rows = r.items; total = r.total; error = "";
        const want = Math.max(keep, was?.n ?? 0);
        if (want > rows.length) await loadMore(Math.min(want, 1000));
        if (was) { await tick(); scrollTo(0, was.y); }
      } catch (e) { if (!stale) error = (e as Error).message; }
      busy = false;
    }, first ? 0 : 250);
    first = false;
    return () => { stale = true; clearTimeout(t); };
  });

  // Load the next batch when the end of the list comes near. Observing again after every batch covers a batch that doesn't fill the screen.
  let sentinel = $state<HTMLElement>();
  $effect(() => {
    rows?.length; if (!sentinel) return;
    const io = new IntersectionObserver((e) => { if (e[0].isIntersecting) loadMore(); }, { rootMargin: "800px" });
    io.observe(sentinel);
    return () => io.disconnect();
  });

  // The scroll bar: the whole list as a track, what is loaded shaded, and the part on screen as the handle. Drag or click to jump.
  let listEl = $state<HTMLElement>(), track = $state<HTMLElement>(), navH = $state(0), headH = $state(0), headEl = $state<HTMLElement>();
  let vis = $state({ top: 0, size: 1 }), bubble = $state<{ y: number; text: string } | null>(null), dragging = false;
  const stick = $derived(navH + headH);
  $effect(() => {
    const nav = document.querySelector("nav"), mq = matchMedia("(max-width:760px)");
    const m = () => { navH = mq.matches && nav ? nav.getBoundingClientRect().height : 0; headH = headEl?.getBoundingClientRect().height ?? 0; };
    m();
    const ro = new ResizeObserver(m);
    if (nav) ro.observe(nav);
    if (headEl) ro.observe(headEl);
    return () => ro.disconnect();
  });
  function measure() {
    if (!listEl || !rows?.length || !total) return;
    const r = listEl.getBoundingClientRect(), frac = rows.length / total;
    const a = Math.min(1, Math.max(0, (stick - r.top) / r.height)), b = Math.min(1, Math.max(a, (innerHeight - r.top) / r.height));
    vis = { top: a * frac, size: Math.max(0.02, (b - a) * frac) };
  }
  $effect(() => { rows?.length; total; stick; listEl; tick().then(measure); });
  const showTrack = $derived(!unused && total > BATCH);
  const hint = (i: number) => {
    const e = rows?.[Math.min(i, (rows?.length ?? 1) - 1)];
    if (!e || i >= (rows?.length ?? 0)) return "";
    return sort === "updated" ? new Date(e.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : sort === "status" ? (e.published ? "Published" : "Draft") : (label(e)[0] ?? "").toUpperCase();
  };
  function point(e: PointerEvent) {
    const r = track!.getBoundingClientRect(), f = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)), i = Math.round(f * total);
    bubble = { y: e.clientY - r.top, text: `${Math.min(total, i + 1)} of ${total}${hint(i) ? ` · ${hint(i)}` : ""}` };
    return f;
  }
  async function jump(f: number) {
    const start = Math.round(Math.min(Math.max(0, f - vis.size / 2), 1 - vis.size) * total);
    if (start >= (rows?.length ?? 0) && !loadingMore) await loadMore(start + BATCH);
    if (!listEl || !rows?.length) return;
    const r = listEl.getBoundingClientRect(), idx = Math.min(start, rows.length - 1);
    scrollTo({ top: scrollY + r.top + (idx / rows.length) * r.height - stick, behavior: "instant" });
  }

  const shown = $derived(unused ? unused.items : rows);
  const titled = $derived(!!col.titleField);
  const nameCol = $derived(titled ? "title" : "slug");
  function sortBy(key: string) {
    if (sort === key) dir = dir === "asc" ? "desc" : "asc";
    else { sort = key; dir = key === "updated" ? "desc" : "asc"; }
  }
  const aria = (key: string) => (sort === key ? (dir === "asc" ? "ascending" : "descending") : "none");
  const label = (e: Entry) => (titled ? entryLabel(col.fields, e.data, e.slug, col.titleField) : e.slug);
  const soon = (e: Entry) => e.schedule && (e.schedule.failed ? "Schedule failed: " + e.schedule.error : "Goes live " + when(e.schedule.at));
  const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
</script>

<header>
  <span class="titlebar"><h1>{col.label}</h1>{#if store.me?.role === "owner"}<a class="icon-btn quiet" href="#/collections/{col.key}" aria-label="Collection settings" title="Collection settings"><GearIcon /></a>{/if}</span>
  {#if !(col.single && total)}<a class="icon-btn" href="#/{collection}/new" aria-label="New entry" title="New entry"><PlusIcon /></a>{/if}
</header>

<div class="listhead" bind:this={headEl}>
<div class="listbar">
  <input type="search" class="search" placeholder="Search {col.label.toLowerCase()}" aria-label="Search entries" bind:value={q} />
  <select aria-label="Filter" value={filter} onchange={(e) => setFilter(e.currentTarget.value)}>{#each filters as f (f.value)}<option value={f.value}>{f.text}</option>{/each}</select>
  {#if col.thumbField}
    {#if grid}<select aria-label="Sort by" value={sort} onchange={(e) => { sort = e.currentTarget.value; dir = sort === "updated" ? "desc" : "asc"; }}><option value="updated">Updated</option><option value={nameCol}>{titled ? "Title" : "Slug"}</option><option value="status">Status</option></select>{/if}
    {#if store.me?.role === "owner"}<button type="button" class="ghost" aria-pressed={!!unused} onclick={scan} disabled={scanning} title="List entries that no other entry links to. Reads everything, so it runs only when you ask.">{scanning ? "Scanning…" : "Find unlinked"}</button>{/if}
    <div class="seg" role="group" aria-label="View"><button type="button" class="ghost" aria-pressed={!grid} aria-label="List view" title="List view" onclick={() => setView(false)}><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" /></svg></button><button type="button" class="ghost" aria-pressed={grid} aria-label="Grid view" title="Grid view" onclick={() => setView(true)}><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="4" width="6.5" height="6.5" rx="1" /><rect x="13.5" y="4" width="6.5" height="6.5" rx="1" /><rect x="4" y="13.5" width="6.5" height="6.5" rx="1" /><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1" /></svg></button></div>
  {/if}
</div>

{#if unused}
  <p class="notice scanned">{unused.total ? `${unused.total} of ${unused.scanned} aren't linked from any other entry` : `Everything is linked from somewhere (${unused.scanned} checked)`}.{#if unused.total > unused.items.length} Showing the {unused.items.length} most recently updated.{/if}
    <button type="button" class="ghost" onclick={() => (unused = undefined)}>Show all</button></p>
{/if}

{#if sel.length}
  <div class="bulkbar" role="toolbar" aria-label="Actions for the selection">
    <strong>{sel.length} selected</strong>
    <button type="button" class="ghost" disabled={working} onclick={() => (sel = shown?.map((e) => e.id) ?? [])}>Select all loaded</button>
    <span class="spacer"></span>
    <button type="button" disabled={working} onclick={() => bulk("publish")}>Publish</button>
    <button type="button" class="ghost" disabled={working} onclick={() => bulk("unpublish")}>Unpublish</button>
    <button type="button" class="danger" disabled={working} onclick={() => bulk("delete")}>Delete</button>
    <button type="button" class="ghost" disabled={working} onclick={() => (sel = [])}>Clear</button>
  </div>
{/if}
</div>
{#if failed.length}
  <div class="notice bulkfail"><p><strong>{failed.length} couldn't be done:</strong></p>
    <ul>{#each failed as f (f.id)}<li><a href="#/{collection}/{f.id}">{f.label}</a>: {f.error}</li>{/each}</ul>
    <button type="button" class="ghost" onclick={() => (failed = [])}>Dismiss</button></div>
{/if}

{#if error}<p class="error">{error}</p>
{:else if !shown}
  <div class="stack" aria-busy="true" aria-label="Loading">{#each [1, 2, 3, 4] as _}<div class="skel" style="height:44px"></div>{/each}</div>
{:else}
  {#if grid}
    <div class="grid" class:busy bind:this={listEl} onclick={remember} role="presentation">
      {#each shown as e (e.id)}
        <div class="gwrap"><input type="checkbox" class="pick" aria-label="Select {label(e)}" checked={sel.includes(e.id)} onchange={() => toggle(e.id)} />
        <a class="gtile" href="#/{collection}/{e.id}" title={label(e)}>
          {#if e.thumb}<img src={blobUrl(e.thumb)} alt="" loading="lazy" />{:else}<span class="noimg"></span>{/if}
          <span class="cap"><span class="ell">{label(e)}</span>{#if e.schedule}<span class="sched" class:failed={e.schedule.failed} title={soon(e)}><ClockIcon /></span>{/if}{#if e.published}<span class:edited={e.pending} title={e.pending ? "Published, with draft changes" : "Published"}><LiveIcon /></span>{/if}</span>
        </a></div>
      {:else}
        <p class="empty">{#if q.trim() || filter}No entries match{q.trim() ? ` “${q.trim()}”` : ""}{filter ? " this filter" : ""}.{:else}Nothing here yet. <a href="#/{collection}/new">Create the first entry.</a>{/if}</p>
      {/each}
    </div>
  {:else}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
  <table class="list" class:busy style="--stick:{stick}px" bind:this={listEl} onclick={remember}>
    <thead><tr>
      <th class="c-pick"><input type="checkbox" class="pick" aria-label="Select all loaded" checked={!!shown?.length && sel.length === shown.length} onchange={(e) => (sel = e.currentTarget.checked ? shown?.map((x) => x.id) ?? [] : [])} /></th>
      {#each [[nameCol, titled ? "Title" : "Slug"], ["status", "Status"], ["updated", "Updated"]] as [key, text] (key)}
        <th aria-sort={aria(key)} class="c-{key}">
          <button type="button" class="sort" onclick={() => sortBy(key)}>{text}<span aria-hidden="true">{sort === key ? (dir === "asc" ? "▲" : "▼") : ""}</span></button>
        </th>
      {/each}
    </tr></thead>
    <tbody>
      {#each shown as e (e.id)}
        <tr class:picked={sel.includes(e.id)}>
          <td class="c-pick"><input type="checkbox" class="pick" aria-label="Select {label(e)}" checked={sel.includes(e.id)} onchange={() => toggle(e.id)} /></td>
          <td class="name"><div class="cell">
            {#if col.thumbField}{#if e.thumb}<img class="thumb" src={blobUrl(e.thumb)} alt="" loading="lazy" />{:else}<span class="thumb none" aria-hidden="true"></span>{/if}{/if}
            <a class="ell" href="#/{collection}/{e.id}" title={label(e)}>{label(e)}</a>
            {#if e.schedule}<span class="sched" class:failed={e.schedule.failed} title={soon(e)}><ClockIcon />{e.schedule.failed ? "Schedule failed" : when(e.schedule.at)}</span>{/if}
            {#if !schema.safeParse(e.data).success}<span class="warn" title="Doesn't match the current fields — open and fix it">⚠ needs attention</span>{/if}
          </div></td>
          <td class="c-status">{#if e.published}<span class:edited={e.pending} title={e.pending ? "Published, with changes in the draft that aren't live yet" : "Has a published version"}><LiveIcon />{e.pending ? "Edited" : "Published"}</span>{:else}Draft{/if}</td><td class="c-updated">{when(e.updatedAt)}</td>
        </tr>
      {:else}
        <tr><td colspan="4" class="empty">
          {#if q.trim() || filter}No entries match{q.trim() ? ` “${q.trim()}”` : ""}{filter ? " this filter" : ""}.{:else}Nothing here yet. <a href="#/{collection}/new">Create the first entry.</a>{/if}
        </td></tr>
      {/each}
    </tbody>
  </table>
  {/if}
  {#if !unused}
    <div bind:this={sentinel} aria-hidden="true"></div>
    {#if rows && total}<p class="muted count">{rows.length < total ? `Showing ${rows.length} of ${total}` : `${total} ${total === 1 ? "entry" : "entries"}`}{#if loadingMore}{" · loading…"}{:else if rows.length < total}{" · "}<button type="button" class="ghost more" onclick={() => loadMore()}>Load more</button>{/if}</p>{/if}
  {/if}
{/if}

<svelte:window onscroll={measure} onresize={measure} />
{#if showTrack}
  <div class="scrub" role="presentation" bind:this={track} style="top:{stick + 8}px"
    onpointerdown={(e) => { dragging = true; track?.setPointerCapture(e.pointerId); jump(point(e)); }}
    onpointermove={(e) => { const f = point(e); if (dragging) jump(f); }}
    onpointerup={() => (dragging = false)} onpointercancel={() => (dragging = false)} onpointerleave={() => { if (!dragging) bubble = null; }}>
    <div class="scrub-loaded" style="height:{(rows ? rows.length / total : 0) * 100}%"></div>
    <div class="scrub-handle" style="top:{vis.top * 100}%;height:{vis.size * 100}%"></div>
    {#if bubble}<div class="scrub-bubble" style="top:{bubble.y}px">{bubble.text}</div>{/if}
  </div>
{/if}
