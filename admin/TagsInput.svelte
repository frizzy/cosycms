<script lang="ts">
  let { value = $bindable(), suggestions = [] }: { value?: string[]; suggestions?: string[] } = $props();
  const list = $derived(value ?? []); // undefined on a new entry
  let draft = $state("");
  const listId = `tags-${Math.random().toString(36).slice(2)}`;

  function add(t: string) {
    t = t.trim();
    if (t && !list.includes(t)) value = [...list, t];
    draft = "";
  }
  function onkeydown(e: KeyboardEvent) {
    if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add(draft); }
    else if (e.key === "Backspace" && !draft) value = list.slice(0, -1);
  }
  // Picking from the datalist replaces the text in one step, so add it right away.
  const oninput = (e: Event) => (e as InputEvent).inputType === "insertReplacementText" && add(draft);
</script>

<div class="tags">
  {#each list as t (t)}
    <span class="chip">{t}<button type="button" aria-label="Remove {t}" onclick={() => (value = list.filter((x) => x !== t))}>×</button></span>
  {/each}
  <input list={listId} bind:value={draft} {onkeydown} {oninput} onblur={() => add(draft)} placeholder="Add…" />
  <datalist id={listId}>{#each suggestions.filter((s) => !list.includes(s)) as s}<option value={s}></option>{/each}</datalist>
</div>
