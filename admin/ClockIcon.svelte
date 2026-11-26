<script lang="ts">
  // Marks an entry that is scheduled to go live later.
  let { size = 15 }: { size?: number } = $props();
</script>
<svg class="clock" viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />
</svg>
