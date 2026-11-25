<script lang="ts">
  import PlusIcon from "./PlusIcon.svelte";
  import { store } from "./store.svelte";
  const holds = { none: "settings only", inline: "text", blocks: "paragraphs, lists and images" } as const;
</script>

<header><h1>Blocks</h1><a class="icon-btn" href="#/blocks/new" aria-label="New block" title="New block"><PlusIcon /></a></header>
<p class="muted">Reusable pieces you can drop into rich text, like a call-out box or a gallery. Allow them per field in a collection's settings.</p>
<table class="list">
  <thead><tr><th>Name</th><th>Component</th><th>Holds</th></tr></thead>
  <tbody>
    {#each store.blocks as b (b.key)}
      <tr>
        <td class="name"><div class="cell"><a class="ell" href="#/blocks/{b.key}">{b.label}</a></div></td>
        <td class="muted">&lt;{b.key}&gt;</td><td class="muted">{holds[b.content]}</td>
      </tr>
    {:else}
      <tr><td colspan="3" class="empty">No blocks yet. <a href="#/blocks/new">Create the first one.</a></td></tr>
    {/each}
  </tbody>
</table>
