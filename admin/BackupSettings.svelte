<script lang="ts">
  import { api, type BackupState } from "./api";
  import { toast } from "./toast.svelte";
  let last = $state<{ at: string; detail: string } | null | undefined>(), error = $state("");
  $effect(() => { api.backupStatus().then((s) => (last = s.last), (e) => (error = e.message)); });
  const ago = (iso: string) => { const h = (Date.now() - Date.parse(iso)) / 3600_000; return h < 1 ? "less than an hour ago" : h < 48 ? `${Math.round(h)} hours ago` : `${Math.round(h / 24)} days ago`; };

  // Where the encrypted off-server copy goes. Secrets are write-only: the form shows that one is saved, never the secret itself.
  let bk = $state<BackupState>(), type = $state<"none" | "r2" | "ssh">("none"), busy = $state(false), saveError = $state(""), password = $state("");
  let f = $state({ accountId: "", bucket: "", accessKeyId: "", secret: "", prefix: "", host: "", port: "", user: "", path: "" });
  function adopt(s: BackupState) {
    bk = s; const d = s.dest;
    type = d?.type ?? "none";
    const blank = { accountId: "", bucket: "", accessKeyId: "", secret: "", prefix: "", host: "", port: "", user: "", path: "" };
    f = d?.type === "r2" ? { ...blank, accountId: d.accountId, bucket: d.bucket, accessKeyId: d.accessKeyId, prefix: d.prefix ?? "" } : d?.type === "ssh" ? { ...blank, host: d.host, port: d.port ? String(d.port) : "", user: d.user, path: d.path } : blank;
  }
  $effect(() => { api.backupDest().then(adopt, (e) => (saveError = e.message)); });

  const body = () => type === "r2"
    ? { type, accountId: f.accountId, bucket: f.bucket, accessKeyId: f.accessKeyId, ...(f.secret ? { secret: f.secret } : {}), ...(f.prefix ? { prefix: f.prefix } : {}) }
    : { type, host: f.host, ...(f.port ? { port: Number(f.port) } : {}), user: f.user, path: f.path };
  async function save(ev: SubmitEvent) {
    ev.preventDefault(); busy = true; saveError = "";
    try { const r = await api.saveBackupDest(type === "none" ? { type: "none" } : body()); adopt(r); if (r.newPassword) password = r.newPassword; toast(type === "none" ? "Off-server copy removed" : "Saved"); }
    catch (e) { saveError = (e as Error).message; }
    busy = false;
  }
  async function showPassword() { try { password = (await api.backupPassword()).password; } catch (e) { saveError = (e as Error).message; } }

  // A test is queued here and run by the server's every-minute job, so it can take a minute; this asks again until there is an answer.
  let polling = $state(false);
  async function test() {
    saveError = "";
    try { adopt(await api.testBackup()); } catch (e) { saveError = (e as Error).message; return; }
    polling = true;
    for (let i = 0; i < 90 && polling; i++) {
      await new Promise((r) => setTimeout(r, 4000));
      try { const s = await api.backupDest(); bk = s; if (s.test && s.test.state !== "pending" && s.test.state !== "running") break; } catch { /* try again */ }
    }
    polling = false;
  }
  $effect(() => () => { polling = false; });
  const waiting = $derived(bk?.test?.state === "pending" || bk?.test?.state === "running");
  const stalled = $derived(!!bk?.test && waiting && Date.now() - Date.parse(bk.test.at) > 5 * 60_000);
  const changed = $derived.by(() => { const d = bk?.dest; return !d ? type !== "none" : type !== d.type || (type === "r2" ? !!f.secret || f.accountId !== (d as { accountId: string }).accountId || f.bucket !== (d as { bucket: string }).bucket || f.accessKeyId !== (d as { accessKeyId: string }).accessKeyId || f.prefix !== ((d as { prefix?: string }).prefix ?? "") : f.host !== (d as { host: string }).host || f.user !== (d as { user: string }).user || f.path !== (d as { path: string }).path || f.port !== ((d as { port?: number }).port ? String((d as { port?: number }).port) : "")); });
</script>

<section class="stack">
  <h2>Backups</h2>
  <p class="muted">The server's nightly job (<code>scripts/backup.sh</code>) saves the database, uploaded images and secrets, and reports back here. A failed or missing backup shows up in Notifications.</p>
  {#if error}<p class="error">{error}</p>
  {:else if last === undefined}<p class="muted" aria-busy="true">Loading…</p>
  {:else if last}<p><strong>Last good backup:</strong> {ago(last.at)} ({new Date(last.at).toLocaleString()}){#if last.detail}<br /><span class="muted">{last.detail}</span>{/if}</p>
  {:else}<p><strong>No backup has reported yet.</strong> Run <code>scripts/backup.sh</code> on the server once to see it here, and check that the nightly cron job is installed.</p>{/if}
</section>

<section class="stack">
  <h2>Off-server copy</h2>
  <p class="muted">Copies kept only on the server are lost with it. Pick a second place and each night's backup is also sent there, encrypted before it leaves the server.</p>
  {#if !bk}<p class="muted" aria-busy="true">Loading…</p>
  {:else}
    <form onsubmit={save}>
      <label>Send copies to
        <select bind:value={type}>
          <option value="none">Nowhere (only this server)</option>
          <option value="r2">Cloudflare R2</option>
          <option value="ssh">Another computer over SSH</option>
        </select>
      </label>
      {#if type === "r2"}
        <label>Account ID <input bind:value={f.accountId} required autocomplete="off" spellcheck="false" /><small class="muted">Cloudflare dashboard, R2, on the right of the overview.</small></label>
        <label>Bucket <input bind:value={f.bucket} required autocomplete="off" spellcheck="false" /></label>
        <label>Access key ID <input bind:value={f.accessKeyId} required autocomplete="off" spellcheck="false" /></label>
        <label>Secret access key <input type="password" bind:value={f.secret} autocomplete="off" required={!bk.dest || bk.dest.type !== "r2"} placeholder={bk.dest?.type === "r2" && bk.dest.hasSecret ? "•••••••• saved. Leave blank to keep it" : ""} /><small class="muted">Create an R2 API token limited to this bucket with Object Read &amp; Write. It is stored encrypted and never shown again.</small></label>
        <label>Folder in the bucket <input bind:value={f.prefix} autocomplete="off" spellcheck="false" placeholder="Optional" /></label>
      {:else if type === "ssh"}
        <label>Host <input bind:value={f.host} required autocomplete="off" spellcheck="false" placeholder="backup.example.com" /></label>
        <label>Port <input type="number" min="1" max="65535" bind:value={f.port} placeholder="22" /></label>
        <label>User <input bind:value={f.user} required autocomplete="off" spellcheck="false" /></label>
        <label>Folder <input bind:value={f.path} required autocomplete="off" spellcheck="false" placeholder="/srv/cosycms-backups" /><small class="muted">It is created if it doesn't exist and the user can write there.</small></label>
      {/if}
      <div class="inline"><button type="submit" disabled={busy || !changed}>Save</button><span class="hint" aria-live="polite">{#if saveError}<span class="error">{saveError}</span>{/if}</span></div>
    </form>

    {#if password}
      <div class="notice">
        <p><strong>Keep this password somewhere outside the server.</strong> Without it the copies can't be read, even by you. A password manager is a good place.</p>
        <p><input readonly value={password} onfocus={(e) => e.currentTarget.select()} aria-label="Repository password" /></p>
        <button type="button" class="ghost" onclick={() => (password = "")}>I've saved it</button>
      </div>
    {/if}

    {#if bk.dest}
      <h3>Check it works</h3>
      {#if bk.dest.type === "ssh"}
        <p class="muted">The server signs in with a key of its own. Add this public key to <code>~/.ssh/authorized_keys</code> for that user on the destination, then test.</p>
        {#if bk.pubkey}<p><input readonly value={bk.pubkey} onfocus={(e) => e.currentTarget.select()} aria-label="Public key" /></p>
        {:else}<p class="muted">The key is made the first time the server tests. Press Test, then add the key that appears here and test again.</p>{/if}
      {/if}
      <div class="inline">
        <button type="button" class="ghost" onclick={test} disabled={busy || polling || changed}>Test the destination</button>
        {#if changed}<small class="muted">Save your changes first.</small>{/if}
      </div>
      <p class="hint" aria-live="polite">
        {#if stalled}<span class="error">The server hasn't answered. Check that its every-minute job is running, then test again.</span>
        {:else if bk.test?.state === "pending"}<span class="muted">Queued. The server picks it up within a minute…</span>
        {:else if bk.test?.state === "running"}<span class="muted">Testing…</span>
        {:else if bk.test?.state === "ok"}<span class="ok">✓ It worked.</span> <span class="muted">{ago(bk.test.at)}. {bk.test.detail}</span>
        {:else if bk.test?.state === "failed"}<span class="error">✗ {bk.test.detail}</span>{/if}
      </p>
      {#if bk.hasPassword}<p><button type="button" class="ghost" onclick={showPassword}>Show the repository password</button></p>{/if}
    {/if}
  {/if}
</section>
