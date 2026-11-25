<script lang="ts">
  import { OPEN_SVG } from "./openIcon";
  let { href, label }: { href: string; label: string } = $props();
</script>
<a class="open" {href} target="_blank" rel="noopener" aria-label={label} title={label}>{@html OPEN_SVG}</a>
