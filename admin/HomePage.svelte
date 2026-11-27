<script lang="ts">
  import { api, type Entry, type Hit } from "./api";
  import { store } from "./store.svelte";
  import { entryLabel, type Collection } from "../src/fields";
  import { blobUrl } from "../src/images";
  import { pieces } from "./highlight";
  import ClockIcon from "./ClockIcon.svelte";

  let q = $state(""), hits = $state<Hit[]>([]), total = $state(0), recent = $state<Entry[]>([]), loading = $state(true), error = $state(""), input = $state<HTMLInputElement>();
  let queued = $state<Awaited<ReturnType<typeof api.schedule>>>([]);
  const owner = $derived(store.me?.role === "owner");
  const col = (e: Entry) => store.collections.find((c) => c.key === e.collection) as Collection | undefined;

  $effect(() => { api.recent(10).then((r) => { recent = r.items; loading = false; }, (e) => { error = e.message; loading = false; }); });
  // Full-text search over every entry, bodies included (see /search); nothing typed shows the latest changes instead.
  $effect(() => {
    const query = q.trim();
    if (!query) { hits = []; return; }
    let stale = false;
    const t = setTimeout(() => api.find(query, 20).then((r) => { if (!stale) { hits = r.items; total = r.total; error = ""; } }, (e) => { if (!stale) error = e.message; }), 200);
    return () => { stale = true; clearTimeout(t); };
  });
  $effect(() => { if (owner) api.schedule().then((r) => (queued = r.filter((j) => j.kind === "entry.publish" || j.kind === "entry.unpublish")), () => {}); });
  $effect(() => { if (input && matchMedia("(pointer: fine)").matches) input.focus(); }); // not on a phone: the keyboard would cover the page

  const title = (e: Entry) => { const c = col(e); return c ? entryLabel(c.fields, e.data, e.slug, c.titleField) : e.slug; };
  const status = (e: Entry) => (!e.published ? "Draft" : e.pending ? "Edited" : "Published");
  const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  const onkeydown = (ev: KeyboardEvent) => { if (ev.key === "Enter" && q.trim() && hits[0]) location.hash = `#/${hits[0].collection}/${hits[0].id}`; };
</script>

{#snippet row(e: Entry, h?: Hit)}
  {@const c = col(e)}
  <li><a href="#/{e.collection}/{e.id}">
    {#if c?.thumbField}{#if e.thumb}<img src={blobUrl(e.thumb)} alt="" loading="lazy" />{:else}<span class="ph"></span>{/if}{/if}
    <span class="grow">
      <span class="title">{#if h}{#each pieces(h.match.title) as p}{#if p.hit}<mark>{p.t}</mark>{:else}{p.t}{/if}{/each}{:else}{title(e)}{/if}</span>
      {#if h?.match.snippet}<span class="snip">{#each pieces(h.match.snippet) as p}{#if p.hit}<mark>{p.t}</mark>{:else}{p.t}{/if}{/each}</span>{/if}
    </span>
    {#if e.schedule}<span class="sched" class:failed={e.schedule.failed} title={e.schedule.failed ? "Schedule failed" : `Goes live ${when(e.schedule.at)}`}><ClockIcon /></span>{/if}
    {#if e.takeDown}<span class="sched" class:failed={e.takeDown.failed} title={e.takeDown.failed ? "Take-down failed" : `Comes off ${when(e.takeDown.at)}`}><ClockIcon /></span>{/if}
    <span class="meta">{c?.label ?? e.collection} · {status(e)}{h ? "" : ` · ${when(e.updatedAt)}`}</span>
  </a></li>
{/snippet}

<header><h1>Overview</h1></header>
<input type="search" class="home-search" placeholder="Search everything, bodies included" aria-label="Search all content" bind:value={q} bind:this={input} {onkeydown} />

{#if error}<p class="error">{error}</p>
{:else if q.trim()}
  {#if hits.length}
    <section class="hits-group">
      <h2>{total} match{total === 1 ? "" : "es"}{#if total > hits.length} <small class="muted">showing the best {hits.length}</small>{/if}</h2>
      <ul class="hits">{#each hits as h (h.id)}{@render row(h, h)}{/each}</ul>
    </section>
  {:else}<p class="muted">Nothing matches “{q.trim()}”.</p>{/if}
{:else if loading}<div class="stack" aria-busy="true" aria-label="Loading"><div class="skel" style="height:44px"></div><div class="skel" style="height:44px"></div></div>
{:else}
  {#if queued.length}
    <section class="hits-group">
      <h2>Scheduled</h2>
      <ul class="hits">
        {#each queued as j}<li><a href={j.entry ? `#/${j.entry.collection}/${j.entry.id}` : "#/activity"}>
          <span class="sched" class:failed={j.status === "failed"}><ClockIcon /></span><span class="grow"><span class="title">{j.entry?.label ?? "An entry"}</span></span>
          <span class="meta">{j.status === "failed" ? "Schedule failed" : j.kind === "entry.unpublish" ? `Comes off ${when(j.at)}` : `Goes live ${when(j.at)}`}</span></a></li>{/each}
      </ul>
    </section>
  {/if}
  <section class="hits-group">
    <h2>Recent changes</h2>
    {#if recent.length}<ul class="hits">{#each recent as e (e.id)}{@render row(e)}{/each}</ul>
    {:else}<p class="muted">{store.collections.length ? "Nothing here yet. Open a collection to add your first entry." : "No collections yet."}{#if owner} <a href="#/collections/new">Create a collection</a>{/if}</p>{/if}
  </section>
  <p class="muted tip">Tip: press Ctrl or ⌘ + K anywhere to search and jump around.</p>
{/if}
