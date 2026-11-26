<script lang="ts">
  import { api, type Notice } from "./api";
  import { refreshUnread } from "./store.svelte";
  let items = $state<Notice[]>([]), loading = $state(true), error = $state("");
  async function load() {
    try { items = (await api.notices()).items; } catch (e) { error = (e as Error).message; }
    loading = false; refreshUnread();
  }
  $effect(() => { load(); });
  const when = (at: string) => new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  const ext = (l: string) => /^https?:/.test(l);
  const act = async (f: () => Promise<unknown>) => { try { await f(); await load(); } catch (e) { error = (e as Error).message; } };
</script>

<header><h1>Notifications</h1>{#if items.some((n) => !n.readAt)}<button type="button" class="ghost" onclick={() => act(() => api.readNotices())}>Mark all as read</button>{/if}</header>
{#if error}<p class="error">{error}</p>
{:else if loading}<p class="muted" aria-busy="true">Loading…</p>
{:else if !items.length}<p class="muted">Nothing to report. Failed site builds and scheduled jobs that gave up show up here.</p>
{:else}
  <ul class="notices">
    {#each items as n (n.id)}
      <li class:unread={!n.readAt} class="lv-{n.level}">
        <span class="mark" aria-hidden="true">{n.level === "error" ? "✗" : n.level === "success" ? "✓" : "i"}</span>
        <div>
          <strong>{n.title}</strong>
          {#if n.body}<span class="muted"> {n.body}</span>{/if}
          <div class="meta"><time datetime={n.at}>{when(n.at)}</time>
            {#if n.link}<a href={n.link} target={ext(n.link) ? "_blank" : undefined} rel={ext(n.link) ? "noopener" : undefined} onclick={() => !n.readAt && act(() => api.readNotices(n.id))}>{ext(n.link) ? "Open on GitHub" : "Open"}</a>{/if}
            {#if !n.readAt}<button type="button" class="link" onclick={() => act(() => api.readNotices(n.id))}>Mark as read</button>{/if}
            <button type="button" class="link" onclick={() => act(() => api.dismissNotice(n.id))}>Dismiss</button>
          </div>
        </div>
      </li>
    {/each}
  </ul>
{/if}
