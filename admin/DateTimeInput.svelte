<script lang="ts">
  // A date and time picker. The value is a UTC ISO string (or undefined when empty); the picker works in the browser's timezone.
  // Native datetime-local inputs are unreliable (Safari shows a default date but keeps the value empty until every part is touched),
  // so this is a calendar plus a time box, and choosing either part fills in a sensible other part.
  let { value = $bindable(), disabled = false }: { value?: string; disabled?: boolean } = $props();

  const DEFAULT_TIME = [9, 0];
  const pad = (n: number) => String(n).padStart(2, "0");
  const parsed = $derived(value && !isNaN(Date.parse(value)) ? new Date(value) : null);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const label = $derived(parsed ? parsed.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }) : "");
  const timeText = $derived(parsed ? `${pad(parsed.getHours())}:${pad(parsed.getMinutes())}` : "");

  let open = $state(false), view = $state(new Date()), root = $state<HTMLElement>(), trigger = $state<HTMLButtonElement>();
  const month = $derived(view.toLocaleString(undefined, { month: "long", year: "numeric" }));
  const names = Array.from({ length: 7 }, (_, i) => new Date(2024, 0, 1 + i).toLocaleString(undefined, { weekday: "short" })); // 2024-01-01 is a Monday
  // The weeks of the shown month, Monday first; null pads the first week.
  const days = $derived.by(() => {
    const first = new Date(view.getFullYear(), view.getMonth(), 1), n = new Date(view.getFullYear(), view.getMonth() + 1, 0).getDate();
    return [...Array((first.getDay() + 6) % 7).fill(null), ...Array.from({ length: n }, (_, i) => i + 1)] as (number | null)[];
  });
  const same = (a: Date | null, y: number, m: number, d: number) => !!a && a.getFullYear() === y && a.getMonth() === m && a.getDate() === d;
  const today = new Date();

  function show() {
    if (disabled) return;
    const b = parsed ?? new Date();
    view = new Date(b.getFullYear(), b.getMonth(), 1);
    open = true;
  }
  const set = (y: number, m: number, d: number, h: number, min: number) => (value = new Date(y, m, d, h, min).toISOString());
  function pickDay(d: number) {
    set(view.getFullYear(), view.getMonth(), d, parsed?.getHours() ?? DEFAULT_TIME[0], parsed?.getMinutes() ?? DEFAULT_TIME[1]);
  }
  function pickTime(t: string) {
    const [h, min] = t.split(":").map(Number);
    if (!t || isNaN(h)) return;
    const base = parsed ?? new Date(); // a time with no date yet means today
    set(base.getFullYear(), base.getMonth(), base.getDate(), h, min);
  }
  const step = (by: number) => (view = new Date(view.getFullYear(), view.getMonth() + by, 1));
  function close() { open = false; trigger?.focus(); }
</script>

<svelte:window onpointerdown={(e) => { if (open && root && !root.contains(e.target as Node)) open = false; }} onkeydown={(e) => { if (open && e.key === "Escape") close(); }} />

<div class="dt" bind:this={root}>
  <button type="button" class="dt-trigger" bind:this={trigger} {disabled} aria-haspopup="dialog" aria-expanded={open} onclick={() => (open ? close() : show())}>
    {#if label}{label}{:else}<span class="muted">Pick a date and time</span>{/if}
  </button>
  {#if open}
    <div class="dt-pop" role="dialog" aria-label="Pick a date and time">
      <div class="dt-head">
        <button type="button" class="ghost" aria-label="Previous month" onclick={() => step(-1)}>‹</button>
        <strong>{month}</strong>
        <button type="button" class="ghost" aria-label="Next month" onclick={() => step(1)}>›</button>
      </div>
      <div class="dt-grid" role="grid">
        {#each names as n}<span class="dt-dow" aria-hidden="true">{n}</span>{/each}
        {#each days as d}
          {#if d === null}<span></span>
          {:else}<button type="button" class="dt-day" class:sel={same(parsed, view.getFullYear(), view.getMonth(), d)} class:now={same(today, view.getFullYear(), view.getMonth(), d)} aria-pressed={same(parsed, view.getFullYear(), view.getMonth(), d)} onclick={() => pickDay(d)}>{d}</button>{/if}
        {/each}
      </div>
      <div class="dt-foot">
        <label>Time <input type="time" value={timeText} onchange={(e) => pickTime(e.currentTarget.value)} /></label>
        <button type="button" class="ghost" onclick={() => { value = undefined; close(); }} disabled={!parsed}>Clear</button>
        <button type="button" onclick={close}>Done</button>
      </div>
      <small class="muted">Times are in {zone}.</small>
    </div>
  {/if}
</div>
