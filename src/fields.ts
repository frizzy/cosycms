import { z } from "zod";
import { IMAGE_TYPES, KEY_RE, MAX_IMAGE_BYTES, type ImageMime } from "./images.ts";

// Field and collection definitions. Shared by the API (validation) and the admin (forms + builder).
const common = {
  key: z.string().regex(/^[a-z][a-zA-Z0-9]*$/, "letters and numbers only, starting with a lowercase letter"),
  label: z.string().trim().min(1, "label is required"),
  required: z.boolean().optional(), // ignored for boolean and richtext
};

// Folders in published output are "a/b/c" with no empty or ".." parts. File folders may use {slug} and {collection}.
export function folderError(folder: string, placeholders: boolean) {
  const parts = (placeholders ? folder.replace(/\{(slug|collection)\}/g, "x") : folder).split("/");
  return parts.every((s) => /^[A-Za-z0-9._-]+$/.test(s) && s !== "." && s !== "..") ? null : "Use letters, numbers, dashes, dots and slashes, with no leading or trailing slash and no '..'";
}

export const FieldDef = z.discriminatedUnion("type", [
  z.object({ ...common, type: z.enum(["text", "textarea", "number", "boolean", "date", "url"]) }),
  z.object({
    ...common, type: z.literal("datetime"), // stored as a UTC ISO string, e.g. 2026-11-19T15:00:04.305Z
    autoSet: z.enum(["create", "save"]).optional(), // fill in the time when the entry is created / on every save
  }),
  z.object({
    ...common, type: z.literal("select"),
    options: z.array(z.string().trim().min(1)),
    multiple: z.boolean().optional(),    // many values (stored as string[])
    allowCustom: z.boolean().optional(), // free-form values, options become suggestions (tags)
  }),
  z.object({ // points at entries of another collection (an image library is just one with a file field)
    ...common, type: z.literal("reference"),
    collection: z.string().min(1),
    multiple: z.boolean().optional(),
  }),
  z.object({
    ...common, type: z.literal("richtext"),
    imageLibrary: z.string().optional(), // collection (an image library) whose images can be inserted into the body
    imageComponent: z.string().regex(/^[A-Z][A-Za-z0-9]*$/, "a component name such as Image").optional(), // MDX: images given an alignment or size publish as <Name src alt align size />
    blocks: z.array(z.string()).optional(), // keys of the content blocks (see blocks.ts) this field may contain
    templates: z.array(z.string()).optional(), // keys of the templates (see templates.ts) that can start this field
  }),
  z.object({
    ...common, type: z.literal("file"),
    // Image optimisation, applied in the browser on upload. Unset = defaults (see IMAGE_DEFAULTS).
    maxSize: z.number().int().min(0).max(10000).optional(),         // longest side in px; 0 = no limit
    format: z.enum(["keep", "webp", "jpeg"]).optional(),
    quality: z.number().int().min(1).max(100).optional(),           // JPEG and WebP only
    stripMetadata: z.boolean().optional(),                          // location, camera etc. (re-encoding drops it)
    // Where the image is published. Unset: next to the entry. A folder may use {slug} and {collection}.
    folder: z.string().optional(),
    keepName: z.boolean().optional(),                               // publish under the uploaded file's name (needs a folder)
    publishAs: z.enum(["object", "path"]).optional(),               // the entry's value: {src, width, height}, or just the path
  }),
]);
export type Field = z.infer<typeof FieldDef>;

const fieldsSchema = z.array(FieldDef).superRefine((fields, ctx) => {
  const seen = new Set<string>();
  fields.forEach((f, i) => {
    if (seen.has(f.key)) ctx.addIssue({ code: "custom", message: `duplicate field key "${f.key}"`, path: [i, "key"] });
    seen.add(f.key);
    if (f.type === "file" && f.folder && folderError(f.folder, true))
      ctx.addIssue({ code: "custom", message: `"${f.label}": ${folderError(f.folder, true)}`, path: [i, "folder"] });
    if (f.type === "file" && f.keepName && !f.folder)
      ctx.addIssue({ code: "custom", message: `"${f.label}": keeping file names needs a folder`, path: [i, "keepName"] });
    if (f.type === "select" && !f.options.length && !f.allowCustom)
      ctx.addIssue({ code: "custom", message: `"${f.label}" needs at least one option`, path: [i, "options"] });
  });
});

const baseDef = z.object({
  label: z.string().trim().min(1, "label is required"),
  // Entry slugs are generated from this field (key of a text/textarea field); empty means typed by hand.
  slugSource: z.string().nullish(),
  // The one text field shown as an entry's title in lists and pickers; empty means show the slug.
  titleField: z.string().nullish(),
  urlTemplate: z.string().regex(/^(\/|https?:\/\/)\S*\{slug\}\S*$/, "start with / or https:// and include {slug}, like /blog/{slug}").nullish(), // page address of an entry, for links in text
  // The image field (an upload, or a reference to an image library) shown as a small thumbnail in lists; empty means none.
  thumbField: z.string().nullish(),
  // How entries are written to a publish target: a JSON data file (default) or Markdown with YAML frontmatter.
  format: z.enum(["json", "markdown", "mdx"]).nullish(),
  folder: z.string().nullish(), // where this collection's files are published; empty = a folder named after the collection
  bodyField: z.string().nullish(), // markdown only: the rich text field that becomes the file's body
  single: z.boolean().optional(), // one entry only
  dates: z.boolean().optional(), // entries have publish dates: a go-live time, and publishedAt / revisedAt in the published file
  fields: fieldsSchema,
});

const checkSlugSource = (v: { slugSource?: string | null; titleField?: string | null; thumbField?: string | null; bodyField?: string | null; format?: string | null; folder?: string | null; fields: Field[] }, ctx: z.RefinementCtx) => {
  if (v.folder && folderError(v.folder, false)) ctx.addIssue({ code: "custom", message: folderError(v.folder, false)!, path: ["folder"] });
  if (v.bodyField && (!(v.format === "markdown" || v.format === "mdx") || !v.fields.some((f) => f.key === v.bodyField && f.type === "richtext")))
    ctx.addIssue({ code: "custom", message: `body field "${v.bodyField}" must be a rich text field, and only applies to Markdown or MDX`, path: ["bodyField"] });
  if (v.slugSource && !v.fields.some((f) => f.key === v.slugSource && (f.type === "text" || f.type === "textarea")))
    ctx.addIssue({ code: "custom", message: `slug source "${v.slugSource}" must be a text field`, path: ["slugSource"] });
  if (v.thumbField && !v.fields.some((f) => f.key === v.thumbField && (f.type === "file" || f.type === "reference")))
    ctx.addIssue({ code: "custom", message: `thumbnail field "${v.thumbField}" must be an image or a reference to an image library`, path: ["thumbField"] });
  if (v.titleField && !v.fields.some((f) => f.key === v.titleField && f.type === "text"))
    ctx.addIssue({ code: "custom", message: `title field "${v.titleField}" must be a single-line text field`, path: ["titleField"] });
};

const RESERVED = ["settings", "collections", "new"]; // admin routes
export const CollectionDef = baseDef.superRefine(checkSlugSource);
export const CollectionCreate = baseDef.extend({
  key: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "lowercase letters, numbers and dashes")
    .refine((k) => !RESERVED.includes(k), "reserved name"),
}).superRefine(checkSlugSource);
export type Collection = { key: string; label: string; urlTemplate?: string | null; slugSource?: string | null; titleField?: string | null; thumbField?: string | null; dates?: boolean; format?: "json" | "markdown" | "mdx" | null; folder?: string | null; bodyField?: string | null; single?: boolean; fields: Field[] };

/** Keys of existing fields whose type, single/multi shape or reference target changed; stored data would no longer fit. */
const shape = (f: Field) =>
  f.type === "select" ? `select:${!!f.multiple}` : f.type === "reference" ? `reference:${f.collection}:${!!f.multiple}` : f.type;
export const shapeChanges = (before: Field[], after: Field[]) =>
  after.filter((n) => before.some((o) => o.key === n.key && shape(o) !== shape(n))).map((f) => f.key);

/** A readable name for an entry: its "alt" field if it has one, else its first text field, else the slug. */
export function entryLabel(fields: Field[], data: Record<string, unknown>, slug: string, titleField?: string | null) {
  const chosen = titleField ? data[titleField] : undefined;
  if (typeof chosen === "string" && chosen.trim()) return chosen;
  const texts = fields.filter((f) => f.type === "text").sort((a, b) => Number(b.key === "alt") - Number(a.key === "alt"));
  return texts.map((f) => data[f.key]).find((v): v is string => typeof v === "string" && !!v.trim()) ?? slug;
}

/** A collection with an image field doubles as an image library: pickers show its entries as thumbnails. */
export const fileFieldOf = (c: { fields: Field[] }) => c.fields.find((f) => f.type === "file");

// shortcut: ASCII-only; titles in other scripts slugify to "" and need a hand-typed slug. Upgrade if that bites.
export const slugify = (s: string) =>
  s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/** Next free "name-N": an existing numeric suffix is incremented rather than stacked ("a-2" -> "a-3", never "a-2-2").
 *  shortcut: a natural trailing number ("top-10") counts as a suffix too; fine for now, revisit if titles like that are common. */
export const slugBase = (slug: string) => slug.replace(/-\d+$/, "");
export function nextFreeSlug(slug: string, taken: Iterable<string>) {
  const used = new Set(taken), base = slugBase(slug), m = slug.match(/-(\d+)$/);
  for (let n = m ? Number(m[1]) + 1 : 2; ; n++) if (!used.has(`${base}-${n}`)) return `${base}-${n}`;
}

function fieldSchema(f: Field): z.ZodType {
  switch (f.type) {
    case "text": case "textarea": return f.required ? z.string().min(1) : z.string();
    case "number": return z.number();
    case "boolean": return z.boolean();
    case "date": return z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD");
    case "datetime": return z.iso.datetime("use a date and time, like 2026-11-19T15:00:00Z");
    case "url": return z.url({ protocol: /^https?$/ }); // http(s) only: published values end up in hrefs
    case "reference": { // the id(s) are checked against the database when an entry is saved
      const id = z.string().min(1);
      return f.multiple ? (f.required ? z.array(id).min(1) : z.array(id)) : id;
    }
    case "file": return z.object({ // the uploaded image; the API re-checks it against the stored object on save
      key: z.string().regex(KEY_RE), name: z.string().max(200),
      size: z.number().int().nonnegative().max(MAX_IMAGE_BYTES),
      mime: z.enum(Object.keys(IMAGE_TYPES) as [ImageMime, ...ImageMime[]]),
      width: z.number().int().positive().optional(), height: z.number().int().positive().optional(),
    });
    case "richtext": return z.looseObject({ type: z.literal("doc") }); // Tiptap/ProseMirror JSON
    case "select": {
      const item = f.allowCustom ? z.string().min(1) : f.options.length ? z.enum(f.options as [string, ...string[]]) : z.never();
      return f.multiple ? (f.required ? z.array(item).min(1) : z.array(item)) : item;
    }
  }
}

/** Unknown keys (e.g. from removed fields) are stripped, not rejected. */
export function dataSchema(c: { fields: Field[] }) {
  return z.object(Object.fromEntries(c.fields.map((f) => {
    const s = fieldSchema(f);
    const mandatory = f.required && f.type !== "boolean" && f.type !== "richtext";
    return [f.key, mandatory ? s : s.optional()];
  })));
}
