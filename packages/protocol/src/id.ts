import { PROTOCOL_ID } from "./gen/id.ts";

/** Files, by name and content, as one SHA-256 in hex: each `name\0content\0`, in name order. */
export async function filesHash(files: Readonly<Record<string, string>>): Promise<string> {
  const text = Object.keys(files)
    .toSorted()
    .map((name) => `${name}\0${files[name]}\0`)
    .join("");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The protocol a build speaks: the hash of the files `cargo xtask schema` publishes from the Rust
 * protocol into `packages/protocol/schema/`. A client and a daemon with different ids may not read
 * each other's messages, so a client compares its own with the daemon's and asks to reload or
 * restart. The Rust crates name the same id, so both daemons and the web agree on it.
 */
export function protocolId(): Promise<string> {
  return Promise.resolve(PROTOCOL_ID);
}
