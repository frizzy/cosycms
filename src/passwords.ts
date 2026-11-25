// PBKDF2-SHA256 through WebCrypto (no dependency, runs on Workers). 100k iterations is the most Workers allows.
const ITER = 100_000;
const b64 = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b)));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function derive(password: string, salt: Uint8Array, iterations: number) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations }, key, 256));
}

export async function hashPassword(password: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${ITER}$${b64(salt)}$${b64(await derive(password, salt, ITER))}`;
}

const DUMMY = new Uint8Array(16);
/** With no stored hash it still does the work, so "no such user" and "wrong password" take the same time. */
export async function verifyPassword(password: string, stored: string | null | undefined) {
  const [, iter, salt, hash] = stored?.split("$") ?? [];
  const got = await derive(password, salt ? unb64(salt) : DUMMY, Number(iter) || ITER);
  if (!hash) return false;
  const want = unb64(hash);
  let d = got.length ^ want.length;
  for (let i = 0; i < got.length; i++) d |= got[i] ^ (want[i] ?? 0);
  return d === 0;
}
