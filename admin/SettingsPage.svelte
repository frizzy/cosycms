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
  import { settingsTabs } from "./settingsTabs";

  let { section }: { section?: string } = $props();
  const owner = $derived(store.me?.role === "owner");
  const tabs = $derived(settingsTabs(owner));
  const current = $derived(tabs.find((t) => t.id === section)?.id ?? tabs[0].id);
</script>

<header><h1>{tabs.find((t) => t.id === current)?.label}</h1></header>
{#if current === "publishing"}<PublishSettings />
{:else if current === "signin"}<SignInSettings />
{:else if current === "people"}<PeopleSettings />
{:else if current === "notifications"}<NotifySettings />
{:else if current === "search"}<SearchSettings />
{:else if current === "history"}<HistorySettings />
{:else if current === "backups"}<BackupSettings />
{:else if current === "appearance"}<AppearanceSettings />
{:else}<AppsSettings />{/if}
