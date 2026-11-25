<script lang="ts">
  import { api, type Person } from "./api";
  import { store } from "./store.svelte";
  import { toast } from "./toast.svelte";
  let people = $state<Person[]>([]), inviteEmail = $state(""), link = $state(""), error = $state("");
  const load = () => api.people().then((p) => (people = p), () => {});
  $effect(() => { load(); });
  async function invite(ev: SubmitEvent) {
    ev.preventDefault(); error = ""; link = "";
    try { link = (await api.invite(inviteEmail)).invite; inviteEmail = ""; await load(); } catch (e) { error = (e as Error).message; }
  }
  async function reinvite(p: Person) { try { link = (await api.reinvite(p.id)).invite; } catch (e) { error = (e as Error).message; } }
  async function setRole(p: Person, role: "owner" | "member") {
    if (!confirm(role === "owner" ? `Make ${p.email} an owner? They'll be able to change collections, blocks, settings and people.` : `Make ${p.email} a member? They'll lose access to setup.`)) return;
    try { await api.setRole(p.id, role); toast("Updated"); await load(); } catch (e) { error = (e as Error).message; }
  }
  async function removePerson(p: Person) {
    if (!confirm(`Remove ${p.email}? They are signed out everywhere and their connected apps stop working.`)) return;
    try { await api.removePerson(p.id); toast("Removed"); await load(); } catch (e) { error = (e as Error).message; }
  }
</script>

<section class="stack">
  <h2>People</h2>
  <form class="inline" onsubmit={invite}>
    <input type="email" bind:value={inviteEmail} placeholder="Invite by email" required style="flex:1" />
    <button type="submit">Invite</button>
  </form>
  <p class="hint" aria-live="polite">{#if error}<span class="error">{error}</span>{/if}</p>
  {#if link}<p>Send this link (valid 7 days, works once): <input readonly value={link} onfocus={(e) => e.currentTarget.select()} /></p>
    <p class="muted">They can also just sign in with a provider from <a href="#/settings/signin">Sign-in</a> using this email.</p>{/if}
  {#each people as p (p.id)}
    <div class="inline">
      <span style="flex:1"><strong>{p.email}</strong> <small class="muted">{p.role}{p.hasPassword ? "" : " · invited, no password yet"}</small></span>
      <button type="button" class="ghost" onclick={() => reinvite(p)}>New password link</button>
      {#if p.id !== store.me?.id}
        <button type="button" class="ghost" onclick={() => setRole(p, p.role === "owner" ? "member" : "owner")}>{p.role === "owner" ? "Make member" : "Make owner"}</button>
        <button type="button" class="danger" onclick={() => removePerson(p)}>Remove</button>
      {/if}
    </div>
  {/each}
</section>
