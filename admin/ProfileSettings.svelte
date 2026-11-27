<script lang="ts">
  import { AVATARS } from "../src/avatars";
  import { api } from "./api";
  import { store, refreshPeople } from "./store.svelte";
  import { toast } from "./toast.svelte";
  import Avatar from "./Avatar.svelte";

  let name = $state(store.me?.name ?? ""), avatar = $state<string | null>(store.me?.avatar ?? null), busy = $state(false), error = $state("");
  const dirty = $derived(name.trim() !== (store.me?.name ?? "") || avatar !== (store.me?.avatar ?? null));
  let input: HTMLInputElement;

  // Cropped to the middle square and shrunk before upload: a picture this small never needs the original.
  async function square(f: File) {
    const bmp = await createImageBitmap(f, { imageOrientation: "from-image" }), s = Math.min(bmp.width, bmp.height), out = 256;
    const cv = document.createElement("canvas"); cv.width = cv.height = out;
    cv.getContext("2d")!.drawImage(bmp, (bmp.width - s) / 2, (bmp.height - s) / 2, s, s, 0, 0, out, out);
    bmp.close();
    const blob = await new Promise<Blob | null>((r) => cv.toBlob(r, "image/webp", 0.85));
    if (!blob) throw new Error("This browser couldn't prepare the picture.");
    return new File([blob], "avatar.webp", { type: "image/webp" });
  }
  async function pick(f: File | undefined) {
    if (!f) return;
    error = ""; busy = true;
    try { avatar = (await api.upload(await square(f))).key; } catch (e) { error = (e as Error).message; }
    busy = false;
  }
  async function save(ev: SubmitEvent) {
    ev.preventDefault(); error = ""; busy = true;
    try { store.me = { ...store.me!, ...(await api.saveProfile({ name: name.trim() || null, avatar })) }; refreshPeople(); toast("Profile saved"); }
    catch (e) { error = (e as Error).message; }
    busy = false;
  }
</script>

<form onsubmit={save}>
  <label>Name
    <input bind:value={name} maxlength="60" placeholder={store.me?.email} autocomplete="name" />
    <small class="muted">Shown at the top of the account menu, above your email, and in the People list. Leave it empty to show just your email.</small>
  </label>
  <div class="field">Picture
    <div class="avatars" role="radiogroup" aria-label="Picture">
      <button type="button" class="av" role="radio" aria-checked={!avatar} aria-label="No picture" class:on={!avatar} onclick={() => (avatar = null)}><Avatar /></button>
      {#each AVATARS as a (a.id)}<button type="button" class="av" role="radio" aria-checked={avatar === a.id} aria-label={a.label} title={a.label} class:on={avatar === a.id} onclick={() => (avatar = a.id)}><Avatar avatar={a.id} size={44} /></button>{/each}
      {#if avatar?.startsWith("media/")}<button type="button" class="av on" role="radio" aria-checked="true" aria-label="Your upload"><Avatar {avatar} size={44} /></button>{/if}
    </div>
    <span class="inline">
      <button type="button" class="ghost" disabled={busy} onclick={() => input.click()}>Upload a picture</button>
      <small class="muted">It's cropped to a square.</small>
    </span>
    <input bind:this={input} type="file" hidden accept="image/png,image/jpeg,image/webp,image/gif,image/avif" onchange={(e) => { pick(e.currentTarget.files?.[0]); e.currentTarget.value = ""; }} />
  </div>
  <div class="inline"><button type="submit" disabled={busy || !dirty}>Save</button><span class="hint" aria-live="polite">{#if error}<span class="error">{error}</span>{/if}</span></div>
</form>
