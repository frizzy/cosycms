<script lang="ts">
  import { store } from "./store.svelte";
  import PublishSettings from "./PublishSettings.svelte";
  import SignInSettings from "./SignInSettings.svelte";
  import PeopleSettings from "./PeopleSettings.svelte";
  import AppsSettings from "./AppsSettings.svelte";
  import NotifySettings from "./NotifySettings.svelte";
  import SearchSettings from "./SearchSettings.svelte";
  import BackupSettings from "./BackupSettings.svelte";
  import HistorySettings from "./HistorySettings.svelte";
  import AppearanceSettings from "./AppearanceSettings.svelte";

  let { section }: { section?: string } = $props();
  const owner = $derived(store.me?.role === "owner");
  // Everyone sees their own connected apps; the rest is the owner's.
  const tabs = $derived([
    ...(owner ? [{ id: "publishing", label: "Deploy" }, { id: "signin", label: "Sign-in" }, { id: "people", label: "People" }, { id: "notifications", label: "Notifications" }, { id: "history", label: "History" }, { id: "search", label: "Search" }, { id: "backups", label: "Backups" }] : []),
    { id: "apps", label: "Connected apps" },
    { id: "appearance", label: "Appearance" },
  ]);
  const current = $derived(tabs.find((t) => t.id === section)?.id ?? tabs[0].id);
</script>

<header><h1>Settings</h1></header>
<div class="tabs" role="navigation" aria-label="Settings sections">
  {#each tabs as t (t.id)}<a href="#/settings/{t.id}" class:active={t.id === current} aria-current={t.id === current ? "page" : undefined}>{t.label}{#if t.id === "signin" && owner && store.signIn === 0} <span class="dot" title="Needs setup"></span>{/if}</a>{/each}
</div>
{#if current === "publishing"}<PublishSettings />
{:else if current === "signin"}<SignInSettings />
{:else if current === "people"}<PeopleSettings />
{:else if current === "notifications"}<NotifySettings />
{:else if current === "search"}<SearchSettings />
{:else if current === "history"}<HistorySettings />
{:else if current === "backups"}<BackupSettings />
{:else if current === "appearance"}<AppearanceSettings />
{:else}<AppsSettings />{/if}
