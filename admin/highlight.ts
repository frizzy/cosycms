// Search results mark matched words between \u0001 and \u0002; this splits a string into plain and matched pieces for rendering.
export function pieces(s: string): { t: string; hit: boolean }[] {
  return s.replace(/\s+/g, " ").split(/\u0001|\u0002/).map((t, i) => ({ t, hit: i % 2 === 1 })).filter((p) => p.t);
}
