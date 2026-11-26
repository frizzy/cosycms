<script lang="ts">
  import { ask } from "./confirm.svelte";
  import { api, type Provider } from "./api";
  import { store } from "./store.svelte";
  import { toast } from "./toast.svelte";
  let providers = $state<Provider[]>([]), loading = $state(true), error = $state("");
  let draft = $state<Record<string, { clientId: string; secret: string }>>({});
  const load = () => api.providers().then((p) => {
    providers = p; loading = false;
    store.signIn = p.filter((x) => x.source).length;
    for (const x of p) draft[x.id] = { clientId: x.clientId, secret: "" };
  }, (e) => { error = e.message; loading = false; });
  $effect(() => { load(); });
  async function save(ev: SubmitEvent, p: Provider) {
    ev.preventDefault(); error = "";
    try { await api.saveProvider(p.id, draft[p.id].clientId, draft[p.id].secret); toast(`${p.name} saved`); await load(); } catch (e) { error = (e as Error).message; }
  }
  async function remove(p: Provider) {
    if (!(await ask({ title: `Stop offering ${p.name} sign-in?`, message: "People who use it will need a password.", confirm: "Stop offering", danger: true }))) return;
    try { await api.clearProvider(p.id); toast(`${p.name} removed`); await load(); } catch (e) { error = (e as Error).message; }
  }
</script>

<p class="muted">Let people sign in with an account they already have. They're matched by a verified email, so each person still needs to be invited under People. Password sign-in keeps working.</p>
{#if (store.signIn ?? 1) === 0}<p class="notice">Set up at least one of these to finish setting up.</p>{/if}
{#if loading}<p class="muted">Loading…</p>{/if}
{#each providers as p (p.id)}
  <form class="stack provider" onsubmit={(e) => save(e, p)}>
    <h2>{p.name} {#if p.source}<small class="muted">active{p.source === "environment" ? " · from server settings" : ""}</small>{/if}</h2>
    <p class="muted">{p.help}<br />Callback URL to register: <code>{p.callback}</code></p>
    <label>Client ID <input bind:value={draft[p.id].clientId} autocomplete="off" required /></label>
    <label>Client secret
      <input type="password" bind:value={draft[p.id].secret} autocomplete="off" placeholder={p.hasSecret ? "•••••••• saved — leave blank to keep" : ""} />
      <small class="muted">Stored encrypted and never shown again.</small>
      {#if p.error}<small class="error">{p.error}</small>{/if}
    </label>
    <div class="inline">
      <button type="submit">Save</button>
      {#if p.clientId || p.hasSecret}<button type="button" class="danger" onclick={() => remove(p)}>Remove</button>{/if}
    </div>
  </form>
{/each}
{#if error}<p class="error">{error}</p>{/if}
