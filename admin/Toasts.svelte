<script lang="ts">
  import { toasts, dismiss } from "./toast.svelte";
  let busy = $state(0);
  async function act(id: number, run: () => void | Promise<void>) { busy = id; try { await run(); } finally { busy = 0; dismiss(id); } }
</script>

<div class="toasts">
  {#each toasts as t (t.id)}
    <div class="toast {t.kind}" role={t.kind === "error" ? "alert" : "status"}>{t.text}{#if t.action}<button type="button" class="ghost" disabled={busy === t.id} onclick={() => act(t.id, t.action!.run)}>{t.action.label}</button>{/if}</div>
  {/each}
</div>
