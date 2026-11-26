<script lang="ts">
  import { ask } from "./confirm.svelte";
  import { api } from "./api";
  import { store, refreshCollections } from "./store.svelte";
  import { toast } from "./toast.svelte";
  import { saveShortcut } from "./keys";
  import RichText from "./RichText.svelte";
  import { TemplateDef } from "../src/templates";

  // Edits one template: a name, optional starting content (written in the same editor, with every block available), and a prompt.
  let { tkey }: { tkey?: string } = $props();
  const existing = tkey ? store.templates.find((t) => t.key === tkey) : undefined;
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^[^a-z]+|-+$/g, "");

  let label = $state(existing?.label ?? ""), key = $state(existing?.key ?? ""), prompt = $state(existing?.prompt ?? "");
  let body = $state<unknown>(existing?.body ?? undefined), keyTouched = $state(!!existing), error = $state(""), busy = $state(false);
  // An editor left empty counts as no content, so a prompt-only template stays that way.
  const hasContent = (b: any) => !!b?.content?.some((n: any) => n.type !== "paragraph" || n.content?.length);

  async function save(ev: SubmitEvent) {
    ev.preventDefault(); error = ""; busy = true;
    try {
      await api.saveTemplate(TemplateDef.parse({ key, label, prompt, body: hasContent(body) ? body : null }));
      await refreshCollections(); toast("Saved"); location.hash = "#/templates";
    } catch (e) { error = e instanceof Error && "issues" in e ? (e as any).issues.map((i: any) => i.message).join("; ") : (e as Error).message; }
    busy = false;
  }
  async function remove() {
    if (!existing || !(await ask({ title: `Delete the "${existing.label}" template?`, confirm: "Delete", danger: true }))) return;
    try { await api.deleteTemplate(existing.key); await refreshCollections(); toast("Deleted"); location.hash = "#/templates"; }
    catch (e) { error = (e as Error).message; }
  }
</script>

{#if tkey && !existing}
  <p class="error">No such template.</p>
{:else}
  <header><h1>{existing ? existing.label : "New template"}</h1><a href="#/templates">← Back</a></header>
  <form onsubmit={save} use:saveShortcut>
    <label>Name <input bind:value={label} required placeholder="How-to article" oninput={() => !existing && !keyTouched && (key = slug(label))} /></label>
    <label>Key <input bind:value={key} required disabled={!!existing} pattern="[a-z][a-z0-9\-]*" oninput={() => (keyTouched = true)} />
      <small class="muted">What connected apps call it. It can't be changed later.</small></label>
    <label>Prompt <textarea rows="5" bind:value={prompt} placeholder="Open with a short anecdote, keep it under 800 words, end with a tips list."></textarea>
      <small class="muted">Context for connected apps (MCP): how to write with this template, or what it is for. It works without any content, for example to guide image generation.</small></label>
    <div class="field">Content
      <RichText bind:value={body} blocks={store.blocks} />
      <small class="muted">Optional. Placeholder text and blocks that fill a rich text field that is still empty. A field can only use a template whose blocks it allows.</small>
    </div>
    <div class="actions">
      <button type="submit" disabled={busy}>{existing ? "Save" : "Create"}</button>
      {#if existing}<button type="button" class="danger" onclick={remove}>Delete template</button>{/if}
      <span class="status">{#if error}<span class="error">{error}</span>{/if}</span>
    </div>
  </form>
{/if}
