export type ToastAction = { label: string; run: () => void | Promise<void> };
export const toasts = $state<{ id: number; text: string; kind: "ok" | "error"; action?: ToastAction }[]>([]);
let n = 0;

// Confirmations use the same verb as the button that caused them ("Save" -> "Saved"). An action (Undo) keeps the toast up longer.
export function toast(text: string, kind: "ok" | "error" = "ok", action?: ToastAction) {
  const id = ++n;
  toasts.push({ id, text, kind, action });
  setTimeout(() => dismiss(id), kind === "error" ? 7000 : action ? 9000 : 2800);
}
export function dismiss(id: number) { const i = toasts.findIndex((t) => t.id === id); if (i >= 0) toasts.splice(i, 1); }
