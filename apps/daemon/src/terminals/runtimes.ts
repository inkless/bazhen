import type { EnvironmentAdapter } from "@bazhen/core";
import type { HolderInstall } from "@bazhen/runtime-holder";

/**
 * Why the daemon can't start with `runtime.default` as configured, or null when it can: every new
 * terminal would go to a holder, and with no build installed none could start.
 */
export function defaultRuntimeRefusal(
  defaultRuntime: string,
  install: HolderInstall,
  configPath: string,
): string | null {
  if (defaultRuntime !== "holder" || install.installed !== null) return null;
  return (
    `no holder can be started for new terminals: ${install.reason}. ` +
    `To run them on tmux instead, set runtime.default = "tmux" in ${configPath}`
  );
}

/**
 * `terminals` by the runtime each was made on, for each of the environment's runtimes that has
 * any: each runtime is read, and its terminals concluded on, alone (design §5.4). An agent with no
 * terminal recorded goes with the default runtime. A terminal on a runtime the environment doesn't
 * run is in no group, so nothing is ever concluded about it.
 */
/**
 * Each of `terminals` on a runtime the environment doesn't run, with that runtime, which nothing
 * is ever concluded about; a reconcile says so once, at boot.
 */
export function unrouted<T extends { readonly runtimeKind: string | null }>(
  environment: Pick<EnvironmentAdapter, "runtimes">,
  terminals: readonly T[],
): T[] {
  return terminals.filter(
    (t) => t.runtimeKind !== null && !environment.runtimes.includes(t.runtimeKind),
  );
}

export function byRuntime<T extends { readonly runtimeKind: string | null }>(
  environment: Pick<EnvironmentAdapter, "runtimes" | "defaultRuntime">,
  terminals: readonly T[],
): (readonly [string, T[]])[] {
  return environment.runtimes.flatMap((kind) => {
    const on = terminals.filter((t) => (t.runtimeKind ?? environment.defaultRuntime) === kind);
    return on.length === 0 ? [] : [[kind, on] as const];
  });
}
