<script lang="ts" module>
  import type { Change } from "../src/diff";
  // What the dialog shows: a review before an action (confirm or cancel), a working state, and the result (back to the list or keep editing).
  export type ChangeView = { stage: "review" | "working" | "done"; title: string; status: string; changes: Change[]; confirm?: string; error?: string; empty?: string };
</script>

<script lang="ts">
  let { view, canList = true, onconfirm, onclose, onlist }: { view: ChangeView | null; canList?: boolean; onconfirm: () => void; onclose: () => void; onlist: () => void } = $props();
  let dlg = $state<HTMLDialogElement>();
  const portal = (node: HTMLElement) => { document.body.appendChild(node); return { destroy: () => node.remove() }; };
  $effect(() => { if (view && dlg && !dlg.open) dlg.showModal(); });
  const n = $derived(view?.changes.length ?? 0);
</script>

{#if view}
  <dialog bind:this={dlg} use:portal aria-labelledby="cd-title" oncancel={(e) => { e.preventDefault(); if (view.stage !== "working") onclose(); }}>
    <header><h1 id="cd-title">{view.title}</h1></header>
    <p class="cd-status">{view.status}</p>
    {#if view.error}<p class="error">{view.error}</p>{/if}
    {#if n}
      <h2 class="cd-h">{n} change{n === 1 ? "" : "s"}</h2>
      <div class="changes">
        {#each view.changes as c (c.key)}
          <section class="chg">
            <h3>{c.label}</h3>
            {#if c.kind === "value"}
              <div class="del">{c.before}</div><div class="add">{c.after}</div>
            {:else if c.kind === "list"}
              <div class="chips">{#each c.removed as r}<span class="chip del">{r}</span>{/each}{#each c.added as a}<span class="chip add">{a}</span>{/each}</div>
            {:else if c.kind === "lines"}
              <div class="lines">
                {#each c.lines as l}
                  {#if l.t === "gap"}<div class="gap">{l.n} unchanged line{l.n === 1 ? "" : "s"}</div>
                  {:else}<div class={l.t}><span class="sign" aria-hidden="true">{l.t === "add" ? "+" : l.t === "del" ? "−" : ""}</span>{l.s}</div>{/if}
                {/each}
              </div>
            {:else}<div class="muted">{c.note}</div>{/if}
          </section>
        {/each}
      </div>
    {:else if view.stage !== "working" && view.empty !== ""}<p class="muted">{view.empty ?? "No changes to the content."}</p>{/if}
    <div class="dialog-actions">
      {#if view.stage === "review"}
        <button type="button" class="ghost" onclick={onclose}>Cancel</button><span class="spacer"></span>
        <button type="button" onclick={onconfirm}>{view.confirm ?? "Confirm"}</button>
      {:else if view.stage === "working"}
        <span class="spacer"></span><button type="button" disabled>Working…</button>
      {:else}
        <button type="button" class="ghost" onclick={onclose}>{canList ? "Keep editing" : "Close"}</button><span class="spacer"></span>
        {#if canList}<button type="button" onclick={onlist}>Back to list</button>{/if}
      {/if}
    </div>
  </dialog>
{/if}
