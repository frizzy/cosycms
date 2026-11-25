<script lang="ts">
  import { toasts } from "./toast.svelte";
</script>

<div class="toasts">
  {#each toasts as t (t.id)}
    <div class="toast {t.kind}" role={t.kind === "error" ? "alert" : "status"}>{t.text}</div>
  {/each}
</div>
