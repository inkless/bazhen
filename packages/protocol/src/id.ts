import { jsonSchemas } from "./json-schema.ts";
import { PROTOCOL_SEMANTICS } from "./semantics.ts";

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
 * The files `pnpm schema` commits to `packages/protocol/schema/`: the JSON Schema of every message,
 * and `semantics.json` for what a schema can't say.
 */
export function protocolFiles(): Record<string, string> {
  return {
    ...jsonSchemas(),
    "semantics.json": `${JSON.stringify(PROTOCOL_SEMANTICS, null, 2)}\n`,
  };
}

/**
 * The protocol a build speaks: the hash of `protocolFiles()`. A client and a daemon with different
 * ids may not read each other's messages, so a client compares its own with the daemon's and asks
 * to reload or restart. A build that can't run zod hashes the committed files and gets the same id.
 */
export function protocolId(): Promise<string> {
  return filesHash(protocolFiles());
}
