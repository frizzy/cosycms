// AES-256-GCM for secrets kept in the database. The key lives outside it (a Worker secret), so a leaked database alone reveals nothing.
// Format: enc:v1:<iv>:<ciphertext>, base64. The setting's name is bound in as authenticated data, so a ciphertext can't be moved to another setting.
const PREFIX = "enc:v1:";
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function key(keyB64: string) {
  const raw = unb64(keyB64.trim());
  if (raw.length !== 32) throw new Error("SETTINGS_KEY must be 32 random bytes, base64-encoded (openssl rand -base64 32).");
  return crypto.subtle.importKey("raw", raw as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export const isSealed = (v: string) => v.startsWith(PREFIX);

export async function seal(plain: string, keyB64: string, name: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(name) }, await key(keyB64), new TextEncoder().encode(plain)));
  return `${PREFIX}${b64(iv)}:${b64(ct)}`;
}

export async function unseal(sealed: string, keyB64: string, name: string) {
  const [iv, ct] = sealed.slice(PREFIX.length).split(":");
  try {
    return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) as BufferSource, additionalData: new TextEncoder().encode(name) }, await key(keyB64), unb64(ct) as BufferSource));
  } catch (e) {
    if ((e as Error).message.startsWith("SETTINGS_KEY")) throw e;
    throw new Error("A saved secret can't be decrypted with SETTINGS_KEY (wrong key?). Enter it again in Settings.");
  }
}
