<script lang="ts">
  import { ask } from "./confirm.svelte";
  import { api } from "./api";
  import { store, refreshCollections } from "./store.svelte";
  import { toast } from "./toast.svelte";
  import PlusIcon from "./PlusIcon.svelte";
  import { saveShortcut } from "./keys";
  import { fileFieldOf, slugify, type Field } from "../src/fields";
  import { IMAGE_DEFAULTS } from "../src/images";

  let { ckey }: { ckey?: string } = $props();
  const FILE_FOLDER = String.raw`[A-Za-z0-9._{}\-]+(/[A-Za-z0-9._{}\-]+)*`; // the server checks the placeholders properly
  const existing = ckey ? store.collections.find((c) => c.key === ckey) : undefined;

  // Presets only seed the type and flags for a new field; they aren't stored.
  const PRESETS = [
    { id: "text", label: "Text", type: "text" },
    { id: "textarea", label: "Long text", type: "textarea" },
    { id: "richtext", label: "Rich text", type: "richtext" },
    { id: "number", label: "Number", type: "number" },
    { id: "boolean", label: "Yes / no", type: "boolean" },
    { id: "date", label: "Date", type: "date" },
    { id: "datetime", label: "Date and time", type: "datetime" },
    { id: "url", label: "URL", type: "url" },
    { id: "image", label: "Image (uploaded in the entry)", type: "file" },
    { id: "lib", label: "Image from library", type: "reference", lib: true },
    { id: "libs", label: "Images from library (many)", type: "reference", multiple: true, lib: true },
    { id: "ref", label: "Reference to an entry", type: "reference" },
    { id: "refs", label: "References to entries (many)", type: "reference", multiple: true },
    { id: "select", label: "Select (one)", type: "select" },
    { id: "multi", label: "Select (many)", type: "select", multiple: true },
    { id: "tags", label: "Tags (free-form)", type: "select", multiple: true, allowCustom: true },
  ];

  type Row = { uid: string; key: string; label: string; type: string; preset: string; required: boolean; options: string;
    multiple: boolean; allowCustom: boolean; isNew: boolean; touched: boolean;
    maxSize: number | null; format: string; quality: number | null; strip: boolean; // image options; null = default
    casing: string; // text, long text, rich text headings: "" | "words" | "title"
    autoSet: string; // datetime: "" | "create" | "save"
    folder: string; keepName: boolean; publishAs: string; // image: where it is published, under what name, and the entry's value
    imageComponent: string; // rich text: MDX component for images with settings
    library: string; // rich text: collection its body images come from
    blocks: string[]; // rich text: keys of the content blocks it may contain
    templates: string[]; // rich text: keys of the templates that can start it
    target: string; libOnly: boolean }; // reference: the collection pointed at (libOnly = UI filter for image presets)

  const toRow = (f: Field): Row => ({
    uid: crypto.randomUUID(), key: f.key, label: f.label, type: f.type, preset: f.type, required: !!f.required,
    options: f.type === "select" ? f.options.join("\n") : "", multiple: (f.type === "select" || f.type === "reference") && !!f.multiple,
    allowCustom: f.type === "select" && !!f.allowCustom, isNew: false, touched: true,
    maxSize: f.type === "file" ? f.maxSize ?? null : null, format: f.type === "file" ? f.format ?? "keep" : "keep",
    quality: f.type === "file" ? f.quality ?? null : null, strip: f.type === "file" ? f.stripMetadata ?? true : true,
    casing: (f.type === "text" || f.type === "textarea" || f.type === "richtext") ? f.casing ?? "" : "",
    autoSet: f.type === "datetime" ? f.autoSet ?? "" : "", folder: f.type === "file" ? f.folder ?? "" : "", keepName: f.type === "file" && !!f.keepName,
    publishAs: f.type === "file" ? f.publishAs ?? "object" : "object",
    target: f.type === "reference" ? f.collection : "", libOnly: false, library: f.type === "richtext" ? f.imageLibrary ?? "" : "", imageComponent: f.type === "richtext" ? f.imageComponent ?? "" : "", blocks: f.type === "richtext" ? f.blocks ?? [] : [], templates: f.type === "richtext" ? f.templates ?? [] : [],
  });
  const blank = (): Row => ({ uid: crypto.randomUUID(), key: "", label: "", type: "text", preset: "text", required: false,
    options: "", multiple: false, allowCustom: false, isNew: true, touched: false,
    maxSize: null, format: "keep", quality: null, strip: true, target: "", libOnly: false, library: "", imageComponent: "", casing: "", autoSet: "", folder: "", keepName: false, publishAs: "object", blocks: [], templates: [] });

  const toField = (r: Row) => ({
    key: r.key, label: r.label, type: r.type,
    ...(r.required && canRequire(r) ? { required: true } : {}),
    // Only non-default image options are stored, so the defaults can improve later without migrating collections.
    ...(r.type === "file" ? {
      ...(r.maxSize != null ? { maxSize: r.maxSize } : {}), ...(r.format !== "keep" ? { format: r.format } : {}),
      ...(r.quality != null ? { quality: r.quality } : {}), ...(!r.strip ? { stripMetadata: false } : {}),
      ...(r.folder.trim() ? { folder: r.folder.trim(), ...(r.keepName ? { keepName: true } : {}) } : {}), ...(r.publishAs === "path" ? { publishAs: "path" } : {}),
    } : {}),
    ...(r.type === "datetime" && r.autoSet ? { autoSet: r.autoSet } : {}),
    ...((r.type === "text" || r.type === "textarea" || r.type === "richtext") && r.casing ? { casing: r.casing } : {}),
    ...(r.type === "reference" ? { collection: r.target, multiple: r.multiple } : {}),
    ...(r.type === "richtext" && r.library ? { imageLibrary: r.library } : {}),
    ...(r.type === "richtext" && r.library && r.imageComponent.trim() ? { imageComponent: r.imageComponent.trim() } : {}),
    ...(r.type === "richtext" && r.blocks.length ? { blocks: r.blocks } : {}),
    ...(r.type === "richtext" && r.templates.length ? { templates: r.templates } : {}),
    ...(r.type === "select" ? { options: r.options.split("\n").map((o) => o.trim()).filter(Boolean), multiple: r.multiple, allowCustom: r.allowCustom } : {}),
  }) as Field;

  const canRequire = (r: Row) => r.type !== "boolean" && r.type !== "richtext";
  const camel = (s: string) => s.replace(/[^a-zA-Z0-9]+(.)?/g, (_, c) => (c ?? "").toUpperCase()).replace(/^[^a-zA-Z]+/, "").replace(/^./, (c) => c.toLowerCase());

  let key = $state(existing?.key ?? ""), label = $state(existing?.label ?? "");
  let keyTouched = $state(!!existing);
  let single = $state(!!existing?.single);
  let slugSource = $state(existing?.slugSource ?? ""), titleField = $state(existing?.titleField ?? ""), thumbField = $state(existing?.thumbField ?? "");
  let dates = $state(!!existing?.dates), stats = $state(!!existing?.stats);
  let format = $state<"json" | "markdown" | "mdx">(existing?.format ?? "json"), bodyField = $state(existing?.bodyField ?? ""), folder = $state(existing?.folder ?? ""), urlTemplate = $state(existing?.urlTemplate ?? "");
  const isMd = $derived(format === "markdown" || format === "mdx");
  let rows = $state<Row[]>(existing ? existing.fields.map(toRow) : []);
  let error = $state(""), busy = $state(false);
  // Only text fields can feed a slug. Derived from the live rows so newly added fields show up.
  const richRows = $derived(rows.filter((r) => r.type === "richtext" && r.key));
  const thumbs = $derived(rows.filter((r) => (r.type === "file" || r.type === "reference") && r.key));
  const titles = $derived(rows.filter((r) => r.type === "text" && r.key));
  const sources = $derived(rows.filter((r) => (r.type === "text" || r.type === "textarea") && r.key));

  function onPreset(r: Row, id: string) {
    const p = PRESETS.find((x) => x.id === id)!;
    r.preset = id; r.type = p.type; r.multiple = !!p.multiple; r.allowCustom = !!p.allowCustom;
    r.libOnly = !!p.lib; r.target = p.type === "reference" ? targets(r)[0]?.key ?? "" : "";
  }
  // Reference targets: any collection, or only image libraries (those with an image field) for the image presets.
  const targets = (r: Row) => store.collections.filter((c) => !r.libOnly || fileFieldOf(c));

  // A ready-made media library: an image plus alt text, with slugs taken from the alt text.
  function useLibraryTemplate() {
    label = "Image library"; key = "media"; keyTouched = true; slugSource = "alt"; titleField = "alt"; thumbField = "image";
    const f = (k: string, l: string, type: string, preset: string, required = false): Row => ({ ...blank(), key: k, label: l, type, preset, required, touched: true });
    rows = [f("image", "Image", "file", "image", true), f("alt", "Alt text", "text", "text", true), f("credit", "Credit", "text", "text")];
  }
  // Pulls the values entries already hold (e.g. the tags they use) into a select field's options.
  async function addUsed(r: Row) {
    try {
      const have = new Set(r.options.split("\n").map((o) => o.trim()).filter(Boolean)), more = (await api.values(existing!.key, r.key)).filter((v) => !have.has(v));
      r.options = [...have, ...more].join("\n");
      toast(more.length ? `Added ${more.length} value${more.length === 1 ? "" : "s"}` : "Nothing new to add");
    } catch (e) { error = (e as Error).message; }
  }
  function move(i: number, d: number) { [rows[i], rows[i + d]] = [rows[i + d], rows[i]]; }

  async function save(ev: SubmitEvent) {
    ev.preventDefault(); error = ""; busy = true;
    try {
      const body = {
        label, single, dates, stats, slugSource: sources.some((r) => r.key === slugSource) ? slugSource : undefined, titleField: titles.some((r) => r.key === titleField) ? titleField : null, thumbField: thumbs.some((r) => r.key === thumbField) ? thumbField : null, fields: rows.map(toField),
        format: format === "json" ? null : format, folder: folder.trim() || null, urlTemplate: urlTemplate.trim() || null,
        bodyField: isMd && richRows.some((r) => r.key === bodyField) ? bodyField : null,
      };
      if (existing) await api.updateCollection(existing.key, body);
      else await api.createCollection({ key, ...body });
      await refreshCollections();
      toast(existing ? "Saved" : "Created");
      location.hash = `#/${existing?.key ?? key}`;
    } catch (e) { error = (e as Error).message; }
    busy = false;
  }

  async function remove() {
    if (!existing || !(await ask({ title: `Delete the "${existing.label}" collection?`, confirm: "Delete", danger: true }))) return;
    try { await api.deleteCollection(existing.key); await refreshCollections(); toast("Deleted"); location.hash = "#/"; }
    catch (e) { error = (e as Error).message; }
  }
</script>

{#if ckey && !existing}
  <p class="error">No such collection.</p>
{:else}
  <header><h1>{existing ? existing.label : "New collection"}</h1>{#if existing}<a href="#/{existing.key}">← Back</a>{/if}</header>
  <form onsubmit={save} use:saveShortcut>
    {#if !existing && !rows.length}
      <p class="muted">Building a media library? <button type="button" class="link" onclick={useLibraryTemplate}>Start from an image library</button></p>
    {/if}
    <label>Name <input bind:value={label} required placeholder="Blog posts"
      oninput={() => !existing && !keyTouched && (key = slugify(label))} /></label>
    <label>Key <input bind:value={key} required disabled={!!existing} pattern="[a-z0-9]+(-[a-z0-9]+)*"
      oninput={() => (keyTouched = true)} />
      <small class="muted">Used in URLs and published file paths. Can't be changed later.</small></label>

    <label>Generate entry slugs from
      <select bind:value={slugSource}>
        <option value="">Nothing (type them by hand)</option>
        {#each sources as r (r.uid)}<option value={r.key}>{r.label || r.key}</option>{/each}
      </select>
      <small class="muted">New entries' slugs follow this field as you type, then lock after the first save.</small>
    </label>

    <label class="check"><input type="checkbox" bind:checked={single} />Holds a single entry
      <small class="muted">For a page like the home page or site settings: the list opens that entry directly and a second can't be added.</small>
    </label>
    <label class="check"><input type="checkbox" bind:checked={dates} />Has publish dates
      <small class="muted">Entries get a go-live time: save a draft with a future time and it is published and deployed then. The published file also gets <code>publishedAt</code> and <code>revisedAt</code>.</small></label>
    <label class="check"><input type="checkbox" bind:checked={stats} />Word count and reading time
      <small class="muted">The published file gets <code>wordCount</code> and <code>readingTime</code> (minutes, at 200 words a minute), counted from the body field or, without one, every rich text field. The editor shows them as you write.</small></label>

    <label>Title shown in lists
      <select bind:value={titleField}>
        <option value="">The slug</option>
        {#each titles as r (r.uid)}<option value={r.key}>{r.label || r.key}</option>{/each}
      </select>
      <small class="muted">One text field that names each entry in lists and pickers.</small>
    </label>

    <label>Thumbnail shown in lists
      <select bind:value={thumbField}>
        <option value="">None</option>
        {#each thumbs as r (r.uid)}<option value={r.key}>{r.label || r.key}</option>{/each}
      </select>
      <small class="muted">An image field, or a reference to an image library, shown as a small picture beside each entry.</small>
    </label>

    <label>Publish as
      <select bind:value={format} onchange={() => { if (isMd && !bodyField) bodyField = richRows[0]?.key ?? ""; }}>
        <option value="json">JSON data file</option>
        <option value="markdown">Markdown file with frontmatter</option>
        <option value="mdx">MDX file with frontmatter</option>
      </select>
      <small class="muted">{isMd ? `Fields become YAML frontmatter; the body field becomes the ${format === "mdx" ? "MDX" : "Markdown"} text.` : "Each entry is published as a .json file of its fields."}</small>
    </label>
    <label>Publish into folder
      <input bind:value={folder} placeholder={key || "same as the key"} pattern="[A-Za-z0-9._\-]+(/[A-Za-z0-9._\-]+)*" title="Letters, numbers, dashes, dots and slashes, like content/posts" />
      <small class="muted">Where this collection's files go, inside the publish target's folder. Moving it moves the published files on the next publish.</small>
    </label>
    <label>Page address on the site
      <input bind:value={urlTemplate} placeholder="/blog/{'{slug}'}" pattern={"(/|https?://)\\S*\\{slug\\}\\S*"} title={"Start with / or https:// and include {slug}"} />
      <small class="muted">Where an entry of this collection lives on your site, like <code>/blog/{"{slug}"}</code>. It lets links in text point at these entries, and the address is filled in when you publish. Leave empty if they have no pages.</small>
    </label>
    {#if isMd}
      <label>Body field
        <select bind:value={bodyField}>
          <option value="">None (every field goes in the frontmatter)</option>
          {#each richRows as r (r.uid)}<option value={r.key}>{r.label || r.key}</option>{/each}
        </select>
      </label>
    {/if}

    <h2>Fields</h2>
    {#each rows as row, i (row.uid)}
      <fieldset class="fieldrow">
        <div class="cols">
          <label>Label <input bind:value={row.label} required
            oninput={() => row.isNew && !row.touched && (row.key = camel(row.label))} /></label>
          <label>Key <input bind:value={row.key} required disabled={!row.isNew} pattern="[a-z][a-zA-Z0-9]*"
            oninput={() => (row.touched = true)} /></label>
          {#if row.isNew}
            <label>Type <select value={row.preset} onchange={(e) => onPreset(row, e.currentTarget.value)}>
              {#each PRESETS as p}<option value={p.id}>{p.label}</option>{/each}
            </select></label>
          {:else}
            <label>Type <input value={row.type === "file" ? "image" : row.type} disabled /></label>
          {/if}
        </div>
        {#if row.type === "richtext"}
          <label>Images in the text come from
            <select bind:value={row.library}>
              <option value="">No images</option>
              {#each store.collections.filter((c) => fileFieldOf(c)) as c (c.key)}<option value={c.key}>{c.label}</option>{/each}
            </select>
            <small class="muted">Adds an Image button to the editor. Each image is published as a file and linked from the text.</small>
          </label>
          {#if row.library}
            <label>Image component (MDX)
              <input bind:value={row.imageComponent} placeholder="Image" pattern="[A-Z][A-Za-z0-9]*" />
              <small class="muted">Optional. Adds Align and Size to each image; an image with either is published as <code>&lt;{row.imageComponent || "Image"} src alt align size /&gt;</code> and your site decides how it looks. Needs the MDX format.</small>
            </label>
          {/if}
          <div class="field">Blocks allowed in the text
            {#if store.blocks.length}
              <div class="checks">{#each store.blocks as b (b.key)}
                <label class="check"><input type="checkbox" checked={row.blocks.includes(b.key)} onchange={() => (row.blocks = row.blocks.includes(b.key) ? row.blocks.filter((x) => x !== b.key) : [...row.blocks, b.key])} />{b.label}</label>
              {/each}</div>
            {:else}<small class="muted">None yet. <a href="#/blocks/new">Create a block</a> to use here.</small>{/if}
          </div>
          <div class="field">Templates that can start the text
            {#if store.templates.length}
              <div class="checks">{#each store.templates as t (t.key)}
                <label class="check"><input type="checkbox" checked={row.templates.includes(t.key)} onchange={() => (row.templates = row.templates.includes(t.key) ? row.templates.filter((x) => x !== t.key) : [...row.templates, t.key])} />{t.label}</label>
              {/each}</div>
            {:else}<small class="muted">None yet. <a href="#/templates/new">Create a template</a> to use here.</small>{/if}
          </div>
        {:else if row.type === "reference"}
          <label>Points at
            <select bind:value={row.target} disabled={!row.isNew} required>
              <option value="" disabled>{targets(row).length ? "Choose a collection" : row.libOnly ? "Create an image library first" : "No collections yet"}</option>
              {#each targets(row) as c (c.key)}<option value={c.key}>{c.label}</option>{/each}
            </select>
            {#if !row.isNew}<small class="muted">The target and single/many can't change once the field exists.</small>{/if}
          </label>
        {:else if row.type === "file"}
          <div class="cols">
            <label>Max size (px, longest side)<input type="number" min="0" max="10000" bind:value={row.maxSize} placeholder={String(IMAGE_DEFAULTS.maxSize)} /></label>
            <label>Format<select bind:value={row.format}><option value="keep">Keep original</option><option value="webp">WebP</option><option value="jpeg">JPEG</option></select></label>
            <label>Quality (JPEG, WebP)<input type="number" min="1" max="100" bind:value={row.quality} placeholder={String(IMAGE_DEFAULTS.quality)} /></label>
          </div>
          <label class="check"><input type="checkbox" bind:checked={row.strip} />Remove location and camera metadata</label>
          <small class="muted">Applied in the browser when an image is chosen. Use 0 for no size limit. Animated images are left alone, and the original isn't kept.</small>
          <label>Publish image into folder<input bind:value={row.folder} placeholder="next to the entry" pattern={FILE_FOLDER} /></label>
          <div class="inline">
            <label>Entry value<select bind:value={row.publishAs}><option value="object">Path and size</option><option value="path">Just the path</option></select></label>
            <label class="check"><input type="checkbox" bind:checked={row.keepName} disabled={!row.folder.trim()} />Keep the uploaded file's name</label>
          </div>
          <small class="muted">Folders can use {"{slug}"} and {"{collection}"}, like src/assets/{"{collection}"}/{"{slug}"}. Without a folder the image sits beside its entry. "Just the path" publishes a relative path string; "Path and size" an object with src, width and height.</small>
        {:else if row.type === "datetime"}
          <label>Fill in automatically
            <select bind:value={row.autoSet}>
              <option value="">Never (choose it by hand)</option>
              <option value="create">When the entry is first saved, if left empty</option>
              <option value="save">Every time it's saved</option>
            </select>
          </label>
        {:else if row.type === "select"}
          <label>Options (one per line)<textarea rows="4" bind:value={row.options}></textarea></label>
          {#if existing && !row.isNew}<div><button type="button" class="ghost" onclick={() => addUsed(row)}>Add values already used</button> <small class="muted">Adds what entries in this collection already hold.</small></div>{/if}
          <div class="inline">
            <label class="check"><input type="checkbox" bind:checked={row.multiple} disabled={!row.isNew} />Allow multiple</label>
            <label class="check"><input type="checkbox" bind:checked={row.allowCustom} />Allow new values (tags)</label>
          </div>
        {/if}
        {#if row.type === "text" || row.type === "textarea" || row.type === "richtext"}
          <label>{row.type === "richtext" ? "Capitalise headings" : "Capitalise"}
            <select bind:value={row.casing}>
              <option value="">Never (leave as typed)</option>
              <option value="words">Every word: The Dream And The Work</option>
              <option value="title">Title case: The Dream and the Work</option>
            </select>
          </label>
        {/if}
        <div class="inline">
          {#if canRequire(row)}<label class="check"><input type="checkbox" bind:checked={row.required} />Required</label>{/if}
          <span class="spacer"></span>
          <button type="button" class="ghost" disabled={i === 0} onclick={() => move(i, -1)} aria-label="Move up">↑</button>
          <button type="button" class="ghost" disabled={i === rows.length - 1} onclick={() => move(i, 1)} aria-label="Move down">↓</button>
          <button type="button" class="ghost danger-text" onclick={() => rows.splice(i, 1)}>Remove</button>
        </div>
      </fieldset>
    {:else}
      <p class="muted">No fields yet.</p>
    {/each}
    <div><button type="button" class="icon-btn" aria-label="Add field" title="Add field" onclick={() => rows.push(blank())}><PlusIcon /></button></div>
    {#if existing}<small class="muted">Key and type can't change after a field is created. Removing a field drops its data from entries the next time they're saved.</small>{/if}

    <div class="actions">
      <button type="submit" disabled={busy}>{existing ? "Save" : "Create"}</button>
      {#if existing}<button type="button" class="danger" onclick={remove}>Delete collection</button>{/if}
      <span class="status">{#if error}<span class="error">{error}</span>{/if}</span>
    </div>
  </form>
{/if}
