<script lang="ts">
  import { api } from "./api";
  let last = $state<{ at: string; detail: string } | null | undefined>(), error = $state("");
  $effect(() => { api.backupStatus().then((s) => (last = s.last), (e) => (error = e.message)); });
  const ago = (iso: string) => { const h = (Date.now() - Date.parse(iso)) / 3600_000; return h < 1 ? "less than an hour ago" : h < 48 ? `${Math.round(h)} hours ago` : `${Math.round(h / 24)} days ago`; };
</script>

<section class="stack">
  <h2>Backups</h2>
  <p class="muted">The server's nightly job (<code>scripts/backup.sh</code>) saves the database, uploaded images and secrets, and reports back here. With <code>scripts/offsite-setup.sh</code> it also sends an encrypted copy off the machine. A failed or missing backup shows up in Notifications.</p>
  {#if error}<p class="error">{error}</p>
  {:else if last === undefined}<p class="muted" aria-busy="true">Loading…</p>
  {:else if last}<p><strong>Last good backup:</strong> {ago(last.at)} ({new Date(last.at).toLocaleString()}){#if last.detail}<br /><span class="muted">{last.detail}</span>{/if}</p>
  {:else}<p><strong>No backup has reported yet.</strong> Run <code>scripts/backup.sh</code> on the server once to see it here, and check that the nightly cron job is installed.</p>{/if}
</section>
