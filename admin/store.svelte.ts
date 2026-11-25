import { api, hooks, type Counts, type Me } from "./api";
import type { Collection } from "../src/fields";
import type { BlockDef } from "../src/blocks";
import type { TemplateDef } from "../src/templates";

// `dirty` is set by whichever editor is open; the router asks before navigating away from unsaved work.
export const store = $state<{ collections: Collection[]; blocks: BlockDef[]; templates: TemplateDef[]; loaded: boolean; error: string; dirty: boolean; zoom?: { src: string; alt: string }; me?: Me | null; signIn?: number; counts: Counts }>({ collections: [], blocks: [], templates: [], loaded: false, error: "", dirty: false, counts: {} });
hooks.unauthorized = () => { store.me = null; };

export async function refreshCollections() {
  try { [store.collections, store.blocks, store.templates] = await Promise.all([api.collections(), api.blocks(), api.templates()]); store.error = ""; }
  catch (e) { store.error = (e as Error).message; }
  store.loaded = true;
}

/** Sidebar badges: entries per collection that are drafts or have unpublished edits. */
export const refreshCounts = () => api.counts().then((c) => (store.counts = c), () => {});
