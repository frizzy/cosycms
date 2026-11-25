// Publish targets are one-way sinks. Implementations (git, webhook, fs) live in their own files.
// An upsert carries either text `content` or `file`: the key of an uploaded image in blob storage.
export type Change =
  | { type: "upsert"; id: string; path: string; content: string }
  | { type: "upsert"; id: string; path: string; file: string }
  | { type: "delete"; id: string; path: string };

export interface Target {
  name: string;
  publish(changes: Change[]): Promise<string>; // returns a ref (commit sha, request id, ...)
}
