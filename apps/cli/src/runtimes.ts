import type { RuntimeHealthReport } from "@bazhen/protocol";

interface Reported {
  readonly runtime: Pick<RuntimeHealthReport, "state" | "version">;
  readonly runtimes?: readonly RuntimeHealthReport[] | undefined;
}

/**
 * Every runtime the daemon reported, as `bazhen status` and `bazhen doctor` say them: a line each,
 * or tmux's alone from a daemon that reports only that.
 */
export function runtimeReports({ runtime, runtimes }: Reported): readonly RuntimeHealthReport[] {
  return runtimes ?? [{ kind: "tmux", ...runtime }];
}

export function runtimeLines(reported: Reported): string[] {
  return runtimeReports(reported).map(
    ({ kind, state, version }) => `${kind}: ${state}${version ? ` ${version}` : ""}`,
  );
}

/** As `runtimeLines`, each followed by a warning for every defect Bazhen works around there. */
export function doctorRuntimeLines(reported: Reported): string[] {
  return runtimeReports(reported).flatMap((report) => [
    ...runtimeLines({ runtime: report, runtimes: [report] }),
    ...(report.workarounds ?? []).map((w) => `  warning: ${w}`),
  ]);
}

/** Whether a runtime can't be read: then doctor fails, as it did when tmux alone couldn't be. */
export const anyUnreachable = (reported: Reported) =>
  runtimeReports(reported).some((r) => r.state === "unreachable");
