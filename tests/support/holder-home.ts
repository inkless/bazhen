// Where holder tests keep their holders: under the temporary BAZHEN_HOME their run made, and
// never under any other, a real one included.

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The file in a run's home naming the run, and the variable that names it to the tests. */
export const RUN_MARKER = ".bz-holder-test-run";
export const RUN_ENV = "BZ_HOLDER_TEST_RUN";

export const holdersDir = (home: string) => join(home, "run", "holders");

function markerIn(home: string): string | undefined {
  try {
    return readFileSync(join(home, RUN_MARKER), "utf8");
  } catch {
    return undefined;
  }
}

/** This run's BAZHEN_HOME. Throws for any home the run didn't make, so no test reaches a real one. */
export function testHome(env: NodeJS.ProcessEnv = process.env): string {
  const home = env["BAZHEN_HOME"];
  const run = env[RUN_ENV];
  if (home === undefined || run === undefined || markerIn(home) !== run) {
    throw new Error(
      `Refusing BAZHEN_HOME=${home ?? "(unset)"}: holder tests run only under the temporary ` +
        "home their run makes. Run them with pnpm test:holder.",
    );
  }
  return home;
}

/** A terminal id as holder/1 has it: a plain file name, so its socket stays in the home. */
const TERMINAL_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The socket of the holder for `terminalId`, in this run's home. */
export function holderSocket(terminalId: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!TERMINAL_ID.test(terminalId)) throw new Error(`${terminalId} is no terminal id`);
  return join(holdersDir(testHome(env)), `${terminalId}.sock`);
}
