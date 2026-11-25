import { z } from "zod";

// A template is a starting point for rich text fields. `body` fills a field that is still empty (a prompt-only template has none);
// `prompt` tells an MCP client how to use it, or what the thing is for (it needn't be tied to any field).
export const TemplateDef = z.object({
  key: z.string().regex(/^[a-z][a-z0-9-]*$/, "lowercase letters, numbers and dashes"),
  label: z.string().trim().min(1, "label is required"),
  body: z.object({ type: z.literal("doc"), content: z.array(z.any()).optional() }).nullable(),
  prompt: z.string().trim().max(4000),
});
export type TemplateDef = z.infer<typeof TemplateDef>;
