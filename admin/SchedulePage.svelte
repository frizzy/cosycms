<script lang="ts">
  import { api, type Activity } from "./api";
  import ClockIcon from "./ClockIcon.svelte";

  // What is coming up (go-lives, take-downs and, for owners, deploys) and what the scheduler has done lately.
  let upcoming = $state<Awaited<ReturnType<typeof api.schedule>>>([]), recent = $state<Activity[]>([]), loading = $state(true), error = $state("");
  $effect(() => {
    Promise.all([api.schedule(), api.activity({ scheduled: true, limit: 30 })]).then(([u, r]) => {
      upcoming = u.filter((j) => j.kind.startsWith("entry.") || j.kind === "deploy.run"); // checks and backups are housekeeping
      recent = r.items; loading = false;
    }, (e) => { error = e.message; loading = false; });
  });

  const WHAT: Record<string, string> = { "entry.publish": "Goes live", "entry.unpublish": "Comes off the site", "deploy.run": "Deploys the site" };
  const DID: Record<string, string> = { "entry.publish": "Went live", "entry.unpublish": "Came off the site", deploy: "Deployed the site" };
  const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  const ago = (iso: string) => {
    const s = (Date.parse(iso) - Date.now()) / 1000, f = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
    for (const [u, n] of [["day", 86400], ["hour", 3600], ["minute", 60]] as const) if (Math.abs(s) >= n) return f.format(Math.round(s / n), u);
    return f.format(0, "second");
  };
  const detail = (d: string | null) => (d ?? "").replace(/\s*\(scheduled\)\s*/, "").trim();
</script>

<header><h1>Schedule</h1></header>
{#if error}<p class="error">{error}</p>
{:else if loading}<div class="stack" aria-busy="true" aria-label="Loading"><div class="skel" style="height:44px"></div><div class="skel" style="height:44px"></div></div>
{:else}
  <section class="hits-group">
    <h2>Upcoming</h2>
    {#if upcoming.length}
      <ul class="hits">
        {#each upcoming as j}
          <li><a href={j.entry ? `#/${j.entry.collection}/${j.entry.id}` : "#/settings/publishing"}>
            <span class="sched" class:failed={j.status === "failed"}><ClockIcon /></span>
            <span class="grow"><span class="title">{j.entry?.label ?? "The site"}</span><span class="snip">{j.status === "failed" ? `Failed: ${j.error ?? "see the entry"}` : `${WHAT[j.kind] ?? j.kind} ${ago(j.at)}`}</span></span>
            <span class="meta">{when(j.at)}</span></a></li>
        {/each}
      </ul>
    {:else}<p class="muted">Nothing is scheduled. Set a go-live or take-down time on an entry in a collection that has dates.</p>{/if}
  </section>
  <section class="hits-group">
    <h2>Recently done</h2>
    {#if recent.length}
      <ul class="hits">
        {#each recent as a (a.id)}
          <li><a href={a.entryId && a.collection ? `#/${a.collection}/${a.entryId}` : "#/activity"}>
            <span class="grow"><span class="title">{a.label ?? "The site"}</span><span class="snip">{DID[a.action] ?? a.action}{detail(a.detail) ? ` · ${detail(a.detail)}` : ""}</span></span>
            <span class="meta">{when(a.at)}</span></a></li>
        {/each}
      </ul>
      <p class="tip muted">The latest 30. <a href="#/activity">All activity</a></p>
    {:else}<p class="muted">Nothing has run on a schedule yet.</p>{/if}
  </section>
{/if}
