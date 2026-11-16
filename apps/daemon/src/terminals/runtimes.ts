import type { EnvironmentAdapter } from "@bazhen/core";

/**
 * `terminals` by the runtime each was made on, for each of the environment's runtimes that has
 * any: each runtime is read, and its terminals concluded on, alone (design §5.4). An agent with no
 * terminal recorded goes with the default runtime. A terminal on a runtime the environment doesn't
 * run is in no group, so nothing is ever concluded about it.
 */
export function byRuntime<T extends { readonly runtimeKind: string | null }>(
  environment: Pick<EnvironmentAdapter, "runtimes" | "defaultRuntime">,
  terminals: readonly T[],
): (readonly [string, T[]])[] {
  return environment.runtimes.flatMap((kind) => {
    const on = terminals.filter((t) => (t.runtimeKind ?? environment.defaultRuntime) === kind);
    return on.length === 0 ? [] : [[kind, on] as const];
  });
}
