<script lang="ts">
  import PlusIcon from "./PlusIcon.svelte";
  import TemplatesIcon from "./TemplatesIcon.svelte";
  import { store } from "./store.svelte";
</script>

<header><span class="titlebar"><TemplatesIcon size={26} /><h1>Templates</h1></span><a class="icon-btn" href="#/templates/new" aria-label="New template" title="New template"><PlusIcon /></a></header>
<p class="muted">A starting point for rich text: its content fills a field that is still empty, and its prompt gives connected apps (MCP) context. Allow them per field in a collection's settings.</p>
<table class="list">
  <thead><tr><th>Name</th><th>Content</th><th>Prompt</th></tr></thead>
  <tbody>
    {#each store.templates as t (t.key)}
      <tr>
        <td class="name"><div class="cell"><a class="ell" href="#/templates/{t.key}">{t.label}</a></div></td>
        <td class="muted">{t.body ? "yes" : "prompt only"}</td><td class="muted">{t.prompt ? "yes" : ""}</td>
      </tr>
    {:else}
      <tr><td colspan="3" class="empty"><TemplatesIcon size={32} /><br />No templates yet. <a href="#/templates/new">Create the first one.</a></td></tr>
    {/each}
  </tbody>
</table>
