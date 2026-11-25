import { z } from "zod";

// Custom content blocks: reusable components a rich text field can contain (a call-out box, a button, a gallery).
// A definition says what the block is called, whether it holds text or other blocks, and which properties it has.
// In the document a block is { type: "blockLeaf" | "blockInline" | "blockWrap", attrs: { name, props } }; in MDX it is <Name prop="x" />.
const common = { key: z.string().regex(/^[a-z][a-zA-Z0-9]*$/, "letters and numbers, starting with a lowercase letter"), label: z.string().trim().min(1, "label is required") };

// Settings an image from the library can carry when its field names an image component (see fields.ts `imageComponent`).
export const IMAGE_ALIGN = ["left", "right", "center"];
export const IMAGE_SIZE = ["small", "medium", "full"];

export const PropDef = z.discriminatedUnion("type", [
  z.object({ ...common, type: z.enum(["text", "number", "boolean"]) }),
  z.object({ ...common, type: z.literal("select"), options: z.array(z.string().trim().min(1)).min(1, "needs at least one option") }),
  z.object({ ...common, type: z.literal("images"), library: z.string().min(1), // a list of pictures from this image library
    rooted: z.boolean().optional() }),                                         // publish paths from the project root ("/src/assets/x.jpg") instead of relative to the file
]);
export type PropDef = z.infer<typeof PropDef>;

export const BlockDef = z.object({
  key: z.string().regex(/^[A-Z][A-Za-z0-9]*$/, "a component name: a capital letter, then letters and numbers"), // also the tag name in MDX
  label: z.string().trim().min(1, "label is required"),
  content: z.enum(["none", "inline", "blocks"]), // nothing inside / one run of text (bold, links…) / paragraphs, lists, images…
  props: z.array(PropDef).max(12),
}).superRefine((b, ctx) => {
  const seen = new Set<string>();
  b.props.forEach((p, i) => { if (seen.has(p.key)) ctx.addIssue({ code: "custom", message: `duplicate property "${p.key}"`, path: ["props", i, "key"] }); seen.add(p.key); });
});
export type BlockDef = z.infer<typeof BlockDef>;

export const blockNodeType = (c: BlockDef["content"]) => (c === "none" ? "blockLeaf" : c === "inline" ? "blockInline" : "blockWrap");
export const isBlockNode = (t: string) => t === "blockLeaf" || t === "blockInline" || t === "blockWrap";

/** Image libraries a set of blocks draws pictures from. */
export const blockLibraries = (defs: Iterable<BlockDef>) => [...new Set([...defs].flatMap((d) => d.props.flatMap((p) => (p.type === "images" ? [p.library] : []))))];
