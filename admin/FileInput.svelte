<script lang="ts">
  import { api } from "./api";
  import { IMAGE_TYPES, MAX_IMAGE_BYTES, MAX_INPUT_BYTES, blobUrl, type FileValue, type ImageOptions } from "../src/images";
  import { optimise } from "./optimise";
  import { store } from "./store.svelte";

  let { value = $bindable(), options }: { value?: FileValue; options: ImageOptions } = $props();
  let busy = $state(false), error = $state(""), info = $state(""), over = $state(false);
  const size = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  let input: HTMLInputElement;

  // Natural size is read in the browser; it's only display metadata.
  const measure = (f: File) => new Promise<{ width?: number; height?: number }>((resolve) => {
    const url = URL.createObjectURL(f), img = new Image();
    img.onload = () => { resolve({ width: img.naturalWidth, height: img.naturalHeight }); URL.revokeObjectURL(url); };
    img.onerror = () => { resolve({}); URL.revokeObjectURL(url); };
    img.src = url;
  });

  async function pick(f: File | undefined) {
    if (!f) return;
    error = ""; info = "";
    if (f.size > MAX_INPUT_BYTES) { error = "That image is larger than 60 MB."; return; }
    busy = true;
    try {
      const r = await optimise(f, options);
      if (r.file.size > MAX_IMAGE_BYTES) {
        error = r.file === f ? "That image is larger than 10 MB." : "Still larger than 10 MB after optimising. Lower the max size or use a smaller image.";
      } else {
        const [up, dims] = await Promise.all([api.upload(r.file), measure(r.file)]);
        value = { ...up, ...dims };
        info = r.note ?? (r.from ? `Optimised from ${r.from.width} × ${r.from.height}, ${size(f.size)}.` : "");
      }
    } catch (e) { error = (e as Error).message; }
    busy = false;
  }
</script>

<div class="file" class:over aria-busy={busy}
  ondragover={(e) => { e.preventDefault(); over = true; }} ondragleave={() => (over = false)}
  ondrop={(e) => { e.preventDefault(); over = false; pick(e.dataTransfer?.files[0]); }} role="group">
  {#if value}
    <button type="button" class="zoom" title="View larger" aria-label="View larger" onclick={() => (store.zoom = { src: blobUrl(value!.key), alt: value!.name })}><img src={blobUrl(value.key)} alt={value.name} /></button>
    <div class="meta">
      <strong>{value.name || "Image"}</strong>
      <span class="muted">{value.width && value.height ? `${value.width} × ${value.height}, ` : ""}{size(value.size)}</span>
      <span class="inline">
        <button type="button" class="ghost" disabled={busy} onclick={() => input.click()}>Replace</button>
        <button type="button" class="ghost danger-text" disabled={busy} onclick={() => (value = undefined)}>Remove</button>
      </span>
    </div>
  {:else}
    <button type="button" class="ghost" disabled={busy} onclick={() => input.click()}>Choose image</button>
    <span class="muted">or drop one here</span>
  {/if}
  <input bind:this={input} type="file" hidden accept={Object.keys(IMAGE_TYPES).join(",")}
    onchange={(e) => { pick(e.currentTarget.files?.[0]); e.currentTarget.value = ""; }} />
</div>
<div class="hint" aria-live="polite">{#if busy}Optimising and uploading…{:else if error}<span class="error">{error}</span>{:else if info}<span class="muted">{info}</span>{/if}</div>
