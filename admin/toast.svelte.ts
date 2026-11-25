export const toasts = $state<{ id: number; text: string; kind: "ok" | "error" }[]>([]);
let n = 0;

// Confirmations use the same verb as the button that caused them ("Save" -> "Saved").
export function toast(text: string, kind: "ok" | "error" = "ok") {
  const id = ++n;
  toasts.push({ id, text, kind });
  setTimeout(() => { const i = toasts.findIndex((t) => t.id === id); if (i >= 0) toasts.splice(i, 1); }, kind === "error" ? 7000 : 2800);
}
