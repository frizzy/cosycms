// The entries opened lately, newest first, kept in this browser so the command palette can offer them.
export type Recent = { collection: string; id: string; title: string };
const KEY = "cosy:recent", MAX = 8;

export function recents(): Recent[] {
  try { const v = JSON.parse(localStorage.getItem(KEY) ?? "[]"); return Array.isArray(v) ? v.filter((r) => r && r.id && r.collection) : []; } catch { return []; }
}
export function remember(r: Recent) {
  try { localStorage.setItem(KEY, JSON.stringify([r, ...recents().filter((x) => x.id !== r.id)].slice(0, MAX))); } catch { /* storage can be blocked; recents are a convenience */ }
}
