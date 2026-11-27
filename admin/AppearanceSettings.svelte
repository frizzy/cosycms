<script lang="ts">
  // Per browser, like the light/dark choice: it is how this person likes to look at the admin, not a site setting.
  let retro = $state(document.documentElement.dataset.style !== "plain");
  function set(on: boolean) {
    retro = on;
    document.documentElement.dataset.style = on ? "retro" : "plain";
    try { localStorage.setItem("style", on ? "retro" : "plain"); } catch {} // private windows can refuse storage; it still applies for this visit
  }
</script>

<section class="stack">
  <label class="inline"><input type="checkbox" checked={retro} onchange={(e) => set(e.currentTarget.checked)} /> Retro controls</label>
  <p class="muted">Flat, square checkboxes, bulk bar and date picker with a hard edge and a monospace label. Turn off for the standard rounded look. This is remembered in this browser only.</p>
</section>
