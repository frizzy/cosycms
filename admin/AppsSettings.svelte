<script lang="ts">
  import { api, type Connection } from "./api";
  import { toast } from "./toast.svelte";
  let apps = $state<Connection[]>([]), error = $state("");
  const load = () => api.connections().then((a) => (apps = a), () => {});
  $effect(() => { load(); });
  async function disconnect(a: Connection) {
    if (!confirm(`Disconnect ${a.name}? It will need your password to connect again.`)) return;
    try { await api.disconnect(a.id); toast("Disconnected"); await load(); } catch (e) { error = (e as Error).message; }
  }
</script>

<section class="stack">
  <h2>Connected apps</h2>
  {#if !apps.length}<p class="muted">Nothing is connected. Apps like MCP clients appear here after you approve them.</p>{/if}
  {#each apps as a (a.id)}
    <div class="inline">
      <span style="flex:1"><strong>{a.name}</strong> <small class="muted">active {new Date(a.lastActive).toLocaleString()}</small></span>
      <button type="button" class="danger" onclick={() => disconnect(a)}>Disconnect</button>
    </div>
  {/each}
  {#if error}<p class="error">{error}</p>{/if}
</section>
