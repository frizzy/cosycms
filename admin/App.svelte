<script lang="ts">
  import { api } from "./api";
  import { store, refreshCollections, refreshCounts, refreshUnread } from "./store.svelte";
  import EntryList from "./EntryList.svelte";
  import EntryEditor from "./EntryEditor.svelte";
  import CollectionBuilder from "./CollectionBuilder.svelte";
  import BlockList from "./BlockList.svelte";
  import BlockBuilder from "./BlockBuilder.svelte";
  import BlocksIcon from "./BlocksIcon.svelte";
  import Logo from "./Logo.svelte";
  import Lightbox from "./Lightbox.svelte";
  import DeployDialog from "./DeployDialog.svelte";
  import TemplatesIcon from "./TemplatesIcon.svelte";
  import TemplateList from "./TemplateList.svelte";
  import TemplateBuilder from "./TemplateBuilder.svelte";
  import SettingsPage from "./SettingsPage.svelte";
  import ActivityPage from "./ActivityPage.svelte";
  import ActivityIcon from "./ActivityIcon.svelte";
  import BellIcon from "./BellIcon.svelte";
  import NotificationsPage from "./NotificationsPage.svelte";
  import Login from "./Login.svelte";
  import Toasts from "./Toasts.svelte";
  import ThemeToggle from "./ThemeToggle.svelte";
  import GearIcon from "./GearIcon.svelte";
  import LogoutIcon from "./LogoutIcon.svelte";
  import PlusIcon from "./PlusIcon.svelte";
  import { toast } from "./toast.svelte";
  import "./app.css";

  // Hash routes: #/<collection>, #/<collection>/new, #/<collection>/<id>, #/collections/<key|new>, #/settings
  let hash = $state(location.hash);
  const owner = $derived(store.me?.role === "owner");
  let menuOpen = $state(false); // phone width: the menu is a dropdown behind the hamburger
  $effect(() => {
    // Covers link clicks and back/forward alike: if the open editor has unsaved work, ask first, and put the hash back on "stay".
    let prev = location.hash, reverting = false;
    const on = () => {
      if (reverting) { reverting = false; return; }
      if (store.dirty && !confirm("You have unsaved changes. Leave without saving?")) { reverting = true; location.hash = prev; return; }
      prev = hash = location.hash;
      menuOpen = false;
      if (store.me) { refreshCounts(); refreshUnread(); }
    };
    addEventListener("hashchange", on);
    api.me().then((me) => (store.me = me));
    return () => removeEventListener("hashchange", on);
  });
  $effect(() => { if (store.me) { refreshCollections(); refreshCounts(); refreshUnread(); } });
  // Builds finish and jobs fail while nobody is looking: check for new notifications now and then.
  $effect(() => { if (!store.me) return; const t = setInterval(refreshUnread, 60_000); return () => clearInterval(t); });
  // First run: an owner with no social sign-in yet is taken to set one up, and reminded until they do.
  $effect(() => {
    if (store.me?.role !== "owner") return;
    api.authInfo().then((i) => {
      store.signIn = i.providers.length;
      if (!i.providers.length && (location.hash === "" || location.hash === "#/")) location.hash = "#/settings/signin";
    }, () => {});
  });
  async function signOut() { await api.logout(); store.collections = []; store.loaded = false; store.me = null; }
  const [a, b] = $derived(hash.replace(/^#\/?/, "").split("/"));
  const col = $derived(store.collections.find((c) => c.key === a));

  let deploy: DeployDialog;
</script>

<svelte:window onkeydown={(e) => { if (e.key === "Escape") menuOpen = false; }} />
{#if store.me === undefined}
  <div class="stack" aria-busy="true" aria-label="Loading"><div class="skel" style="height:40px"></div></div>
{:else if !store.me}
  <Login />
{:else}
<div class="layout">
  <nav>
    <div class="bar">
      <strong><Logo /></strong>
      <button class="publish" onclick={() => deploy.open()} title="Build what is published and send it to the site">Deploy</button>
      <button type="button" class="icon-btn burger" aria-label={menuOpen ? "Close menu" : "Menu"} aria-expanded={menuOpen} aria-controls="menu" onclick={() => (menuOpen = !menuOpen)}>
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" aria-hidden="true">
          {#if menuOpen}<path d="M6 6l12 12M18 6 6 18" />{:else}<path d="M4 7h16M4 12h16M4 17h16" />{/if}
        </svg>
      </button>
    </div>
    <div class="menu" id="menu" class:open={menuOpen} onclick={(e) => { if ((e.target as Element).closest("a")) menuOpen = false; }} role="presentation">
      {#each store.collections as c (c.key)}
        {@const n = (store.counts[c.key]?.drafts ?? 0) + (store.counts[c.key]?.edited ?? 0)}
        <a href="#/{c.key}" class:active={c.key === a}>{c.label}{#if n}<span class="badge" title="{store.counts[c.key].drafts} draft{store.counts[c.key].drafts === 1 ? "" : "s"}, {store.counts[c.key].edited} edited">{n}</span>{/if}</a>
      {/each}
      {#if owner}<a href="#/collections/new" class="icon-btn" aria-label="New collection" title="New collection"><PlusIcon /></a>{/if}
      <a href="#/notifications" class="navrow settings" class:active={a === "notifications"}><BellIcon />Notifications{#if store.unread}<span class="badge" title="{store.unread} unread">{store.unread}</span>{/if}</a>
      <a href="#/activity" class="navrow" class:active={a === "activity"}><ActivityIcon />Activity</a>
      {#if owner}<a href="#/blocks" class="navrow" class:active={a === "blocks"}><BlocksIcon />Blocks</a>{/if}
      {#if owner}<a href="#/templates" class="navrow" class:active={a === "templates"}><TemplatesIcon />Templates</a>{/if}
      <a href="#/settings" class="navrow" class:active={a === "settings"}><GearIcon />Settings</a>
      <ThemeToggle label />
      <button type="button" class="navrow" onclick={signOut}><LogoutIcon />Sign out</button>
    </div>
  </nav>
  <main class:wide={(!!col && !b) || a === "blocks" || a === "templates"}>
    {#if store.me?.role === "owner" && store.signIn === 0 && a !== "settings"}
      <p class="notice">Finish setting up: <a href="#/settings/signin">add a way to sign in with GitHub or Google</a>.</p>
    {/if}
    {#if !store.loaded}
      <div class="stack" aria-busy="true" aria-label="Loading"><div class="skel" style="height:40px"></div><div class="skel" style="height:180px"></div></div>
<Toasts />
    {:else if store.error}
      <p class="error">{store.error}</p>
    {:else if !owner && (a === "blocks" || a === "templates" || a === "collections")}
      <p class="muted">Only an owner can change collections, blocks and templates.</p>
    {:else if a === "notifications"}
      <NotificationsPage />
    {:else if a === "activity"}
      {#key hash}<ActivityPage entry={b} />{/key}
    {:else if a === "settings"}
      <SettingsPage section={b} />
    {:else if a === "templates"}
      {#if b}{#key hash}<TemplateBuilder tkey={b !== "new" ? b : undefined} />{/key}{:else}<TemplateList />{/if}
    {:else if a === "blocks"}
      {#if b}{#key hash}<BlockBuilder bkey={b !== "new" ? b : undefined} />{/key}{:else}<BlockList />{/if}
    {:else if a === "collections"}
      {#key hash}<CollectionBuilder ckey={b && b !== "new" ? b : undefined} />{/key}
    {:else if col}
      {#if b}{#key hash}<EntryEditor collection={col.key} id={b === "new" ? undefined : b} />{/key}
      {:else}{#key col.key}<EntryList collection={col.key} />{/key}{/if}
    {:else}
      <p class="muted">{store.collections.length ? "Pick a collection." : "No collections yet."}{#if owner} <a href="#/collections/new">Create one</a>{/if}</p>
    {/if}
  </main>
</div>
{/if}
<Toasts />
<Lightbox />
<DeployDialog bind:this={deploy} />
