<script lang="ts">
  import { AVATARS } from "../src/avatars";
  import { blobUrl } from "../src/images";
  import UserIcon from "./UserIcon.svelte";

  // A person's picture: an uploaded image, a preset, or the plain person icon until they choose.
  let { avatar, size = 20 }: { avatar?: string | null; size?: number } = $props();
  const preset = $derived(AVATARS.find((a) => a.id === avatar));
</script>

{#if avatar?.startsWith("media/")}<img class="avatar" src={blobUrl(avatar)} alt="" width={size} height={size} />
{:else if preset}
  <svg class="avatar" viewBox="0 0 8 8" width={size} height={size} shape-rendering="crispEdges" aria-hidden="true">
    <rect width="8" height="8" fill={preset.bg} />
    {#each preset.rows as row, y}{#each [...row] as ch, x}{#if ch !== "."}<rect {x} {y} width="1" height="1" fill={ch === "a" ? preset.a : ch === "b" ? preset.b : "#10181b"} />{/if}{/each}{/each}
  </svg>
{:else}<UserIcon />{/if}
