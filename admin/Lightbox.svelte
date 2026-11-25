<script lang="ts">
  import { store } from "./store.svelte";
  let dlg: HTMLDialogElement;
  $effect(() => { if (store.zoom && !dlg.open) dlg.showModal(); });
</script>

<!-- Click anywhere (or press Esc) to close. -->
<dialog bind:this={dlg} class="lightbox" aria-label="Image preview" onclose={() => (store.zoom = undefined)} onclick={() => dlg.close()}>
  {#if store.zoom}<img src={store.zoom.src} alt={store.zoom.alt} />{#if store.zoom.alt}<p>{store.zoom.alt}</p>{/if}{/if}
</dialog>
