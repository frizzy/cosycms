<script lang="ts">
  import { api, type Hit } from "./api";
  import { store } from "./store.svelte";
  import { entryLabel } from "../src/fields";
  import { pieces } from "./highlight";
  import { settingsTabs } from "./settingsTabs";
  import { recents, type Recent } from "./recent";

  let { onDeploy }: { onDeploy: () => void } = $props();
  type Item = { id: string; label: string; hint: string; go: () => void };
  let dlg = $state<HTMLDialogElement>(), input = $state<HTMLInputElement>(), shown = $state(false);
  let q = $state(""), hits = $state<Hit[]>([]), sel = $state(0);
  const portal = (node: HTMLElement) => { document.body.appendChild(node); return { destroy: () => node.remove() }; };
  const owner = $derived(store.me?.role === "owner");

  export function show() { q = ""; hits = []; sel = 0; recent = recents(); shown = true; }
  function close() { shown = false; }
  $effect(() => { if (shown && dlg && !dlg.open) { dlg.showModal(); input?.focus(); } });

  // Pages and actions, filtered by the words typed.
  const to = (hash: string) => () => { location.hash = hash; };
  const pages = $derived<Item[]>([
    { id: "ov", label: "Overview", hint: "Page", go: to("#/") },
    ...store.collections.map((c) => ({ id: `c-${c.key}`, label: c.label, hint: "Collection", go: to(`#/${c.key}`) })),
    ...store.collections.filter((c) => !c.single).map((c) => ({ id: `n-${c.key}`, label: `New entry in ${c.label}`, hint: "Create", go: to(`#/${c.key}/new`) })),
    { id: "deploy", label: "Deploy to the site", hint: "Action", go: onDeploy },
    { id: "sched", label: "Schedule", hint: "Page", go: to("#/schedule") },
    { id: "notif", label: "Notifications", hint: "Page", go: to("#/notifications") },
    { id: "act", label: "Activity", hint: "Page", go: to("#/activity") },
    { id: "trash", label: "Trash", hint: "Page", go: to("#/trash") },
    ...(owner ? [
      { id: "mh", label: "Media health", hint: "Page", go: to("#/media-health") },
      { id: "blocks", label: "Blocks", hint: "Page", go: to("#/blocks") }, { id: "tpl", label: "Templates", hint: "Page", go: to("#/templates") },
      { id: "newc", label: "New collection", hint: "Create", go: to("#/collections/new") },
      ...store.collections.map((c) => ({ id: `cs-${c.key}`, label: `Collection settings: ${c.label}`, hint: "Settings", go: to(`#/collections/${c.key}`) })),
    ] : []),
    ...settingsTabs(owner).map((t) => ({ id: `s-${t.id}`, label: t.id === "apps" ? "Connected apps" : `Settings: ${t.label}`, hint: "Settings", go: to(`#/settings/${t.id}`) })),
  ]);
  const words = $derived(q.toLowerCase().split(/\s+/).filter(Boolean));
  let recent = $state<Recent[]>([]);
  const openId = () => location.hash.split("/")[2];
  // With nothing typed, the entries opened lately come first, so ⌘K then Enter goes back to what you were editing (not the one already open).
  const recentItems = $derived<Item[]>(words.length ? [] : recent.filter((r) => r.id !== openId()).slice(0, 5).map((r) => ({ id: `r-${r.id}`, label: r.title, hint: `Recent · ${store.collections.find((c) => c.key === r.collection)?.label ?? r.collection}`, go: to(`#/${r.collection}/${r.id}`) })));
  const matchedPages = $derived(pages.filter((p) => words.every((w) => p.label.toLowerCase().includes(w))).slice(0, words.length ? 6 : 8));
  const contentItems = $derived<(Item & { hit: Hit })[]>(hits.map((h) => {
    const c = store.collections.find((x) => x.key === h.collection);
    return { id: `e-${h.id}`, label: c ? entryLabel(c.fields, h.data, h.slug, c.titleField) : h.slug, hint: c?.label ?? h.collection, go: to(`#/${h.collection}/${h.id}`), hit: h };
  }));
  // A page or action that matches every word typed is probably what was meant ("new po"), so those come first, then content.
  const all = $derived<Item[]>([...recentItems, ...matchedPages, ...contentItems]);

  $effect(() => {
    const query = q.trim();
    if (!shown || !query) { hits = []; return; }
    let stale = false;
    const t = setTimeout(() => api.find(query, 6).then((r) => { if (!stale) hits = r.items; }, () => {}), 150);
    return () => { stale = true; clearTimeout(t); };
  });
  $effect(() => { all.length; if (sel >= all.length) sel = Math.max(0, all.length - 1); });
  $effect(() => { document.getElementById(`pal-${sel}`)?.scrollIntoView({ block: "nearest" }); });

  function pick(i: number) { const it = all[i]; if (!it) return; close(); it.go(); }
  function onkeydown(e: KeyboardEvent) {
    if (e.key === "ArrowDown") { e.preventDefault(); sel = all.length ? (sel + 1) % all.length : 0; }
    else if (e.key === "ArrowUp") { e.preventDefault(); sel = all.length ? (sel + all.length - 1) % all.length : 0; }
    else if (e.key === "Enter") { e.preventDefault(); pick(sel); }
    else if (e.key === "Escape") { e.preventDefault(); close(); } // a search input would otherwise clear its text first and swallow the key
  }
</script>

{#if shown}
  <dialog bind:this={dlg} use:portal class="palette" aria-label="Search and jump" onclose={close} onclick={(e) => { if (e.target === dlg) close(); }}>
    <input bind:this={input} bind:value={q} {onkeydown} type="search" placeholder="Search content, or jump to a page" role="combobox" aria-expanded="true" aria-controls="pal-list" aria-activedescendant="pal-{sel}" aria-label="Search" />
    <ul id="pal-list" role="listbox">
      {#each all as it, i (it.id)}
        <!-- Keyboard use is on the input (combobox pattern); the options themselves are not focusable. -->
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <li id="pal-{i}" role="option" aria-selected={i === sel} class:on={i === sel} onpointermove={() => (sel = i)} onclick={() => pick(i)}>
          <span class="grow">
            <span class="title">{#if "hit" in it}{#each pieces((it as Item & { hit: Hit }).hit.match.title) as p}{#if p.hit}<mark>{p.t}</mark>{:else}{p.t}{/if}{/each}{:else}{it.label}{/if}</span>
            {#if "hit" in it && (it as Item & { hit: Hit }).hit.match.snippet}<span class="snip">{#each pieces((it as Item & { hit: Hit }).hit.match.snippet!) as p}{#if p.hit}<mark>{p.t}</mark>{:else}{p.t}{/if}{/each}</span>{/if}
          </span>
          <span class="meta">{it.hint}</span>
        </li>
      {:else}<li class="none">Nothing matches “{q.trim()}”.</li>{/each}
    </ul>
  </dialog>
{/if}
