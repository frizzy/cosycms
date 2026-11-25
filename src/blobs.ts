// Where uploaded bytes live. R2 on Cloudflare; a filesystem version comes with the Node build.
export interface BlobStore {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<{ body: ReadableStream; contentType: string; size: number } | null>;
  head(key: string): Promise<{ size: number; contentType: string } | null>;
}

const meta = (o: R2Object) => ({ size: o.size, contentType: o.httpMetadata?.contentType ?? "application/octet-stream" });

export const r2Store = (bucket: R2Bucket): BlobStore => ({
  async put(key, body, contentType) { await bucket.put(key, body, { httpMetadata: { contentType } }); },
  async get(key) { const o = await bucket.get(key); return o && { ...meta(o), body: o.body }; },
  async head(key) { const o = await bucket.head(key); return o && meta(o); },
});
