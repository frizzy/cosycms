<script lang="ts">
  import { confirmState } from "./confirm.svelte";
  let dlg = $state<HTMLDialogElement>(), cancelBtn = $state<HTMLButtonElement>(), okBtn = $state<HTMLButtonElement>();
  const portal = (node: HTMLElement) => { document.body.appendChild(node); return { destroy: () => node.remove() }; };
  const q = $derived(confirmState.current);
  // The safe choice has focus when a destructive action is asked about, so a stray Enter never confirms it.
  $effect(() => { if (q && dlg && !dlg.open) { dlg.showModal(); (q.danger ? cancelBtn : okBtn)?.focus(); } });
  function answer(ok: boolean) { const c = confirmState.current; confirmState.current = null; c?.resolve(ok); }
</script>

{#if q}
  <dialog bind:this={dlg} use:portal class="ask" aria-labelledby="ask-title" oncancel={(e) => { e.preventDefault(); answer(false); }}>
    <header><h1 id="ask-title">{q.title}</h1></header>
    {#if q.message}<p class="ask-msg">{q.message}</p>{/if}
    <div class="dialog-actions">
      <button type="button" class="ghost" bind:this={cancelBtn} onclick={() => answer(false)}>{q.cancel ?? "Cancel"}</button><span class="spacer"></span>
      <button type="button" class:danger={q.danger} bind:this={okBtn} onclick={() => answer(true)}>{q.confirm ?? "Confirm"}</button>
    </div>
  </dialog>
{/if}
