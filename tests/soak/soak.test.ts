// The soak for real, in minutes: scripts/soak.ts's smoke profile, a daemon on holders under the
// whole load and its churn, compressed. A clean run must pass every criterion but the slopes,
// which only hours can show. A run with two faults injected must fail on the criteria those
// faults break, and only those: a holder closed behind the daemon's back, and a worker that
// reads its probes' replies late. Each run is a process of its own, as `make soak` runs it,
// and is judged from the directory it leaves.

import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SOAK = fileURLToPath(new URL("../../scripts/soak.ts", import.meta.url));
const runs = mkdtempSync(join(tmpdir(), "bz-soak-"));

interface Criterion {
  readonly name: string;
  readonly status: string;
}

/** A smoke run of `hours` measured, with `faults`, and its verdict per criterion. */
async function soak(hours: number, faults: readonly string[]): Promise<Record<string, string>> {
  const out = join(runs, faults.length === 0 ? "clean" : "faulty");
  const args = ["--profile", "smoke", "--hours", String(hours), "--out", out];
  const child = spawn(process.execPath, [SOAK, ...args, ...faults.flatMap((f) => ["--fault", f])], {
    stdio: "inherit",
  });
  await once(child, "exit");
  console.log(evidence(out));
  const verdict: unknown = JSON.parse(readFileSync(join(out, "verdict.json"), "utf8"));
  const criteria =
    typeof verdict === "object" && verdict !== null && "criteria" in verdict
      ? verdict.criteria
      : [];
  return Object.fromEntries(
    (Array.isArray(criteria) ? criteria : []).filter(isCriterion).map((c) => [c.name, c.status]),
  );
}

function isCriterion(value: unknown): value is Criterion {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    typeof value.name === "string" &&
    "status" in value &&
    typeof value.status === "string"
  );
}

/** The JSON lines of `file`, or none. */
const linesOf = (file: string): unknown[] =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line): unknown => JSON.parse(line))
    : [];

const echoMs = (e: unknown) =>
  typeof e === "object" && e !== null && "ms" in e && typeof e.ms === "number" ? e.ms : Infinity;
const timeOf = (e: unknown) =>
  typeof e === "object" && e !== null && "t" in e && typeof e.t === "number" ? e.t : 0;
const brief = (e: unknown) =>
  typeof e === "object" && e !== null
    ? Object.entries(e)
        .filter(([key]) => ["kind", "t", "name", "phase", "up"].includes(key))
        .map(([key, value]) => `${key}=${String(value)}`)
        .join(" ")
    : String(e);

/** What the driver recorded, samples aside, in the `ms` before `t` and the second after. */
function around(events: readonly unknown[], t: number, ms: number): string[] {
  return events
    .filter((e) => timeOf(e) >= t - ms - 2_000 && timeOf(e) <= t + 1_000)
    .map((e) => `    ${timeOf(e) - t} ms: ${brief(e)}`);
}

/**
 * What a run left that a verdict doesn't say, printed for whoever reads the log: the run's
 * directory goes with its container, so this is all of it that is kept.
 */
function evidence(out: string): string {
  const log = join(out, "driver.log");
  const slowest = linesOf(join(out, "echo.jsonl"))
    .toSorted((a, b) => echoMs(b) - echoMs(a))
    .slice(0, 8);
  const events = linesOf(join(out, "events.jsonl")).filter(
    (e) => typeof e === "object" && e !== null && "kind" in e && e.kind !== "sample",
  );
  return [
    `--- ${out}/driver.log`,
    existsSync(log) ? readFileSync(log, "utf8") : "(none)",
    "--- the slowest echoes, each with what the driver did before it",
    ...slowest.flatMap((e) => [
      JSON.stringify(e),
      ...around(events, timeOf(e), Number.isFinite(echoMs(e)) ? echoMs(e) : 2_000),
    ]),
  ].join("\n");
}

const statusOf = (verdict: Record<string, string>, status: string) =>
  Object.keys(verdict).filter((name) => verdict[name] === status);

describe("the soak", () => {
  it("passes a clean smoke run on every criterion but those only hours show", async () => {
    const verdict = await soak(0.2, []);
    expect(statusOf(verdict, "unmeasured")).toEqual(["holder-memory", "daemon-memory"]);
    expect(statusOf(verdict, "fail")).toEqual([]);
    expect(Object.keys(verdict)).toHaveLength(14);
  });

  it("fails a run with a holder closed under it and a slow probe on what those break", async () => {
    const verdict = await soak(0.1, ["close-holder", "slow-probe"]);
    const failed = statusOf(verdict, "fail");
    expect(failed).toEqual(
      expect.arrayContaining(["holder-deaths", "children", "terminal-states", "probes"]),
    );
    // The closed terminal's last attach may come before it died, or not at all; and its child and
    // PTY go when the kernel lets them, which a settled count may catch between.
    const broken = [
      "holder-deaths",
      "children",
      "terminal-states",
      "probes",
      "output-loss",
      "counts",
    ];
    expect(failed.filter((name) => !broken.includes(name))).toEqual([]);
  });
});
