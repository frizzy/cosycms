<script lang="ts">
  // The keys that work anywhere or in a list. Opened with ? (or from the command palette).
  let dlg: HTMLDialogElement;
  const portal = (node: HTMLElement) => { document.body.appendChild(node); return { destroy: () => node.remove() }; };
  export function show() { if (!dlg.open) dlg.showModal(); }
  const mac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform), mod = mac ? "⌘" : "Ctrl";
  const keys = [
    [`${mod} K`, "Search and jump to anything"], [`${mod} S`, "Save the form you are in"],
    ["J / K", "Next / previous row in a list"], ["Enter or O", "Open the highlighted row"], ["X", "Select the highlighted row"], ["?", "Show this list"],
  ];
</script>

<dialog bind:this={dlg} use:portal aria-labelledby="sc-title" onclick={(e) => { if (e.target === dlg) dlg.close(); }}>
  <header><h1 id="sc-title">Keyboard shortcuts</h1><button type="button" class="icon-btn close" aria-label="Close" onclick={() => dlg.close()}>×</button></header>
  <dl class="keys">{#each keys as [k, what]}<dt><kbd>{k}</kbd></dt><dd>{what}</dd>{/each}</dl>
</dialog>

<style>
  .keys { display:grid; grid-template-columns:auto 1fr; gap:.5rem 1rem; margin:0; align-items:center; } .keys dd { margin:0; }
  kbd { font:inherit; font-size:.85rem; padding:.1rem .45rem; border:1px solid var(--line); border-radius:4px; background:var(--panel, transparent); white-space:nowrap; }
</style>
