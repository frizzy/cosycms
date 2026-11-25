<script lang="ts">
  let { label = false }: { label?: boolean } = $props(); // label: a full-width menu row instead of a bare icon
  // Follows the system until the first click; after that the choice is remembered in this browser.
  const query = matchMedia("(prefers-color-scheme: dark)");
  let dark = $state((document.documentElement.dataset.theme ?? (query.matches ? "dark" : "light")) === "dark");
  $effect(() => {
    const on = () => { if (!document.documentElement.dataset.theme) dark = query.matches; };
    query.addEventListener("change", on);
    return () => query.removeEventListener("change", on);
  });
  function toggle() {
    dark = !dark;
    const t = dark ? "dark" : "light";
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem("theme", t); } catch {} // private windows can refuse storage; the switch still works for this visit
  }
</script>

{#snippet icon(size: number)}
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    {#if dark}<circle cx="12" cy="12" r="4" /><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" />
    {:else}<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />{/if}
  </svg>
{/snippet}

{#if label}
  <button type="button" class="navrow" onclick={toggle}>{@render icon(18)}{dark ? "Light mode" : "Dark mode"}</button>
{:else}
  <button type="button" class="icon-btn theme" onclick={toggle} aria-label={dark ? "Switch to light mode" : "Switch to dark mode"} title={dark ? "Light mode" : "Dark mode"}>{@render icon(20)}</button>
{/if}
