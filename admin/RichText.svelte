<script lang="ts">
  import { Editor } from "@tiptap/core";
  import { blockExtensions, richExtensions } from "./extensions";
  import BlockDialog from "./BlockDialog.svelte";
  import { blockNodeType, type BlockDef } from "../src/blocks";
  import type { TemplateDef } from "../src/templates";
  import { toMarkdown } from "../src/markdown";
  import { fromMarkdown, LIBRARY_PREFIX } from "../src/markdown-import";
  import { api } from "./api";
  import { store } from "./store.svelte";
  import { entryLabel, fileFieldOf } from "../src/fields";
  import { blobUrl, type FileValue } from "../src/images";
  import PickerDialog from "./PickerDialog.svelte";
  import LinkDialog from "./LinkDialog.svelte";
  import { untrack } from "svelte";

  // `value` is Tiptap JSON. Legacy plain-text values (from the old textarea field) are converted on load.
  let { value = $bindable(), library, blocks = [], imageComponent, templates = [] }: { value?: unknown; library?: string; blocks?: BlockDef[]; imageComponent?: string; templates?: TemplateDef[] } = $props();
  const blockMap = $derived(new Map(blocks.map((b) => [b.key, b])));
  const libCol = $derived(library ? store.collections.find((c) => c.key === library) : undefined);

  let host: HTMLDivElement;
  let editor: Editor | undefined;
  let tick = $state(0); // bumped on every transaction so toolbar state re-renders

  // Blocks: their settings are edited in a dialog; text blocks are edited in place.
  let blockDlg: BlockDialog;
  let menuOpen = $state(false);
  function editBlock(pos: number) {
    const n = editor?.state.doc.nodeAt(pos), def = n && blockMap.get(n.attrs.name);
    if (!n || !def) return;
    blockDlg.open(def, n.attrs.props, (props) => editor!.chain().focus().command(({ tr }) => { tr.setNodeMarkup(pos, undefined, { ...n.attrs, props }); return true; }).run());
  }
  // Removing is undoable (Ctrl/Cmd+Z), so only a block that holds something asks first.
  function removeBlock(pos: number) {
    const n = editor?.state.doc.nodeAt(pos);
    if (!n) return;
    if (n.textContent.trim() && !confirm("Remove this block and what's inside it?")) return;
    editor!.chain().focus().deleteRange({ from: pos, to: pos + n.nodeSize }).run();
  }
  // A template fills a field that is still empty, so only then is it offered.
  const blank = $derived.by(() => { tick; return !!editor && editor.isEmpty; });
  let tplOpen = $state(false);
  function useTemplate(t: TemplateDef) { tplOpen = false; editor!.chain().focus().setContent(t.body as object, { emitUpdate: true }).run(); }
  function insertBlock(key: string) {
    const def = blockMap.get(key);
    if (!def) return;
    const type = blockNodeType(def.content);
    const insert = (props: Record<string, unknown>) => {
      const ed = editor!, at = ed.state.selection.to, attrs = { name: def.key, props };
      // With something selected, a block that holds content wraps it instead of replacing it.
      if (!ed.state.selection.empty && def.content !== "none" && (def.content === "blocks" ? ed.chain().focus().wrapIn(type, attrs).run() : ed.chain().focus().setNode(type, attrs).run())) return;
      ed.chain().focus().insertContent({
        type, attrs: { name: def.key, props },
        ...(def.content === "blocks" ? { content: [{ type: "paragraph" }] } : def.content === "inline" ? { content: [] } : {}),
      }).run();
      if (def.content === "none") return;
      // Put the cursor inside the new block, so you can start typing straight away.
      let found = -1;
      ed.state.doc.descendants((n, pos) => { if (found < 0 && pos >= at - 1 && n.type.name === type && n.attrs.name === def.key) { found = pos; return false; } });
      if (found >= 0) ed.chain().focus(found + 1).run();
    };
    if (def.props.length) blockDlg.open(def, {}, insert); else insert({});
  }

  const fromText = (t: string) => ({
    type: "doc",
    content: t.split(/\n{2,}/).filter(Boolean).map((p) => ({ type: "paragraph", content: [{ type: "text", text: p }] })),
  });

  // Runs once: `value` is read untracked, otherwise every keystroke would rebuild the editor.
  $effect(() => untrack(() => {
    const initial = value;
    const ed = new Editor({
      element: host,
      extensions: [...richExtensions({ replace: (pos) => { replacing = pos; picker?.open(); }, remove: removeImage, href: (id) => (library ? `#/${library}/${id}` : undefined), options: () => !!imageComponent, set: setImage }), ...blockExtensions(blocks, { edit: editBlock, remove: removeBlock })],
      content: typeof initial === "string" ? fromText(initial) : (initial as object | undefined),
      onTransaction: () => queueMicrotask(() => tick++), // deferred: a blur fired while the editor is being torn down must not mutate state mid-teardown
      onUpdate: ({ editor }) => (value = editor.getJSON()),
    });
    // Normalise so saving without editing doesn't send the legacy string.
    if (typeof initial === "string") value = ed.getJSON();
    editor = ed; tick++; // the toolbar was drawn before the editor existed
    return () => ed.destroy();
  }));

  const buttons = [
    { label: "B", title: "Bold", on: (c: any) => c.toggleBold(), active: "bold" },
    { label: "I", title: "Italic", on: (c: any) => c.toggleItalic(), active: "italic" },
    { label: "H2", title: "Heading 2", on: (c: any) => c.toggleHeading({ level: 2 }), active: ["heading", { level: 2 }] },
    { label: "H3", title: "Heading 3", on: (c: any) => c.toggleHeading({ level: 3 }), active: ["heading", { level: 3 }] },
    { label: "•", title: "Bullet list", on: (c: any) => c.toggleBulletList(), active: "bulletList" },
    { label: "1.", title: "Numbered list", on: (c: any) => c.toggleOrderedList(), active: "orderedList" },
    { label: "❝", title: "Quote", on: (c: any) => c.toggleBlockquote(), active: "blockquote" },
  ] as const;

  const isActive = (a: unknown) => { tick; return Array.isArray(a) ? editor?.isActive(a[0], a[1]) : editor?.isActive(a as string); };

  // Markdown view: shows exactly what will be published, and lets you paste or edit Markdown to replace the content.
  let dlg: HTMLDialogElement;
  let md = $state(""), mdError = $state("");
  function portal(node: HTMLElement) { document.body.appendChild(node); return { destroy: () => node.remove() }; }
  // Library images appear in the Markdown view as ![alt](cosy:entry/<id>), so applying it keeps them linked to the library.
  function openMarkdown() { md = toMarkdown(editor!.getJSON() as never, (id, a) => ({ src: LIBRARY_PREFIX + id, alt: String(a.alt ?? "") }), { mdx: blocks.length > 0 || !!imageComponent, blocks: blockMap, imageComponent }); mdError = ""; dlg.showModal(); }
  async function applyMarkdown() {
    try {
      const nodes = fromMarkdown(md, { mdx: blocks.length > 0 || !!imageComponent, blocks, imageComponent });
      // The preview pictures aren't in the Markdown (only entry ids are), so look them up in the libraries they come from.
      const pics: { entry: string; src?: string }[] = [];
      const collect = (n: { type: string; attrs?: Record<string, any>; content?: any[] }) => {
        if (n.type === "libraryImage") pics.push(n.attrs as any);
        else if (n.type.startsWith("block")) for (const v of Object.values(n.attrs?.props ?? {})) if (Array.isArray(v)) pics.push(...v.filter((i) => i?.entry));
        n.content?.forEach(collect);
      };
      nodes.forEach(collect);
      if (pics.length) {
        const libs = [...new Set([library, ...blocks.flatMap((b) => b.props.flatMap((p) => (p.type === "images" ? [p.library] : [])))].filter(Boolean) as string[])];
        const byId = new Map((await Promise.all(libs.map((l) => api.list(l)))).flat().map((e) => [e.id, e]));
        for (const p of pics) {
          const e = byId.get(p.entry), col = e && store.collections.find((c) => c.key === e.collection), ff = col && fileFieldOf(col), f = e && ff && (e.data[ff.key] as FileValue | undefined);
          if (f) p.src = blobUrl(f.key);
        }
      }
      editor!.commands.setContent({ type: "doc", content: nodes.length ? nodes : [{ type: "paragraph" }] }, { emitUpdate: true });
      dlg.close();
    } catch (e) { mdError = (e as Error).message; }
  }

  // Inserts an image from the library; the entry id is what's stored.
  let picker: PickerDialog;
  let replacing: number | undefined; // set while the picker is open to swap an existing image
  function setImage(pos: number, attrs: Record<string, string>) {
    const n = editor?.state.doc.nodeAt(pos);
    if (n) editor!.chain().command(({ tr }) => { tr.setNodeMarkup(pos, undefined, { ...n.attrs, ...attrs }); return true; }).run();
  }
  function removeImage(pos: number) {
    const n = editor?.state.doc.nodeAt(pos);
    if (n) editor!.chain().focus().deleteRange({ from: pos, to: pos + n.nodeSize }).run();
  }
  function insertImage(ids: string[], entries: { id: string; slug: string; data: Record<string, unknown> }[]) {
    const e = entries.find((x) => x.id === ids[0]), ff = libCol && fileFieldOf(libCol), f = e && ff && (e.data[ff.key] as FileValue | undefined);
    if (!e || !f || !libCol) return;
    const attrs = { entry: e.id, src: blobUrl(f.key), alt: entryLabel(libCol.fields, e.data, e.slug) };
    const at = replacing, old = at === undefined ? undefined : editor!.state.doc.nodeAt(at);
    replacing = undefined;
    if (old?.type.name === "libraryImage") editor!.chain().focus().command(({ tr }) => { tr.setNodeMarkup(at!, undefined, attrs); return true; }).run();
    else editor!.chain().focus().insertContent({ type: "libraryImage", attrs }).run();
  }

  let linkDlg: LinkDialog;
  function link() {
    if (!editor) return;
    linkDlg.open(editor.getAttributes("link").href ?? "", (href) => {
      const c = editor!.chain().focus().extendMarkRange("link");
      (href ? c.setLink({ href }) : c.unsetLink()).run();
    });
  }
</script>

<svelte:window onclick={(e) => { if (!(e.target as Element).closest(".blockmenu")) { menuOpen = false; tplOpen = false; } }} onkeydown={(e) => { if (e.key === "Escape") menuOpen = tplOpen = false; }} />
<div class="editor">
  <!-- mousedown preventDefault keeps focus (and the selection) in the editor when clicking buttons -->
  <div class="toolbar" role="toolbar" tabindex="-1" onmousedown={(e) => e.preventDefault()}>
    {#each buttons as b}
      <button type="button" title={b.title} class:on={isActive(b.active)} onclick={() => b.on(editor!.chain().focus()).run()}>{b.label}</button>
    {/each}
    <button type="button" title="Link" class:on={isActive("link")} onclick={link}>🔗</button>
    {#if library}<button type="button" title="Insert an image from the library" onclick={() => { replacing = undefined; picker.open(); }}>Image</button>{/if}
    {#if blocks.length}
      <!-- A menu of our own, not a <select>: the toolbar cancels mousedown to keep the editor's selection, which native dropdowns don't survive in every browser. -->
      <div class="blockmenu">
        <button type="button" aria-haspopup="menu" aria-expanded={menuOpen} onclick={() => (menuOpen = !menuOpen)}>Block ▾</button>
        {#if menuOpen}
          <ul role="menu" class="menu-pop">
            {#each blocks as b (b.key)}<li role="none"><button type="button" role="menuitem" onclick={() => { menuOpen = false; insertBlock(b.key); }}>{b.label}</button></li>{/each}
          </ul>
        {/if}
      </div>
    {/if}
    {#if templates.length && blank}
      <div class="blockmenu">
        <button type="button" aria-haspopup="menu" aria-expanded={tplOpen} onclick={() => (tplOpen = !tplOpen)}>Start from… ▾</button>
        {#if tplOpen}
          <ul role="menu" class="menu-pop">
            {#each templates as t (t.key)}<li role="none"><button type="button" role="menuitem" onclick={() => useTemplate(t)}>{t.label}</button></li>{/each}
          </ul>
        {/if}
      </div>
    {/if}
    <button type="button" class="md" title="View, edit or paste Markdown" onclick={openMarkdown}>Markdown</button>
  </div>
  <div bind:this={host}></div>
</div>

<dialog bind:this={dlg} use:portal aria-labelledby="md-title">
  <header><h1 id="md-title">Markdown</h1><button type="button" class="icon-btn close" aria-label="Close" onclick={() => dlg.close()}>×</button></header>
  <p class="muted">This is what gets published. Edit it or paste Markdown here, then apply to replace the content. HTML, tables and anything else the editor can't show is kept exactly as written.</p>
  <textarea class="mdbox" bind:value={md} spellcheck="false" aria-label="Markdown"></textarea>
  <div class="dialog-actions">
    <span><button type="button" onclick={applyMarkdown}>Apply</button> <button type="button" class="ghost" onclick={() => dlg.close()}>Cancel</button></span>
    <span class="status">{#if mdError}<span class="error">{mdError}</span>{/if}</span>
  </div>
</dialog>

{#if library}<PickerDialog bind:this={picker} collection={library} onchange={insertImage} />{/if}
<BlockDialog bind:this={blockDlg} />
<LinkDialog bind:this={linkDlg} />
