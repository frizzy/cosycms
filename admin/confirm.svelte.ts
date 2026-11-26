// An app-styled replacement for window.confirm: `await ask({...})` resolves true when the person confirms. See ConfirmDialog.svelte.
export type Ask = { title: string; message?: string; confirm?: string; cancel?: string; danger?: boolean };
export const confirmState = $state<{ current: (Ask & { resolve: (ok: boolean) => void }) | null }>({ current: null });

export function ask(o: Ask): Promise<boolean> {
  confirmState.current?.resolve(false); // a newer question replaces an unanswered one
  return new Promise((resolve) => { confirmState.current = { ...o, resolve }; });
}
