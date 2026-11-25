// Cmd/Ctrl+S submits the form it is attached to: <form use:saveShortcut>
export function saveShortcut(form: HTMLFormElement) {
  const on = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") { e.preventDefault(); form.requestSubmit(); }
  };
  addEventListener("keydown", on);
  return { destroy: () => removeEventListener("keydown", on) };
}
