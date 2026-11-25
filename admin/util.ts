/** Empty values are dropped before saving so optional fields don't fail validation. */
export const isEmpty = (v: unknown) =>
  v === "" || v == null || (Array.isArray(v) && !v.length) || (typeof v === "number" && Number.isNaN(v));
