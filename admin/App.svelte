<script lang="ts">
  import { api } from "./api";
  import { store, refreshCollections, refreshCounts, refreshUnread, refreshPeople } from "./store.svelte";
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
  import TrashPage from "./TrashPage.svelte";
  import TrashIcon from "./TrashIcon.svelte";
  import HomePage from "./HomePage.svelte";
  import Palette from "./Palette.svelte";
  import SearchIcon from "./SearchIcon.svelte";
  import ActivityIcon from "./ActivityIcon.svelte";
  import BellIcon from "./BellIcon.svelte";
  import NotificationsPage from "./NotificationsPage.svelte";
  import Login from "./Login.svelte";
  import Toasts from "./Toasts.svelte";
  import ConfirmDialog from "./ConfirmDialog.svelte";
  import { ask } from "./confirm.svelte";
  import ThemeToggle from "./ThemeToggle.svelte";
  import MediaHealthPage from "./MediaHealthPage.svelte";
  import ImageIcon from "./ImageIcon.svelte";
  import LinkIcon from "./LinkIcon.svelte";
  import LinksPage from "./LinksPage.svelte";
  import SchedulePage from "./SchedulePage.svelte";
  import ClockIcon from "./ClockIcon.svelte";
  import UserIcon from "./UserIcon.svelte";
  import Avatar from "./Avatar.svelte";
  import BackIcon from "./BackIcon.svelte";
  import { settingsTabs } from "./settingsTabs";
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
      if (store.dirty) {
        // Stay where we are while asking (the dialog can't block the navigation), then go on if the person agrees.
        const target = location.hash;
        reverting = true; location.hash = prev;
        ask({ title: "Leave without saving?", message: "You have unsaved changes.", confirm: "Leave", cancel: "Keep editing", danger: true }).then((ok) => { if (ok) { store.discardDraft?.(); store.dirty = false; location.hash = target; } });
        return;
      }
      prev = hash = location.hash;
      menuOpen = false;
      if (store.me) { refreshCounts(); refreshUnread(); }
    };
    addEventListener("hashchange", on);
    api.me().then((me) => (store.me = me));
    return () => removeEventListener("hashchange", on);
  });
  $effect(() => { if (store.me) { refreshCollections(); refreshCounts(); refreshUnread(); refreshPeople(); } });
  // Builds finish and jobs fail while nobody is looking: check for new notifications now and then.
  $effect(() => { if (!store.me) return; const t = setInterval(refreshUnread, 60_000); return () => clearInterval(t); });
  // Whether social sign-in is set up: until it is, the Sign-in section of Settings carries a red dot.
  $effect(() => {
    if (store.me?.role !== "owner") return;
    api.authInfo().then((i) => (store.signIn = i.providers.length), () => {});
  });
  async function signOut() { await api.logout(); store.collections = []; store.loaded = false; store.me = null; }
  const [a, b] = $derived(hash.replace(/^#\/?/, "").split("/"));
  const col = $derived(store.collections.find((c) => c.key === a));

  let acctOpen = $state(false), acctEl = $state<HTMLElement>();
  let deploy: DeployDialog, palette: Palette;
  const modKey = /Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘K" : "Ctrl K";
</script>

<svelte:window onpointerdown={(e) => { if (acctOpen && acctEl && !acctEl.contains(e.target as Node)) acctOpen = false; }} onkeydown={(e) => { if (e.key === "Escape") { menuOpen = false; acctOpen = false; } if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k" && store.me) { e.preventDefault(); palette.show(); } }} />
{#if store.me === undefined}
  <div class="stack" aria-busy="true" aria-label="Loading"><div class="skel" style="height:40px"></div></div>
{:else if !store.me}
  <Login />
{:else}
<div class="topbar">
  <a href="#/" class="brand" aria-label="Home"><Logo /></a>
  <button type="button" class="tb-search" onclick={() => palette.show()} aria-label="Search" title="Search everything"><SearchIcon /><span>Search</span><kbd>{modKey}</kbd></button>
  <span class="spacer"></span>
  <button class="publish" onclick={() => deploy.open()} title="Build what is published and send it to the site">Deploy</button>
  <a href="#/notifications" class="icon-btn quiet tb-bell" class:on={a === "notifications"} aria-label="Notifications{store.unread ? `, ${store.unread} unread` : ""}" title="Notifications"><BellIcon />{#if store.unread}<span class="tb-badge">{store.unread > 9 ? "9+" : store.unread}</span>{/if}</a>
  <ThemeToggle />
  <div class="acct" bind:this={acctEl}>
    <button type="button" class="icon-btn quiet" aria-label="Account" aria-haspopup="menu" aria-expanded={acctOpen} title={store.me.name || store.me.email} onclick={() => (acctOpen = !acctOpen)}><Avatar avatar={store.me.avatar} /></button>
    {#if acctOpen}
      <div class="tb-pop" role="menu" onclick={() => (acctOpen = false)} onkeydown={() => {}} tabindex="-1">
        <div class="who"><strong>{store.me.name || store.me.email}</strong>{#if store.me.name}<span class="muted">{store.me.email}</span>{/if}<span class="muted">{owner ? "Owner" : "Member"}</span></div>
        <a href="#/settings/profile" class="navrow" role="menuitem"><UserIcon />Profile</a>
        <a href="#/settings" class="navrow" role="menuitem"><GearIcon />Settings</a>
        <button type="button" class="navrow" role="menuitem" onclick={signOut}><LogoutIcon />Sign out</button>
      </div>
    {/if}
  </div>
  <button type="button" class="icon-btn burger" aria-label={menuOpen ? "Close menu" : "Menu"} aria-expanded={menuOpen} aria-controls="menu" onclick={() => (menuOpen = !menuOpen)}>
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" aria-hidden="true">
      {#if menuOpen}<path d="M6 6l12 12M18 6 6 18" />{:else}<path d="M4 7h16M4 12h16M4 17h16" />{/if}
    </svg>
  </button>
</div>
<div class="layout">
  <nav class:open={menuOpen}>
    <div class="menu" id="menu" onclick={(e) => { if ((e.target as Element).closest("a")) menuOpen = false; }} role="presentation">
      {#if a === "settings"}
        <a href="#/" class="navrow"><BackIcon />Back to content</a>
        <div class="navhead"><span>Settings</span></div>
        {#each settingsTabs(owner) as t (t.id)}
          <a href="#/settings/{t.id}" class:active={t.id === (b ?? settingsTabs(owner)[0].id)}>{t.label}{#if t.id === "signin" && owner && store.signIn === 0} <span class="dot" title="Needs setup"></span>{/if}</a>
        {/each}
      {:else}
        <div class="navhead"><span>Collections</span>{#if owner}<a href="#/collections/new" class="icon-btn" aria-label="New collection" title="New collection"><PlusIcon /></a>{/if}</div>
        {#each store.collections as c (c.key)}
          {@const n = (store.counts[c.key]?.drafts ?? 0) + (store.counts[c.key]?.edited ?? 0)}
        <a href="#/{c.key}" class:active={c.key === a}>{c.label}{#if n}<span class="badge" title="{store.counts[c.key].drafts} draft{store.counts[c.key].drafts === 1 ? "" : "s"}, {store.counts[c.key].edited} edited">{n}</span>{/if}</a>
        {/each}
        <div class="navgap"></div>
        <a href="#/schedule" class="navrow" class:active={a === "schedule"}><ClockIcon size={18} />Schedule</a>
        {#if owner}<a href="#/media-health" class="navrow" class:active={a === "media-health"}><ImageIcon />Media health</a>{/if}
        <a href="#/link-check" class="navrow" class:active={a === "link-check"}><LinkIcon />Broken links</a>
        <a href="#/activity" class="navrow" class:active={a === "activity"}><ActivityIcon />Activity</a>
        <a href="#/trash" class="navrow" class:active={a === "trash"}><TrashIcon />Trash</a>
        {#if owner}<a href="#/blocks" class="navrow" class:active={a === "blocks"}><BlocksIcon />Blocks</a>{/if}
        {#if owner}<a href="#/templates" class="navrow" class:active={a === "templates"}><TemplatesIcon />Templates</a>{/if}
      {/if}
    </div>
  </nav>
  <main class:wide={(!!col && !b) || a === "blocks" || a === "templates"}>
    {#if !store.loaded}
      <div class="stack" aria-busy="true" aria-label="Loading"><div class="skel" style="height:40px"></div><div class="skel" style="height:180px"></div></div>
<Toasts />
    {:else if store.error}
      <p class="error">{store.error}</p>
    {:else if !owner && (a === "blocks" || a === "templates" || a === "collections")}
      <p class="muted">Only an owner can change collections, blocks and templates.</p>
    {:else if a === "notifications"}
      <NotificationsPage />
    {:else if a === "media-health" && owner}
      <MediaHealthPage />
    {:else if a === "link-check"}
      <LinksPage />
    {:else if a === "schedule"}
      <SchedulePage />
    {:else if a === "trash"}
      <TrashPage />
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
    {:else if !a}
      <HomePage />
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
<ConfirmDialog />
<DeployDialog bind:this={deploy} />
<Palette bind:this={palette} onDeploy={() => deploy.open()} />
