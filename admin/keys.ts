// Cmd/Ctrl+S submits the form it is attached to: <form use:saveShortcut>
export function saveShortcut(form: HTMLFormElement) {
  const on = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") { e.preventDefault(); form.requestSubmit(); }
  };
  addEventListener("keydown", on);
  return { destroy: () => removeEventListener("keydown", on) };
}

/** True while the person is typing (or a dialog is open), so single-key shortcuts must not fire. */
export const typing = (e: KeyboardEvent) => {
  const t = e.target as HTMLElement | null;
  return e.metaKey || e.ctrlKey || e.altKey || !!t?.closest("input, textarea, select, [contenteditable=true], dialog[open]");
};
