<script lang="ts">
  import { ask } from "./confirm.svelte";
  import { tick } from "svelte";
  import { api, type Entry, type Used } from "./api";
  import ClockIcon from "./ClockIcon.svelte";
  import ChangeDialog, { type ChangeView } from "./ChangeDialog.svelte";
  import { fieldChanges, type Change } from "../src/diff";
  import { slugify, type Field } from "../src/fields";
  import { store, refreshCounts } from "./store.svelte";
  import { toast } from "./toast.svelte";
  import { saveShortcut } from "./keys";
  import FieldInput from "./FieldInput.svelte";
  import LiveIcon from "./LiveIcon.svelte";
  import { isEmpty } from "./util";
  let { collection, id }: { collection: string; id?: string } = $props();

  const c = store.collections.find((x) => x.key === collection)!;
  const GO_LIVE = { key: "publishAt", label: "Go live", type: "datetime" } as Field;
  let slug = $state("");
  let published = $state(false), pending = $state(false), sched = $state<Entry["schedule"]>(), publishAt = $state<string | null | undefined>(), publishedAt = $state<string | null | undefined>(), revisedAt = $state<string | null | undefined>(); // has a published version; the draft has moved on from it
  let data = $state<Record<string, unknown>>({});
  let loading = $state(!!id);
  let saving = $state(false);
  let error = $state("");

  // The draft and the live version as last seen on the server, so a save or a publish can say what it changed.
  type Snap = { slug: string; publishAt: string | null; data: Record<string, unknown> };
  let snap = $state<Snap | null>(null), liveSnap = $state<Snap | null>(null), view = $state<ChangeView | null>(null), createdId = "";
  const copy = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
  const cleanData = () => Object.fromEntries(Object.entries(data).filter(([, v]) => !isEmpty(v))); // empty values dropped, so optional fields don't fail validation
  const nowSnap = (): Snap => ({ slug, publishAt: publishAt ?? null, data: copy(cleanData()) });
  const local = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }) : "—");
  function changesBetween(a: Snap, b: Snap, dates: boolean): Change[] {
    return [
      ...(a.slug && a.slug !== b.slug ? [{ key: "slug", label: "Slug", kind: "value", before: a.slug, after: b.slug } as Change] : []),
      ...(dates && c.dates && (a.publishAt ?? null) !== (b.publishAt ?? null) ? [{ key: "publishAt", label: "Go live", kind: "value", before: local(a.publishAt), after: local(b.publishAt) } as Change] : []),
      ...fieldChanges(c.fields, a.data, b.data),
    ];
  }

  // Slug source: while unlocked the slug follows that field. Typing in the slug locks it (clearing it unlocks
  // and regenerates); saved entries start locked. Only the lock stops generation.
  const source = c.slugSource ?? undefined;
  let locked = $state(!!id && !!source);
  let lastSource: unknown; // plain variable on purpose: only a *change* of the source should rewrite the slug
  $effect(() => {
    if (!source) return;
    const v = data[source];
    if (v === lastSource) return;
    lastSource = v;
    if (!locked) slug = slugify(String(v ?? ""));
  });
  function onSlugInput(e: Event) {
    if (!source) return;
    if ((e.currentTarget as HTMLInputElement).value.trim() === "") { locked = false; slug = slugify(String(data[source] ?? "")); }
    else locked = true;
  }

  // Live uniqueness check: debounced, and a stale response never overwrites a newer one.
  let savedSlug = "";
  let slugStatus = $state<"" | "ok" | "taken">("");
  let suggestion = $state("");
  $effect(() => {
    const s = slug, skip = s === savedSlug || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(s);
    slugStatus = "";
    if (skip) return;
    let stale = false;
    const t = setTimeout(() => api.slugAvailable(collection, s, id).then(
      (r) => { if (!stale) { slugStatus = r.available ? "ok" : "taken"; suggestion = r.suggestion ?? ""; } }, () => {}), 300);
    return () => { stale = true; clearTimeout(t); };
  });

  // Unsaved-changes tracking. Empty values are normalised away so a form that merely rendered isn't "dirty".
  const present = (v: unknown) => !(v === "" || v == null || v === false || (Array.isArray(v) && !v.length) || (typeof v === "number" && Number.isNaN(v)));
  const fingerprint = () => JSON.stringify([slug, publishAt ?? null, Object.entries(data).filter(([, v]) => present(v)).sort(([x], [y]) => (x < y ? -1 : 1))]);
  let baseline = $state<string>();
  const rebase = () => (baseline = fingerprint());
  // A draft with a future go-live time is scheduled when saved, and can't be published by hand until then.
  const later = $derived(!published && !!c.dates && Date.parse(String(publishAt ?? "")) > Date.now());
  const dirty = $derived(!loading && baseline !== undefined && fingerprint() !== baseline);
  $effect(() => { if (!loading) tick().then(rebase); }); // after bindings and the editor have settled
  $effect(() => {
    store.dirty = dirty;
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    addEventListener("beforeunload", warn);
    return () => removeEventListener("beforeunload", warn);
  });
  $effect(() => () => { store.dirty = false; });

  function adopt(e: Entry) {
    snap = { slug: e.slug, publishAt: e.publishAt ?? null, data: copy(e.data) };
    liveSnap = e.live ? { slug: e.live.slug, publishAt: null, data: copy(e.live.data) } : null;
    savedSlug = e.slug; ({ slug, data, published, pending, schedule: sched, publishAt, publishedAt, revisedAt } = e);
  }
  $effect(() => {
    if (!id) return;
    api.get(id).then((e) => { adopt(e); loading = false; }, (e) => { error = e.message; loading = false; });
  });

  // Where this entry is used (an image in a post, a link from another entry): shown below the form when there is anything.
  let usage = $state<Used[]>([]), links = $state<Used[]>([]);
  $effect(() => { if (id) api.usage(id).then((r) => { usage = r.items; links = r.links; }, () => {}); });
  const collLabel = (key: string) => store.collections.find((x) => x.key === key)?.label ?? key;

  // Saving only ever changes the draft. Returns the entry's id when it saved.
  async function persist(): Promise<string | null> {
    error = "";
    if (slugStatus === "taken") { error = "That slug is already used by another entry in this collection."; return null; }
    const clean = cleanData();
    saving = true;
    try {
      const body = { collection, slug, data: clean, ...(c.dates ? { publishAt: publishAt || null } : {}) };
      let target = id;
      if (id) { const e = await api.update(id, body); ({ published, pending, schedule: sched, publishAt, publishedAt, revisedAt } = e); }
      else { const e = await api.create(body); target = createdId = e.id; sched = e.schedule; }
      refreshCounts();
      savedSlug = slug; if (source) locked = true;
      rebase(); store.dirty = false; // clean first so the leave-guard stays quiet
      snap = { slug, publishAt: publishAt ?? null, data: copy(clean) };
      saving = false;
      return target ?? null;
    } catch (e) { error = (e as Error).message; }
    saving = false;
    return null;
  }

  // After a save, say what happened and what changed, then let the person go back to the list.
  async function save(ev: SubmitEvent) {
    ev.preventDefault();
    const before = snap;
    if (!(await persist())) return;
    const scheduled = sched && !sched.failed;
    view = {
      stage: "done", title: scheduled ? "Scheduled" : before ? "Draft saved" : "Created",
      status: scheduled ? `Goes live ${local(sched!.at)} and deploys automatically. Until then it stays a draft.` : published ? "The live version hasn't changed. Publish to send these changes to the site." : "It isn't on the site yet. Publish when it's ready.",
      changes: changesBetween(before ?? { slug: "", publishAt: null, data: {} }, snap!, true), empty: before ? undefined : "",
    };
  }
  function closeView() { const go = !id && createdId; view = null; if (go) location.hash = `#/${collection}/${createdId}`; }
  function toList() { view = null; location.hash = `#/${collection}`; }

  // Publishing: review what will change against the live version, then confirm. Open edits are saved first.
  function publish() {
    if (!id) return;
    view = {
      stage: "review", title: published ? "Publish these changes?" : "Publish this entry?",
      status: published ? "These replace the live version. They reach the site on the next Deploy." : "It has never been published. It reaches the site on the next Deploy.",
      changes: published && liveSnap ? changesBetween(liveSnap, nowSnap(), false) : [], confirm: published ? "Publish changes" : "Publish", empty: published ? "Nothing in the content differs from the live version." : "",
    };
  }
  async function confirmPublish() {
    if (!view || !id) return;
    const review = view;
    view = { ...review, stage: "working", error: "" };
    if (dirty && !(await persist())) { view = { ...review, error }; return; }
    try {
      ({ published, pending, schedule: sched, publishAt, publishedAt, revisedAt } = await api.publishEntry(id));
      liveSnap = nowSnap(); refreshCounts();
      view = { stage: "done", title: "Published", status: "It goes to the site on the next Deploy.", changes: review.changes, empty: "" };
    } catch (e) { view = { ...review, error: (e as Error).message }; }
  }
  async function unpublish() {
    if (!id || !(await ask({ title: "Take this off the site?", message: "The draft stays. It comes off the site on the next Deploy.", confirm: "Unpublish" }))) return;
    try {
      ({ published, pending, schedule: sched, publishAt, publishedAt, revisedAt } = await api.unpublishEntry(id));
      liveSnap = null; refreshCounts();
      view = { stage: "done", title: "Unpublished", status: "It comes off the site on the next Deploy. The draft stays.", changes: [], empty: "" };
    } catch (e) { error = (e as Error).message; }
  }
  async function revert() {
    if (!id || !(await ask({ title: "Discard the draft changes?", message: "The draft goes back to the published version.", confirm: "Discard changes", danger: true }))) return;
    try { await api.revertEntry(id); store.dirty = false; loading = true; const e = await api.get(id); adopt(e); loading = false; toast("Back to the published version"); refreshCounts(); }
    catch (e) { error = (e as Error).message; loading = false; }
  }

  async function remove() {
    if (!id || !(await ask({ title: "Delete this entry?", message: "It moves to the Trash, where it can be restored for a while.", confirm: "Delete", danger: true }))) return;
    error = "";
    try { await api.remove(id); } catch (e) { error = (e as Error).message; return; } // e.g. still used by another entry
    store.dirty = false;
    toast("Deleted"); refreshCounts();
    location.hash = `#/${collection}`;
  }
</script>

{#snippet state()}{#if id && !loading}<span class="livestate" class:edited={pending || dirty}>{#if published}<LiveIcon />{pending || dirty ? "Published · draft has changes" : "Published"}{:else}Draft{/if}</span>{/if}{/snippet}
<div class="crumbs"><span class="muted">{c.label}</span>{@render state()}<span class="spacer"></span>{#if id}<a href="#/activity/{id}">History</a>{/if}{#if !c.single}<a href="#/{collection}">← Back</a>{/if}</div>
{#if sched}
  <p class="notice sched" class:failed={sched.failed}>
    {#if sched.failed}<strong>Scheduled publish failed.</strong> {sched.error} Fix it and save to try again.
    {:else}<ClockIcon />Scheduled: publishes and deploys {new Date(sched.at).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" })}. Clear the go-live time to cancel it.{/if}
  </p>
{/if}
<header><h1>{id ? (c.titleField && String(data[c.titleField] ?? "").trim()) || slug || "Edit" : "New"}</h1></header>
{#if loading}
  <div class="stack" aria-busy="true" aria-label="Loading">
    {#each [40, 56, 56, 220] as h}<div class="skel" style="height:{h}px"></div>{/each}
  </div>
{:else}
  <form onsubmit={save} use:saveShortcut>
    <div class="field">Slug
      <div class="inline">
        <input bind:value={slug} required pattern="[a-z0-9]+(-[a-z0-9]+)*" aria-invalid={slugStatus === "taken"} oninput={onSlugInput} style="flex:1" />
        {#if source}<label class="check"><input type="checkbox" bind:checked={locked} />Locked</label>{/if}
      </div>
      <!-- Always rendered at a fixed height so messages appearing or changing never move the form. -->
      <div class="hint" aria-live="polite">
        {#if slugStatus === "taken"}
          <span class="error">✗ Already taken{#if suggestion}&nbsp;— <button type="button" class="link" onclick={() => { slug = suggestion; if (source) locked = true; }}>use {suggestion}</button>{/if}</span>
        {:else if slugStatus === "ok"}<span class="ok">✓ Available</span>
        {:else if id && published && slug !== savedSlug}<span class="muted">The file moves when you publish this change.</span>{/if}
      </div>
    </div>
    {#if c.dates}
      <FieldInput field={GO_LIVE} bind:value={publishAt} locked={published ? "Locked while published. Unpublish to change it." : ""} />
      {#if !published && !publishAt}<small class="muted">Optional. Set a future time and Save and schedule to have it published and deployed then.</small>{/if}
      {#if publishedAt}<small class="muted">First published {new Date(publishedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}{revisedAt && revisedAt !== publishedAt ? `, last revised ${new Date(revisedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}` : ""}.</small>{/if}
    {/if}
    {#each c.fields as f (f.key)}<FieldInput field={f} {collection} bind:value={data[f.key]} />{/each}
    <div class="actions">
      <button type="submit" class={id && !later && (!published || pending || dirty) ? "ghost" : ""} disabled={saving}>{later ? "Save and schedule" : "Save draft"}</button>
      {#if id && !later && (!published || pending || dirty)}<button type="button" onclick={publish} disabled={saving}>{published ? "Publish changes" : "Publish"}</button>{/if}
      {#if id && published && pending && !dirty}<button type="button" class="ghost" onclick={revert}>Discard draft changes</button>{/if}
      {#if id && published}<button type="button" class="ghost" onclick={unpublish}>Unpublish</button>{/if}
      {#if id}<button type="button" class="danger" onclick={remove}>Delete</button>{/if}
      <span class="status">{#if error}<span class="error">{error}</span>{:else if dirty}<span class="dirty">Unsaved changes</span>{/if}</span>
    </div>
  </form>
  {#snippet refs(title: string, noun: string, list: Used[])}
    <section class="usage">
      <h2>{title} {list.length}{list.length === 50 ? "+" : ""} {list.length === 1 ? noun : noun === "place" ? "places" : "entries"}</h2>
      <ul>{#each list as u (u.id)}<li><a href="#/{u.collection}/{u.id}">{u.title}</a> <span class="muted">{collLabel(u.collection)}</span></li>{/each}</ul>
    </section>
  {/snippet}
  {#if usage.length}{@render refs("Used in", "place", usage)}{/if}
  {#if links.length}{@render refs("Linked from", "entry", links)}{/if}
{/if}

<style>
  .usage { margin-top: 2rem; } .usage:last-of-type { margin-bottom: 3rem; }
  .usage h2 { font-size: 1rem; margin: 0 0 .5rem; }
  .usage ul { list-style: none; margin: 0; padding: 0; display: grid; gap: .3rem; max-height: 14rem; overflow: auto; }
  .usage li { overflow-wrap: anywhere; }
</style>

<ChangeDialog {view} canList={!c.single} onconfirm={confirmPublish} onclose={closeView} onlist={toList} />
