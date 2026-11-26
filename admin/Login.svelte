<script lang="ts">
  import Logo from "./Logo.svelte";
  import ThemeToggle from "./ThemeToggle.svelte";
  import { api } from "./api";
  import { store } from "./store.svelte";

  // /login?next=… (sent here by an app asking to connect) and /invite/<secret> (set a password) both land on this screen.
  const params = new URLSearchParams(location.search);
  const next = params.get("next");
  const secret = location.pathname.match(/^\/invite\/([\w-]+)/)?.[1];
  const safe = (n: string | null) => (n && /^\/(?![/\\])/.test(n) ? n : null);

  let email = $state(""), setupToken = $state(""), password = $state(""), error = $state(""), busy = $state(false);
  let info = $state<Awaited<ReturnType<typeof api.authInfo>>>();
  let invitee = $state("");
  $effect(() => {
    api.authInfo().then((i) => (info = i), (e) => (error = e.message));
    if (secret) api.invitee(secret).then((i) => (invitee = i.email), (e) => (error = e.message));
  });

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    busy = true; error = "";
    try {
      if (secret) await api.acceptInvite(secret, password);
      else if (info?.needsSetup) await api.setup(email, password, setupToken);
      else await api.login(email, password);
      password = "";
      const to = secret ? "/" : safe(next);
      if (to) location.href = to; // back to the app that asked, or out of the invite link
      else store.me = await api.me();
    } catch (err) { error = (err as Error).message; }
    busy = false;
  }
  async function setupWith(id: string) {
    busy = true; error = "";
    try { location.href = (await api.setupSocial(id, setupToken)).url; }
    catch (err) { error = (err as Error).message; busy = false; }
  }
  const social = (id: string) => `/auth/${id}/start?next=${encodeURIComponent(safe(next) ?? "/")}`;
</script>

<div class="corner"><ThemeToggle /></div>
{#if !info}
  <p class="login muted" aria-busy="true">Loading…</p>
{:else}
  <form class="login" onsubmit={submit}>
    <h1><Logo size={32} /></h1>
    {#if secret}
      <p>{invitee ? `Choose a password for ${invitee}.` : "Checking your invite…"}</p>
    {:else if info.needsSetup}
      <p>Welcome. Create the owner account to get started.</p>
      {#if info.setup === "blocked"}<p class="error">Setup is locked. Set a <code>SETUP_TOKEN</code> secret on the server (<code>wrangler secret put SETUP_TOKEN</code>), then reload.</p>{/if}
      <label>Email <input type="email" bind:value={email} autocomplete="username" required /></label>
      {#if info.setup === "token"}<label>Setup token <input type="password" bind:value={setupToken} autocomplete="off" required /><small class="muted">The SETUP_TOKEN secret you set when deploying.</small></label>{/if}
    {:else}
      <label>Email <input type="email" bind:value={email} autocomplete="username" required /></label>
    {/if}
    {#if !secret || invitee}
      <label>Password <input type="password" bind:value={password} autocomplete={secret || info.needsSetup ? "new-password" : "current-password"} minlength={secret || info.needsSetup ? 10 : undefined} required /></label>
      <button type="submit" disabled={busy || (info.needsSetup && info.setup === "blocked")}>{secret ? "Set password" : info.needsSetup ? "Create account" : "Sign in"}</button>
    {/if}
    <p class="hint" aria-live="polite">{#if error}<span class="error">{error}</span>{/if}</p>
    {#if info.needsSetup && !secret && info.providers.length}
      <div class="stack">
        {#each info.providers as p (p.id)}<button type="button" class="ghost" disabled={busy || info.setup === "blocked"} onclick={() => setupWith(p.id)}>Create owner with {p.name}</button>{/each}
      </div>
    {/if}
    {#if !secret && !info.needsSetup && info.providers.length}
      <div class="stack">
        {#each info.providers as p (p.id)}<a class="button ghost" href={social(p.id)}>Continue with {p.name}</a>{/each}
      </div>
    {/if}
  </form>
{/if}
