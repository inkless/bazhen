import type { Store } from "../store/store.ts";

/**
 * Records the version Codex's app-server answered on when it differs from the last one recorded
 * for the environment, as after a self-update (foundation-design §5.8). The store holds the last
 * one, so a daemon restart on the same version records nothing.
 */
export function recordCodexVersion(store: Store, environmentId: string, version: string): void {
  if (version === "unknown") return;
  const previous = store.harnessVersion(environmentId, "codex") ?? null;
  if (previous === version) return;
  store.append({
    type: "environment.harness_version",
    entityId: environmentId,
    actor: "system",
    payload: { harness: "codex", version, previous },
  });
}

/** The version in `codex --version`'s output (`codex-cli 0.166.0`), or null if it names none. */
export function cliVersion(output: string): string | null {
  return /^\S+ (\d\S*)\s*$/.exec(output.trim())?.[1] ?? null;
}
