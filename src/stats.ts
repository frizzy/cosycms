import type { Field } from "./fields.ts";

// Word count and reading time of what a person reads: the body field, or every rich text field when there is no body field.
export const WORDS_PER_MINUTE = 200; // a typical adult reading pace

type Node = { type?: string; text?: string; content?: Node[] };
const textOf = (n: Node): string => (n.type === "text" ? n.text ?? "" : (n.content ?? []).map(textOf).join(n.content?.some((c) => c.type === "text") ? "" : " ") + " ");

/** shortcut: words are runs of non-space characters, so Chinese, Japanese and Thai count as one word per run; revisit if a site is written in them. */
export const countWords = (v: unknown) => {
  const t = typeof v === "string" ? v : v && typeof v === "object" ? textOf(v as Node) : "";
  return t.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
};

/** Minutes to read `words` words; at least 1 when there is anything to read. */
export const readingMinutes = (words: number) => (words ? Math.max(1, Math.ceil(words / WORDS_PER_MINUTE)) : 0);

export function entryStats(fields: Field[], data: Record<string, unknown>, bodyField?: string | null) {
  const keys = bodyField ? [bodyField] : fields.filter((f) => f.type === "richtext").map((f) => f.key);
  const wordCount = keys.reduce((n, k) => n + countWords(data[k]), 0);
  return { wordCount, readingTime: readingMinutes(wordCount) };
}

/** The keys a collection with stats adds to what it publishes. */
export const STAT_KEYS = ["wordCount", "readingTime"] as const;
