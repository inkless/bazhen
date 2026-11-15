// Vitest globalSetup for every project: the tests start only inside a capped run, which the
// package.json scripts and `pnpm capped` give them, so a test that runs away dies alone
// (docs/standards/testing.md § Memory and time caps).

import { cappedRunRefusal } from "@bazhen/host-guard";

export async function setup(): Promise<void> {
  const why = await cappedRunRefusal(process.env);
  if (why === undefined) return;
  const message =
    `Refusing to run: ${why}. A test can run away with the machine's memory, so vitest runs only ` +
    "under a memory and time cap: use the package.json scripts (pnpm test, pnpm test:file …), or " +
    "pnpm capped -- <command>.";
  // Vitest's source-map lookup hides errors thrown from globalSetup, so print it as well.
  console.error(`\n${message}\n`);
  throw new Error(message);
}
