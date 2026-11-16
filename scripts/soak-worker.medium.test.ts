// The worker as a process, over pipes standing in for its terminal: the test plays the terminal,
// answering its probes or not, and typing into it. It ends each worker by closing its input,
// which is how a worker ends on its own; nothing is signalled. Times are bounded only from below,
// which load can't break: a busy machine makes every reply later, never earlier. Exact timing is
// the Prober's, on a clock of the small test's.

import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { markersIn, PROBE } from "./soak-worker.ts";

const WORKER = fileURLToPath(new URL("soak-worker.ts", import.meta.url));
const REPLY = "\x1b[1;1R\x1b[?62c";
const dir = mkdtempSync(join(tmpdir(), "bz-soak-worker-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

interface Recorded {
  readonly kind: string;
  readonly ms?: number | null;
  readonly n?: number;
  readonly why?: string;
}
interface Ran {
  readonly output: string;
  readonly events: Recorded[];
  readonly code: number | null;
}

function recorded(line: string): Recorded {
  const value: unknown = JSON.parse(line);
  if (typeof value !== "object" || value === null || !("kind" in value)) {
    throw new Error(`not a worker record: ${line}`);
  }
  const { kind, ms, n, why } = value as Record<string, unknown>;
  if (typeof kind !== "string") throw new Error(`a record without a kind: ${line}`);
  return {
    kind,
    ...(typeof ms === "number" || ms === null ? { ms } : {}),
    ...(typeof n === "number" ? { n } : {}),
    ...(typeof why === "string" ? { why } : {}),
  };
}

/** Each probe's time, a probe never answered as Infinity, which fails any bound on time. */
const probeTimes = (ran: Ran) =>
  ran.events.filter((e) => e.kind === "probe").map((e) => e.ms ?? Number.POSITIVE_INFINITY);

/** The last marker the worker printed; NaN, which no bound holds, for none. */
const lastMarker = (ran: Ran) => markersIn(ran.output, "w").at(-1) ?? Number.NaN;
/** The marker counts the worker recorded as written, in order. */
const writtenOf = (ran: Ran) =>
  ran.events.filter((e) => e.kind === "marker").map((e) => e.n ?? Number.NaN);

/**
 * How the test, as the terminal, answers each probe: at once, after a delay, or never, with both
 * replies unless `reply` names what it sends instead.
 */
type Answer = { readonly afterMs: number; readonly reply?: string } | "never";
const AT_ONCE: Answer = { afterMs: 0 };

/**
 * Runs a worker until it has asked `probes` probes, answering each as `answer` says, typing
 * `typed` once it starts, then closes its input and waits for it to exit and its output to be
 * read to the end.
 */
async function runWorker(
  [mode = "idle", ...options]: readonly string[],
  { probes, answer, typed = "" }: { probes: number; answer: Answer; typed?: string },
): Promise<Ran> {
  const name = `w${Math.random().toString(36).slice(2, 8)}`;
  const out = join(dir, `${name}.jsonl`);
  const child = spawn(process.execPath, [WORKER, mode, name, out, ...options], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  let output = "";
  let asked = 0;
  const askedAll = Promise.withResolvers<void>();
  const reply = (text: string) => child.stdin.writable && child.stdin.write(text);
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    output += chunk;
    const now = output.split(PROBE).length - 1;
    for (; asked < now; asked++) {
      if (answer !== "never") setTimeout(reply, answer.afterMs, answer.reply ?? REPLY);
    }
    if (asked >= probes) askedAll.resolve();
  });
  if (typed !== "") child.stdin.write(typed);
  // `close`, not `exit`: a worker can exit with its last output still in the pipe, unread here.
  const exited = once(child, "close");
  try {
    await askedAll.promise;
    // A reply to the last probe still on its way is let land before the input closes.
    await new Promise((resolve) => setTimeout(resolve, 300));
  } finally {
    child.stdin.end();
  }
  const [code] = await exited;
  const events = readFileSync(out, "utf8").trim().split("\n").map(recorded);
  return {
    output: output.replaceAll(name, "w"),
    events,
    code: typeof code === "number" ? code : null,
  };
}

/** Whole-millisecond clocks read a timer of n ms as a little under n. */
const CLOCK_SLACK_MS = 5;
const FAST = ["--probe-every", "100", "--probe-timeout", "200", "--marker-every", "20"];

describe("soak worker", () => {
  it("prints its markers in order and times each probe it gets an answer to", async () => {
    const ran = await runWorker(["idle", ...FAST, "--probe-timeout", "5000"], {
      probes: 3,
      answer: AT_ONCE,
    });
    const markers = markersIn(ran.output, "w");
    expect(markers.length).toBeGreaterThan(3);
    expect(markers).toEqual(Array.from({ length: markers.length }, (_, i) => i + 1));
    const times = probeTimes(ran);
    expect(times.length).toBeGreaterThanOrEqual(3);
    expect(times.every(Number.isFinite)).toBe(true);
    expect(ran.events.at(-1)).toMatchObject({ kind: "exit", why: "input-ended" });
    expect(ran.code).toBe(0);
  });

  it("records, each probe round, the markers it has written, none its output doesn't hold", async () => {
    const ran = await runWorker(["flood", ...FAST, "--flood-on", "100000"], {
      probes: 4,
      answer: AT_ONCE,
    });
    const written = writtenOf(ran);
    expect(written.length).toBeGreaterThanOrEqual(2);
    expect(written).toEqual(written.toSorted((a, b) => a - b));
    expect(written[0]).toBeGreaterThan(0);
    expect(written.at(-1)).toBeLessThanOrEqual(lastMarker(ran));
  });

  it("records a probe never answered as null", async () => {
    const ran = await runWorker(["idle", ...FAST], { probes: 2, answer: "never" });
    const times = probeTimes(ran);
    expect(times.length).toBeGreaterThanOrEqual(1);
    expect(new Set(times)).toEqual(new Set([Number.POSITIVE_INFINITY]));
  });

  it("records a probe that got only one of its two replies as null", async () => {
    const ran = await runWorker(["idle", ...FAST], {
      probes: 2,
      answer: { afterMs: 0, reply: "\x1b[1;1R" },
    });
    const times = probeTimes(ran);
    expect(times.length).toBeGreaterThanOrEqual(1);
    expect(new Set(times)).toEqual(new Set([Number.POSITIVE_INFINITY]));
  });

  it("records a probe answered only after its time ran out as null", async () => {
    const ran = await runWorker(
      ["idle", "--probe-every", "200", "--probe-timeout", "200", "--marker-every", "20"],
      { probes: 2, answer: { afterMs: 1_500 } },
    );
    expect(probeTimes(ran)[0]).toBe(Number.POSITIVE_INFINITY);
  });

  it("times a reply that comes late as late", async () => {
    const ran = await runWorker(
      ["idle", ...FAST, "--probe-every", "400", "--probe-timeout", "5000"],
      {
        probes: 2,
        answer: { afterMs: 120 },
      },
    );
    const times = probeTimes(ran);
    expect(times.length).toBeGreaterThanOrEqual(1);
    expect(times.every(Number.isFinite)).toBe(true);
    expect(Math.min(...times)).toBeGreaterThanOrEqual(120 - CLOCK_SLACK_MS);
  });

  it("reads replies late under --slow-probe, so the injected delay is what the record shows", async () => {
    const ran = await runWorker(
      ["idle", ...FAST, "--probe-every", "400", "--probe-timeout", "5000", "--slow-probe", "150"],
      { probes: 2, answer: AT_ONCE },
    );
    const times = probeTimes(ran);
    expect(times.length).toBeGreaterThanOrEqual(1);
    expect(times.every(Number.isFinite)).toBe(true);
    expect(Math.min(...times)).toBeGreaterThanOrEqual(150 - CLOCK_SLACK_MS);
  });

  it("echoes what is typed in echo mode, printable only, and only there", async () => {
    const echo = await runWorker(["echo", ...FAST], { probes: 2, answer: AT_ONCE, typed: "qz\rx" });
    const idle = await runWorker(["idle", ...FAST], { probes: 2, answer: AT_ONCE, typed: "qzx" });
    expect(echo.output).toContain("qzx");
    expect(idle.output).not.toContain("qzx");
  });

  it("floods markers in its on phase, many more than it prints off", async () => {
    const ran = await runWorker(["flood", ...FAST, "--flood-on", "200", "--flood-off", "100000"], {
      probes: 4,
      answer: AT_ONCE,
    });
    const markers = markersIn(ran.output, "w");
    expect(markers.length).toBeGreaterThan(1_000);
    expect(markers).toEqual(Array.from({ length: markers.length }, (_, i) => i + 1));
  });
});
