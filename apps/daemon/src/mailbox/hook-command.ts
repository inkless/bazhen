import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** One shell word, whatever the string holds. */
const word = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

const BINARY = fileURLToPath(new URL("../../../hook/target/release/bazhen-hook", import.meta.url));
/** The `sh` + `curl` client with the same contract, for when no binary is built; much slower. */
export const HOOK_SCRIPT = fileURLToPath(new URL("../../../hook/bazhen-hook.sh", import.meta.url));

/** The hook client a harness runs: the built binary, else the script. */
export function hookClient(): string {
  return existsSync(BINARY) ? BINARY : HOOK_SCRIPT;
}

/**
 * The hook client as a shell command, which a harness runs through a shell with the event
 * appended, so its path stays whole whatever it holds.
 */
export function hookCommand(client: string): string {
  return word(client);
}
