<script lang="ts">
  import { api, type Activity } from "./api";
  import { refreshCounts, store } from "./store.svelte";
  import ClockIcon from "./ClockIcon.svelte";
  import { toast } from "./toast.svelte";
  import { ask } from "./confirm.svelte";
  import ChangeDialog, { type ChangeView } from "./ChangeDialog.svelte";
  let { entry }: { entry?: string } = $props(); // narrows the history to one entry

  const PHRASE: Record<string, string> = {
    "entry.create": "created", "entry.save": "saved a draft of", "entry.publish": "published", "entry.unpublish": "unpublished",
    "entry.revert": "discarded draft changes to", "entry.delete": "deleted", "entry.restore": "restored",
    deploy: "deployed to the site", "collection.save": "saved the collection", "collection.delete": "deleted the collection",
    "block.save": "saved the block", "block.delete": "deleted the block", "template.save": "saved the template", "template.delete": "deleted the template", "settings.save": "changed the settings:",
    "provider.save": "set up sign-in with", "provider.remove": "removed sign-in with",
    "person.invite": "invited", "person.role": "changed the role of", "person.remove": "removed",
  };
  let queued = $state<Awaited<ReturnType<typeof api.schedule>>>([]);
  $effect(() => { if (!entry && store.me?.role === "owner") api.schedule().then((r) => (queued = r), () => {}); });
  let items = $state<Activity[]>([]), total = $state(0), loading = $state(true), error = $state("");
  async function load(more = false) {
    try {
      const r = await api.activity({ entry, offset: more ? items.length : 0 });
      items = more ? [...items, ...r.items] : r.items; total = r.total;
    } catch (e) { error = (e as Error).message; }
    loading = false;
  }
  $effect(() => { entry; load(); });
  const UNDO: Record<string, string> = { "entry.save": "Undo this change", "entry.revert": "Get the discarded draft back", "entry.delete": "Bring it back as a draft", "entry.restore": "Undo this restore" };
  // Undoing a save shows what it would change first; bringing back a deleted entry only asks.
  let view = $state<ChangeView | null>(null), target: Activity | null = null;
  async function undo(a: Activity) {
    if (a.action === "entry.delete") {
      if (!(await ask({ title: "Bring this entry back?", message: "It comes back as a draft.", confirm: "Bring back" }))) return;
      return run(a);
    }
    try {
      const r = await api.activityChanges(a.id);
      target = a;
      view = { stage: "review", title: "Put the draft back the way it was?", status: "This replaces the draft as it is now. A published version isn't touched.", changes: r.changes, confirm: "Restore this version",
        empty: r.slug ? `Only the slug changes: ${r.slug.from} → ${r.slug.to}` : "The draft already matches that version." };
    } catch (e) { toast((e as Error).message, "error"); }
  }
  async function run(a: Activity) {
    try { await api.undo(a.id); toast("Restored"); await load(); refreshCounts(); } catch (e) { toast((e as Error).message, "error"); }
  }
  const when = (at: string) => new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
</script>

<header><h1>Activity</h1>{#if entry}<a href="#/activity">All activity</a>{/if}</header>
{#if queued.length}
  <section class="queued">
    <h2>Scheduled</h2>
    <ul>
      {#each queued as j}
        <li class:failed={j.status === "failed"}><ClockIcon /> {new Date(j.at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
          {j.kind === "deploy.run" ? "Deploy to the site" : "Publish"}{#if j.entry} <a href="#/{j.entry.collection}/{j.entry.id}">{j.entry.label}</a>{/if}
          {#if j.status === "failed"}<span class="error">· failed: {j.error}</span>{:else if j.error}<span class="muted">· retrying: {j.error}</span>{/if}</li>
      {/each}
    </ul>
  </section>
{/if}
{#if error}<p class="error">{error}</p>
{:else if loading}<p class="muted" aria-busy="true">Loading…</p>
{:else if !items.length}<p class="muted">Nothing has happened yet.</p>
{:else}
  <ol class="activity">
    {#each items as a (a.id)}
      <li>
        <time datetime={a.at}>{when(a.at)}</time>
        <span class="what">
          <strong>{a.actor}</strong>{#if a.via}{" "}<span class="muted">via {a.via}</span>{/if}{" "}
          {PHRASE[a.action] ?? a.action}
          {#if a.label}{#if a.collection && a.entryId && a.action !== "entry.delete"}<a href="#/{a.collection}/{a.entryId}">{a.label}</a>{:else}<strong>{a.label}</strong>{/if}{/if}
          {#if a.detail}<span class="muted">· {a.detail}</span>{/if}
          {#if a.undoable}{" "}<button type="button" class="ghost undo" onclick={() => undo(a)}>{UNDO[a.action] ?? "Undo"}</button>{/if}
        </span>
      </li>
    {/each}
  </ol>
  {#if items.length < total}<p><button type="button" class="ghost" onclick={() => load(true)}>Show older</button> <span class="muted">{items.length} of {total}</span></p>{/if}
{/if}

<ChangeDialog {view} canList={false} onconfirm={async () => { const a = target; view = null; if (a) await run(a); }} onclose={() => (view = null)} onlist={() => (view = null)} />
