import { test } from "node:test";
import assert from "node:assert/strict";
import { weakAlt } from "./alt.ts";

test("flags alt text that says nothing, and passes real descriptions", () => {
  assert.equal(weakAlt(""), "Missing");
  assert.equal(weakAlt("   "), "Missing");
  assert.equal(weakAlt("IMG_1234.jpg"), "Looks like a file name");
  assert.equal(weakAlt("hi"), "Very short");
  assert.equal(weakAlt("Image"), "A placeholder, not a description");
  assert.equal(weakAlt("IMG 4021"), "A placeholder, not a description");
  assert.equal(weakAlt("bright kitchen", "bright-kitchen.jpg"), "Same as the file name");
  assert.equal(weakAlt("A bright kitchen with a oak table"), undefined);
});
