import type { EnvironmentAdapter, ShellInventoryEntry } from "@bazhen/core";
import { runtimePayload, type ShellTerminal, type Store } from "../store/store.ts";
import type { ShellLifecycle } from "./lifecycle.ts";

/**
 * After a restart, matches the environment's shells against the store's (foundation-design §7.1,
 * §4.8), by the rules agents go by: an unreadable environment concludes nothing, and a shell the
 * inventory lacks is lost only once what ran it is provably gone. A shell whose process exited
 * while the daemon was down is closed, as it would have been at once.
 */
export async function reconcileShells(
  store: Store,
  environment: EnvironmentAdapter,
  shells: Pick<ShellLifecycle, "closeExited">,
  log: (message: string) => void = console.warn,
): Promise<void> {
  const recorded = store.recoverableShells(environment.id);
  if (recorded.length === 0) return;
  let present: Map<string, ShellInventoryEntry>;
  try {
    const known = recorded.flatMap((s) => (s.runtime === null ? [] : [s.runtime]));
    if ((await environment.health(known)).state !== "reachable") return;
    present = new Map((await environment.shells()).map((e) => [e.ref.terminalId, e]));
  } catch (err) {
    log(`reconcile: could not read environment ${environment.id}'s shells: ${String(err)}`);
    return;
  }
  for (const shell of recorded) {
    const found = present.get(shell.terminalId);
    try {
      await settle(store, environment, shells, shell, found, log);
    } catch (err) {
      log(`reconcile: could not settle shell ${shell.terminalId}: ${String(err)}`);
    }
  }
}

async function settle(
  store: Store,
  environment: EnvironmentAdapter,
  shells: Pick<ShellLifecycle, "closeExited">,
  shell: ShellTerminal,
  found: ShellInventoryEntry | undefined,
  log: (message: string) => void,
): Promise<void> {
  const system = { entityId: shell.terminalId, actor: "system" } as const;
  if (shell.state === "creating") {
    // The daemon died while opening it: the tagged session is the shell, or there is none.
    store.append(
      found === undefined
        ? { ...system, type: "terminal.failed", payload: { reason: "daemon_restart" } }
        : {
            ...system,
            type: "terminal.running",
            payload: { runtimeRef: runtimePayload(found.ref) },
          },
    );
    if (found?.dead === true) await shells.closeExited({ ...shell, runtime: found.ref });
    return;
  }
  if (found !== undefined) {
    if (found.dead) await shells.closeExited(shell);
    return;
  }
  if (shell.runtime !== null) {
    const gone = await environment.gone({ runtime: shell.runtime, externalRef: null });
    if (!gone) {
      log(`reconcile: shell ${shell.terminalId}'s terminal may still run on its old server; left`);
      return;
    }
  }
  if (shell.state === "closing")
    store.append({ ...system, type: "terminal.closed", payload: { reason: "user" } });
  else store.append({ ...system, type: "terminal.lost", payload: {} });
}
