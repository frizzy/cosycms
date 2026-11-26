<script lang="ts">
  import { api, type Entry } from "./api";
  import { store } from "./store.svelte";
  import { entryLabel, type Collection } from "../src/fields";
  import { blobUrl } from "../src/images";
  import ClockIcon from "./ClockIcon.svelte";

  type Group = { col: Collection; total: number; items: Entry[] };
  let q = $state(""), groups = $state<Group[]>([]), loading = $state(true), error = $state(""), input = $state<HTMLInputElement>();
  let queued = $state<Awaited<ReturnType<typeof api.schedule>>>([]);
  const owner = $derived(store.me?.role === "owner");

  // Searches every collection with the list's own search; with nothing typed it is each collection's latest changes.
  // shortcut: one request per collection, fine for a handful; add a single server-side search past ~15 collections.
  $effect(() => {
    const query = q.trim(), cols = store.collections;
    let stale = false;
    const t = setTimeout(async () => {
      try {
        const all = await Promise.all(cols.map(async (col) => ({ col, ...(await api.search(col.key, { q: query, sort: "updated", dir: "desc", limit: query ? 6 : 8, offset: 0 })) })));
        if (!stale) { groups = all.filter((g) => g.items.length); error = ""; loading = false; }
      } catch (e) { if (!stale) { error = (e as Error).message; loading = false; } }
    }, q ? 250 : 0);
    return () => { stale = true; clearTimeout(t); };
  });
  $effect(() => { if (owner) api.schedule().then((r) => (queued = r.filter((j) => j.kind === "entry.publish")), () => {}); });
  $effect(() => { if (input && matchMedia("(pointer: fine)").matches) input.focus(); }); // not on a phone: the keyboard would cover the page

  const recent = $derived(groups.flatMap((g) => g.items.map((e) => ({ e, col: g.col }))).sort((a, b) => b.e.updatedAt.localeCompare(a.e.updatedAt)).slice(0, 10));
  const title = (e: Entry, col: Collection) => entryLabel(col.fields, e.data, e.slug, col.titleField);
  const status = (e: Entry) => (!e.published ? "Draft" : e.pending ? "Edited" : "Published");
  const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  function onkeydown(ev: KeyboardEvent) {
    const first = groups[0]?.items[0];
    if (ev.key === "Enter" && q.trim() && first) location.hash = `#/${groups[0].col.key}/${first.id}`;
  }
</script>

{#snippet row(e: Entry, col: Collection)}
  <li><a href="#/{col.key}/{e.id}">
    {#if col.thumbField}{#if e.thumb}<img src={blobUrl(e.thumb)} alt="" loading="lazy" />{:else}<span class="ph"></span>{/if}{/if}
    <span class="title">{title(e, col)}</span>
    {#if e.schedule}<span class="sched" class:failed={e.schedule.failed} title={e.schedule.failed ? "Schedule failed" : `Goes live ${when(e.schedule.at)}`}><ClockIcon /></span>{/if}
    <span class="meta">{col.label} · {status(e)} · {when(e.updatedAt)}</span>
  </a></li>
{/snippet}

<header><h1>Overview</h1></header>
<input type="search" class="home-search" placeholder="Search everything" aria-label="Search all content" bind:value={q} bind:this={input} {onkeydown} />

{#if error}<p class="error">{error}</p>
{:else if loading}<div class="stack" aria-busy="true" aria-label="Loading"><div class="skel" style="height:44px"></div><div class="skel" style="height:44px"></div></div>
{:else if q.trim()}
  {#each groups as g (g.col.key)}
    <section class="hits-group">
      <h2>{g.col.label} <small class="muted">{g.total}</small>{#if g.total > g.items.length} <a class="more" href="#/{g.col.key}">See all</a>{/if}</h2>
      <ul class="hits">{#each g.items as e (e.id)}{@render row(e, g.col)}{/each}</ul>
    </section>
  {:else}<p class="muted">Nothing matches “{q.trim()}”.</p>{/each}
{:else}
  {#if queued.length}
    <section class="hits-group">
      <h2>Scheduled</h2>
      <ul class="hits">
        {#each queued as j}<li><a href={j.entry ? `#/${j.entry.collection}/${j.entry.id}` : "#/activity"}>
          <span class="sched" class:failed={j.status === "failed"}><ClockIcon /></span><span class="title">{j.entry?.label ?? "An entry"}</span>
          <span class="meta">{j.status === "failed" ? "Schedule failed" : `Goes live ${when(j.at)}`}</span></a></li>{/each}
      </ul>
    </section>
  {/if}
  <section class="hits-group">
    <h2>Recent changes</h2>
    {#if recent.length}<ul class="hits">{#each recent as r (r.e.id)}{@render row(r.e, r.col)}{/each}</ul>
    {:else}<p class="muted">{store.collections.length ? "Nothing here yet. Open a collection to add your first entry." : "No collections yet."}{#if owner} <a href="#/collections/new">Create a collection</a>{/if}</p>{/if}
  </section>
{/if}
