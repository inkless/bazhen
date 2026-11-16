import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BUDGET_MS, failure, inconclusive, measure, overloaded } from "./hook-bench.ts";

// The CLI agents run on nearly every turn, against the hook's stub daemon: one call over the
// socket, and an answer it refuses, so what is timed is its start, the exchange and its exit.
const CLI = fileURLToPath(new URL("../target/release/bazhen", import.meta.url));

describe("CLI latency", () => {
  it(`adds under ${BUDGET_MS} ms over a bare sh -c true`, async ({ skip }) => {
    const reason = overloaded();
    skip(reason !== undefined, reason);
    const verdict = await measure(CLI, undefined, undefined, "agents");
    const excuse = inconclusive(verdict);
    skip(excuse !== undefined, excuse);
    expect(failure(verdict)).toBeUndefined();
  });
});
