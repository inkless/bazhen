// What falsify and falsify-base may judge outside a sandbox (docs/standards/testing.md §
// Falsification). A mutant or revert of code that signals can turn a check of its target into a
// signal to anything the user runs, so that code is reverted and mutated only in a sandbox, as
// scripts/signal-paths.ts defines one. Kept apart from falsify.ts, which signals its own children,
// so this logic can be broken by hand on any machine to prove its tests.

import { inSignalSandbox, isSignallingSource, isSignallingTest } from "./signal-paths.ts";

// Set by falsify's own tests to judge as a host would wherever they run. It can only make falsify
// refuse more, never let it judge signalling code outside a sandbox.
export const AS_HOST = "BZ_FALSIFY_AS_HOST";

export const inSandbox = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env[AS_HOST] !== "1" && inSignalSandbox();

/** What falsify would change or run that may signal processes it didn't start. */
export interface SignallingWork {
  readonly sources: string[];
  readonly tests: string[];
}

const killedBySignal = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "signal" in error && Boolean(error.signal);

/**
 * Of the files falsify would revert or mutate, those that signal processes as the base or HEAD has
 * them, and of the test files it would run, those whose HEAD holds a signalling test.
 * `read(rev, path)` is a file at a revision, undefined where it has none; a file it can't read
 * counts as signalling, since nothing shows it isn't.
 */
export function signallingWork(
  changed: readonly string[],
  testFiles: readonly string[],
  [base, head]: readonly [string, string],
  read: (rev: string, path: string) => string | undefined,
): SignallingWork {
  const holds = (rev: string, path: string, test: (file: string, text: string) => boolean) => {
    let text: string | undefined;
    try {
      text = read(rev, path);
    } catch (error) {
      // A git child killed by a signal is the run being stopped, not a file that can't be read.
      if (killedBySignal(error)) throw error;
      return true;
    }
    return text !== undefined && test(path, text);
  };
  return {
    sources: [...new Set(changed)].filter(
      (path) => holds(base, path, isSignallingSource) || holds(head, path, isSignallingSource),
    ),
    tests: [...new Set(testFiles)].filter((path) => holds(head, path, isSignallingTest)),
  };
}

const pathList = (title: string, paths: string[]) =>
  paths.length === 0 ? "" : `\n${title}:\n${paths.map((p) => `  ${p}`).join("\n")}`;

/**
 * Whether falsify may judge `work` here. Outside a sandbox it names what it won't judge, and
 * judges none of the branch: a partial verdict would read as a pass.
 */
export function judgeableHere(work: SignallingWork): boolean {
  if ((work.sources.length === 0 && work.tests.length === 0) || inSandbox()) return true;
  console.error(
    "falsify: this branch would revert or mutate code that signals processes, or run tests that " +
      "do, which happens only in a sandbox. Run `make test-real ARGS=falsify`." +
      pathList("Signalling code", work.sources) +
      pathList("Signalling tests", work.tests),
  );
  return false;
}
