<script lang="ts">
  import { ask } from "./confirm.svelte";
  import { tick } from "svelte";
  import { capitalise, headingTexts, capitaliseHeadings } from "../src/casing";
  import { api, type Entry, type Used } from "./api";
  import ClockIcon from "./ClockIcon.svelte";
  import ChangeDialog, { type ChangeView } from "./ChangeDialog.svelte";
  import { fieldChanges, type Change } from "../src/diff";
  import { slugify, type Field } from "../src/fields";
  import { store, refreshCounts } from "./store.svelte";
  import { toast } from "./toast.svelte";
  import { saveShortcut } from "./keys";
  import FieldInput from "./FieldInput.svelte";
  import { entryStats } from "../src/stats";
  import GearIcon from "./GearIcon.svelte";
  import PreviewDialog from "./PreviewDialog.svelte";
  import LiveIcon from "./LiveIcon.svelte";
  import { isEmpty } from "./util";
  let { collection, id }: { collection: string; id?: string } = $props();

  const c = store.collections.find((x) => x.key === collection)!;
  const GO_LIVE = { key: "publishAt", label: "Go live", type: "datetime" } as Field, TAKE_DOWN = { key: "unpublishAt", label: "Take down", type: "datetime" } as Field;
  let slug = $state("");
  let published = $state(false), pending = $state(false), sched = $state<Entry["schedule"]>(), publishAt = $state<string | null | undefined>(), unpublishAt = $state<string | null | undefined>(), publishedAt = $state<string | null | undefined>(), revisedAt = $state<string | null | undefined>(); // has a published version; the draft has moved on from it
  let previewing = $state(false), data = $state<Record<string, unknown>>({}), tidied = $state<string[]>([]), kept = $state<Record<string, string[]>>({}), rev = $state(0); // tidied: fields the server capitalised on the last save; rev remounts the editors so they show it
  let loading = $state(!!id);
  let saving = $state(false);
  let error = $state("");

  // The draft and the live version as last seen on the server, so a save or a publish can say what it changed.
  type Snap = { slug: string; publishAt: string | null; unpublishAt?: string | null; data: Record<string, unknown> };
  let snap = $state<Snap | null>(null), liveSnap = $state<Snap | null>(null), view = $state<ChangeView | null>(null), createdId = "";
  const copy = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
  const cleanData = () => Object.fromEntries(Object.entries(data).filter(([, v]) => !isEmpty(v))); // empty values dropped, so optional fields don't fail validation
  const nowSnap = (): Snap => ({ slug, publishAt: publishAt ?? null, unpublishAt: unpublishAt ?? null, data: copy(cleanData()) });
  const local = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }) : "—");
  function changesBetween(a: Snap, b: Snap, dates: boolean): Change[] {
    return [
      ...(a.slug && a.slug !== b.slug ? [{ key: "slug", label: "Slug", kind: "value", before: a.slug, after: b.slug } as Change] : []),
      ...(dates && c.dates && (a.publishAt ?? null) !== (b.publishAt ?? null) ? [{ key: "publishAt", label: "Go live", kind: "value", before: local(a.publishAt), after: local(b.publishAt) } as Change] : []),
      ...(dates && c.dates && (a.unpublishAt ?? null) !== (b.unpublishAt ?? null) ? [{ key: "unpublishAt", label: "Take down", kind: "value", before: local(a.unpublishAt ?? null), after: local(b.unpublishAt ?? null) } as Change] : []),
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
  const fingerprint = () => JSON.stringify([slug, publishAt ?? null, unpublishAt ?? null, Object.entries(data).filter(([, v]) => present(v)).sort(([x], [y]) => (x < y ? -1 : 1))]);
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
    snap = { slug: e.slug, publishAt: e.publishAt ?? null, unpublishAt: e.unpublishAt ?? null, data: copy(e.data) };
    liveSnap = e.live ? { slug: e.live.slug, publishAt: null, data: copy(e.live.data) } : null;
    kept = e.keepCase ?? {};
    savedSlug = e.slug; ({ slug, data, published, pending, schedule: sched, publishAt, unpublishAt, publishedAt, revisedAt } = e);
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
  async function persist(keepCase: Record<string, string[]> = kept): Promise<string | null> {
    error = "";
    if (slugStatus === "taken") { error = "That slug is already used by another entry in this collection."; return null; }
    const clean = cleanData();
    saving = true;
    try {
      const body = { collection, slug, data: clean, ...(Object.keys(keepCase).length ? { keepCase } : {}), ...(c.dates ? { publishAt: publishAt || null, unpublishAt: unpublishAt || null } : {}) };
      let target = id, saved: Record<string, unknown> = {};
      if (id) { const e = await api.update(id, body); saved = e.data; kept = e.keepCase ?? {}; ({ published, pending, schedule: sched, publishAt, unpublishAt, publishedAt, revisedAt } = e); }
      else { const e = await api.create(body); target = createdId = e.id; sched = e.schedule; saved = e.data; kept = e.keepCase ?? {}; }
      // Capitalisation is applied by the server; take its result, and remember which fields it touched.
      const fixed = c.fields.filter((f) => "casing" in f && f.casing && JSON.stringify(saved[f.key] ?? null) !== JSON.stringify(clean[f.key] ?? null));
      tidied = fixed.map((f) => f.label || f.key);
      for (const f of fixed) { clean[f.key] = saved[f.key]; data[f.key] = saved[f.key]; }
      if (fixed.some((f) => f.type === "richtext")) rev++;
      refreshCounts();
      savedSlug = slug; if (source) locked = true;
      rebase(); store.dirty = false; // clean first so the leave-guard stays quiet
      snap = { slug, publishAt: publishAt ?? null, unpublishAt: unpublishAt ?? null, data: copy(clean) };
      saving = false;
      return target ?? null;
    } catch (e) { error = (e as Error).message; }
    saving = false;
    return null;
  }

  // Capitalisation the server would apply to what is typed now, one proposal per piece (a text value, or a heading), so each can be opted out of.
  // `units` maps a proposal's key back to the field and the text as typed, which is what gets remembered.
  let units = new Map<string, { field: string; text: string }>();
  function caseProposals(): Change[] {
    const d = cleanData(), out: Change[] = [];
    units = new Map();
    for (const f of c.fields) {
      if (!("casing" in f) || !f.casing || d[f.key] == null) continue;
      const pieces = f.type === "richtext" ? headingTexts(d[f.key]) : [String(d[f.key])];
      pieces.forEach((text, i) => {
        const after = capitalise(text, f.casing!), key = f.type === "richtext" ? `${f.key}#${i}` : f.key;
        if (after === text || kept[f.key]?.includes(text)) return;
        units.set(key, { field: f.key, text });
        out.push({ key, label: f.type === "richtext" ? `${f.label} (heading)` : f.label || f.key, kind: "value", before: text, after });
      });
    }
    return out;
  }
  let settleCase: ((keep: Record<string, string[]> | null) => void) | null = null, keepNext: Record<string, string[]> = {};
  /** Resolves with what to remember as left-as-typed (the old choices plus any new ones), or null when the person cancels. */
  function casingReview(): Promise<Record<string, string[]> | null> {
    const changes = caseProposals();
    if (!changes.length) return Promise.resolve(kept);
    return new Promise((done) => {
      settleCase = done;
      view = { stage: "review", title: "Apply automatic capitalisation?", status: "These capitalise when saved. Untick any you want to keep as typed; that is remembered while the text stays the same.", changes, optional: changes.map((x) => x.key), skip: [], confirm: "Save", empty: "" };
    });
  }
  function onConfirm() {
    if (!settleCase) return confirmPublish();
    const done = settleCase, keep: Record<string, string[]> = copy(kept);
    for (const k of view?.skip ?? []) { const u = units.get(k); if (u) (keep[u.field] ??= []).push(u.text); }
    settleCase = null; view = null; done(keep);
  }

  // After a save, say what happened and what changed, then let the person go back to the list.
  async function save(ev: SubmitEvent) {
    ev.preventDefault();
    const before = snap, keep = await casingReview();
    if (!keep || !(await persist(keep))) return;
    const scheduled = sched && !sched.failed;
    view = {
      stage: "done", title: scheduled ? "Scheduled" : before ? "Draft saved" : "Created",
      status: scheduled ? `Goes live ${local(sched!.at)} and deploys automatically. Until then it stays a draft.` : published ? "The live version hasn't changed. Publish to send these changes to the site." : "It isn't on the site yet. Publish when it's ready.",
      changes: changesBetween(before ?? { slug: "", publishAt: null, data: {} }, snap!, true), empty: before ? undefined : "", note: tidyNote(),
    };
  }
  const tidyNote = () => (tidied.length ? `Capitalisation was applied automatically to: ${tidied.join(", ")}.` : undefined);
  function closeView() {
    if (settleCase) { const done = settleCase; settleCase = null; view = null; done(null); return; }
    const go = !id && createdId; view = null; if (go) location.hash = `#/${collection}/${createdId}`; }
  function toList() { view = null; location.hash = `#/${collection}`; }

  // Publishing: review what will change against the live version, then confirm. Open edits are saved first.
  async function publish() {
    if (!id) return;
    if (dirty) { const keep = await casingReview(); if (!keep) return; keepNext = keep; } else keepNext = kept;
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
    if (dirty && !(await persist(keepNext))) { view = { ...review, error }; return; }
    try {
      ({ published, pending, schedule: sched, publishAt, unpublishAt, publishedAt, revisedAt } = await api.publishEntry(id));
      liveSnap = nowSnap(); refreshCounts();
      view = { stage: "done", title: "Published", status: "It goes to the site on the next Deploy.", changes: review.changes, empty: "", note: tidyNote() };
    } catch (e) { view = { ...review, error: (e as Error).message }; }
  }
  async function unpublish() {
    if (!id || !(await ask({ title: "Take this off the site?", message: "The draft stays. It comes off the site on the next Deploy.", confirm: "Unpublish" }))) return;
    try {
      ({ published, pending, schedule: sched, publishAt, unpublishAt, publishedAt, revisedAt } = await api.unpublishEntry(id));
      liveSnap = null; refreshCounts();
      view = { stage: "done", title: "Unpublished", status: "It comes off the site on the next Deploy. The draft stays.", changes: [], empty: "" };
    } catch (e) { error = (e as Error).message; }
  }
  async function revert() {
    if (!id || !(await ask({ title: "Discard the draft changes?", message: "The draft goes back to the published version.", confirm: "Discard changes", danger: true }))) return;
    try { await api.revertEntry(id); store.dirty = false; loading = true; const e = await api.get(id); adopt(e); loading = false; toast("Back to the published version"); refreshCounts(); }
    catch (e) { error = (e as Error).message; loading = false; }
  }

  // A new draft from the saved draft (not unsaved edits), with a free slug and "(copy)" on the title; times and publication are not carried over.
  async function duplicate() {
    if (!id) return;
    error = "";
    try {
      const src = await api.get(id), data = copy(src.data);
      if (c.titleField && typeof data[c.titleField] === "string") data[c.titleField] = `${data[c.titleField]} (copy)`;
      let s = `${src.slug}-copy`;
      const free = await api.slugAvailable(collection, s);
      if (!free.available && free.suggestion) s = free.suggestion;
      const e = await api.create({ collection, slug: s, data });
      refreshCounts(); toast("Duplicated as a draft");
      location.hash = `#/${collection}/${e.id}`;
    } catch (e) { error = (e as Error).message; }
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
<div class="crumbs"><span class="muted">{c.label}</span>{@render state()}<span class="spacer"></span>{#if id}<a href="#/activity/{id}">History</a>{/if}{#if store.me?.role === "owner"}<a class="icon-btn quiet" href="#/collections/{collection}" aria-label="Collection settings" title="Collection settings"><GearIcon /></a>{/if}{#if !c.single}<a href="#/{collection}">← Back</a>{/if}</div>
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
      <FieldInput field={GO_LIVE} future bind:value={publishAt} locked={published ? "Locked while published. Unpublish to change it." : ""} />
      <FieldInput field={TAKE_DOWN} future bind:value={unpublishAt} />
      {#if unpublishAt && Date.parse(unpublishAt) <= Date.now()}<small class="error">That time has passed, so nothing will happen. Pick a later time, or clear it.</small>
      {:else if unpublishAt}<small class="muted">{published || publishAt ? "It comes off the site and deploys then; the draft stays." : "Once published, it comes off the site and deploys then; the draft stays."}</small>{:else if !unpublishAt}<small class="muted">Optional. Set a time to have it taken off the site and deployed then.</small>{/if}
      {#if !published && publishAt && Date.parse(publishAt) <= Date.now()}<small class="error">That time has passed, so it won't be scheduled. Pick a later time, or clear it.</small>{/if}
      {#if !published && !publishAt}<small class="muted">Optional. Set a future time and Save and schedule to have it published and deployed then.</small>{/if}
      {#if publishedAt}<small class="muted">First published {new Date(publishedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}{revisedAt && revisedAt !== publishedAt ? `, last revised ${new Date(revisedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}` : ""}.</small>{/if}
    {/if}
    {#each c.fields as f (f.key)}{#key f.type === "richtext" ? rev : 0}<FieldInput field={f} {collection} bind:value={data[f.key]} />{/key}{/each}
    {#if c.stats}{@const st = entryStats(c.fields, data, c.bodyField)}<p class="muted stats">{st.wordCount.toLocaleString()} {st.wordCount === 1 ? "word" : "words"}{st.readingTime ? ` · ${st.readingTime} min read` : ""}</p>{/if}
    <div class="actions">
      <button type="submit" class={id && !later && (!published || pending || dirty) ? "ghost" : ""} disabled={saving}>{later ? "Save and schedule" : "Save draft"}</button>
      {#if id && !later && (!published || pending || dirty)}<button type="button" onclick={publish} disabled={saving}>{published ? "Publish changes" : "Publish"}</button>{/if}
      {#if id && published && pending && !dirty}<button type="button" class="ghost" onclick={revert}>Discard draft changes</button>{/if}
      {#if id && published}<button type="button" class="ghost" onclick={unpublish}>Unpublish</button>{/if}
      <button type="button" class="ghost" onclick={() => (previewing = true)}>Preview</button>
      {#if id && !c.single}<button type="button" class="ghost" onclick={duplicate}>Duplicate</button>{/if}
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

<PreviewDialog open={previewing} fields={c.fields} data={cleanData()} titleField={c.titleField} onclose={() => (previewing = false)} />
<ChangeDialog {view} canList={!c.single} onconfirm={onConfirm} onclose={closeView} onlist={toList} />
