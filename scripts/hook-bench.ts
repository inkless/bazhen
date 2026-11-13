// What the hook client adds to every hook a harness runs: the wall time of
// `sh -c '<client> PreToolUse'` against a stub daemon socket, minus that of a bare `sh -c true`
// (foundation-design §5.6 sets the budget at under 10 ms). Harnesses run each hook through a
// shell, so both sides pay for it. Run: `pnpm bench:hook [client]`.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { availableParallelism, loadavg } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { frameHookReply } from "../packages/protocol/src/index.ts";
import { isMain } from "./is-main.ts";

export const BUDGET_MS = 10;
/** Pairs timed before any verdict, so a floor slowed in the first few can't pass a slow client. */
export const MIN_PAIRS = 40;
/**
 * Pairs a client over budget is timed for before it fails: one really over budget is over in
 * every pair, while a healthy one on a busy machine only needs one unhindered run of each side.
 */
export const MAX_PAIRS = 200;
/**
 * The typical pair's difference may be this many budgets before the client fails, whatever its
 * fastest run: a regression in most runs (a retry, a cold path) but not all must not pass. Loose,
 * so that load, which slows the floor beside the client, doesn't trip it.
 */
export const MEDIAN_BUDGETS = 3;
/**
 * The whole measurement, priming included, stops by this, inside the bench's 90 s test timeout:
 * a machine too slow to settle the verdict by then gets no verdict rather than a timeout.
 */
export const MEASURE_MS = 75_000;
/**
 * A timed run taking longer than this has hung: the client's own deadline is 10 min. Only a
 * backstop; one slow run (an exec this machine stalled) is an outlier the verdict ignores.
 */
const HANG_MS = 30_000;
/**
 * The client's first run after a build pays the OS's one-time check of the new binary (on
 * macOS, seconds under load), so it runs once, untimed and with room to spare, before any pair.
 */
const PRIME_MS = 60_000;
/** Pairs run and thrown away first: the first runs pay for cold caches, not for the client. */
const WARM_UP = 5;
export const BINARY = fileURLToPath(
  new URL("../apps/hook/target/release/bazhen-hook", import.meta.url),
);
const PAYLOAD = JSON.stringify({
  session_id: "3f0c1a4e-5b6d-4c7e-8f90-a1b2c3d4e5f6",
  prompt_id: "9a8b7c6d-5e4f-4a3b-2c1d-0e9f8a7b6c5d",
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command: "ls -la", description: "List files" },
});
const { headers, body } = frameHookReply({ exitCode: 0, stdout: "", stderr: "", offered: [] });
const QUIET = Buffer.concat([
  Buffer.from(
    `HTTP/1.1 200 OK\r\n${Object.entries(headers)
      .map(([name, value]) => `${name}: ${value}\r\n`)
      .join("")}\r\n`,
  ),
  body,
]);

const quantile = (xs: readonly number[], q: number) =>
  xs.toSorted((a, b) => a - b)[Math.floor((xs.length - 1) * q)] ?? NaN;

export interface Spread {
  readonly minMs: number;
  readonly medianMs: number;
  readonly p90Ms: number;
}

const spread = (xs: readonly number[]): Spread => ({
  minMs: quantile(xs, 0),
  medianMs: quantile(xs, 0.5),
  p90Ms: quantile(xs, 0.9),
});

/** Wall times of the floor and the client, timed alternately, one pair at a time. */
export interface Samples {
  readonly floor: readonly number[];
  readonly client: readonly number[];
}

export interface Verdict {
  readonly pairs: number;
  readonly floor: Spread;
  readonly client: Spread;
  readonly overheadMs: number;
  /** The median of the pairs' differences. */
  readonly typicalOverheadMs: number;
  readonly withinBudget: boolean;
  /** Within budget after the minimum pairs, or timed to the maximum. */
  readonly conclusive: boolean;
}

export interface Pairs {
  readonly minPairs: number;
  readonly maxPairs: number;
}

const PAIRS: Pairs = { minPairs: MIN_PAIRS, maxPairs: MAX_PAIRS };

/**
 * Judges the client by its fastest run over the floor's fastest. Load only ever adds wall time,
 * and a real regression (more work, a sleep, a retry, another round trip) is in every run, the
 * fastest included. The minima are per side: the fastest of the pairs' differences would take a
 * slowed floor beside a quick client run as the client's cost, and pass a slow client.
 */
export function judge(
  samples: Samples,
  { minPairs, maxPairs }: Pairs = PAIRS,
  budget = BUDGET_MS,
): Verdict {
  const floor = spread(samples.floor);
  const client = spread(samples.client);
  const overheadMs = client.minMs - floor.minMs;
  const typicalOverheadMs = quantile(
    samples.client.map((ms, i) => ms - (samples.floor[i] ?? NaN)),
    0.5,
  );
  const pairs = Math.min(samples.floor.length, samples.client.length);
  const withinBudget = overheadMs < budget && typicalOverheadMs < MEDIAN_BUDGETS * budget;
  return {
    pairs,
    floor,
    client,
    overheadMs,
    typicalOverheadMs,
    withinBudget,
    conclusive: pairs >= maxPairs || (pairs >= minPairs && withinBudget),
  };
}

const side = (s: Spread) =>
  `min ${s.minMs.toFixed(1)}, median ${s.medianMs.toFixed(1)}, p90 ${s.p90Ms.toFixed(1)} ms`;

export function report(v: Verdict, budget = BUDGET_MS): string {
  return (
    `floor ${side(v.floor)}; client ${side(v.client)}; ` +
    `overhead ${v.overheadMs.toFixed(1)} ms, fastest over fastest of ${v.pairs} pairs ` +
    `(budget ${budget} ms); median difference ${v.typicalOverheadMs.toFixed(1)} ms ` +
    `(limit ${MEDIAN_BUDGETS * budget} ms)${v.conclusive ? "" : "; inconclusive"}`
  );
}

/**
 * Async, so the stub daemon in this process can answer while the client waits. Resolves with the
 * run's wall time, or undefined when the measurement's own deadline (`leftMs`) cut it short.
 */
function time(
  argv: [string, ...string[]],
  env: Record<string, string>,
  leftMs: number,
  hangMs = HANG_MS,
): Promise<number | undefined> {
  const start = performance.now();
  // A run that hangs fails the measurement instead of holding it for the client's 10 min backstop.
  const child = spawn(argv[0], argv.slice(1), {
    env,
    stdio: ["pipe", "ignore", "ignore"],
    timeout: Math.max(1, Math.ceil(Math.min(hangMs, leftMs))),
  });
  return new Promise((resolve, reject) => {
    // `sh -c true` exits without reading its input, so the write can find the pipe closed.
    child.stdin.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code !== "EPIPE") reject(err);
    });
    child.stdin.end(PAYLOAD);
    child.on("error", reject);
    child.on("exit", (_code, signal) => {
      if (signal === null) resolve(performance.now() - start);
      else if (leftMs < hangMs) resolve(undefined);
      else reject(new Error(`${argv.join(" ")} hung, killed by ${signal}`));
    });
  });
}

/**
 * Why this host can't time the client fairly right now, or undefined when it can: on a developer
 * machine running more work than it has cores, wall-clock times measure the load. CI is never
 * excused, so a real regression always fails there.
 */
export function overloaded(
  env: Readonly<Record<string, string | undefined>> = process.env,
  load = loadavg()[0] ?? 0,
  cores = availableParallelism(),
): string | undefined {
  if (env["CI"] !== undefined || load <= cores) return undefined;
  return `load average ${load.toFixed(1)} exceeds ${cores} cores`;
}

/**
 * Times `client` and the floor alternately, so a change in the machine's load hits both sides
 * alike, until the samples settle the verdict or `MEASURE_MS` runs out.
 */
export async function measure(client = BINARY, pairs: Pairs = PAIRS): Promise<Verdict> {
  const deadline = performance.now() + MEASURE_MS;
  const left = () => deadline - performance.now();
  const dir = mkdtempSync("/tmp/bz-bench-");
  const socket = join(dir, "bazhen.sock");
  // Answers once the whole request has arrived, as the daemon does.
  const server = createServer((conn) => {
    let request = Buffer.alloc(0);
    conn.on("data", (chunk: Buffer) => {
      request = Buffer.concat([request, chunk]);
      const end = request.indexOf("\r\n\r\n");
      const length = Number(/content-length: *(\d+)/i.exec(request.toString("latin1"))?.[1] ?? 0);
      if (end !== -1 && request.length >= end + 4 + length) conn.end(QUIET);
    });
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  const env = {
    PATH: process.env["PATH"] ?? "",
    BAZHEN_AGENT_ID: "agent_bench",
    BAZHEN_SOCKET: socket,
    BZ_HOOK_CLIENT: client,
  };
  const samples = { floor: [] as number[], client: [] as number[] };
  const run = ["sh", "-c", '"$BZ_HOOK_CLIENT" PreToolUse'] as const;
  try {
    let inTime = (await time([...run], env, left(), PRIME_MS)) !== undefined;
    for (let i = 0; inTime && (i < WARM_UP || !judge(samples, pairs).conclusive); i++) {
      const floorMs = await time(["sh", "-c", "true"], env, left());
      const clientMs = floorMs === undefined ? undefined : await time([...run], env, left());
      if (clientMs === undefined || floorMs === undefined) inTime = false;
      else if (i >= WARM_UP) {
        samples.floor.push(floorMs);
        samples.client.push(clientMs);
      }
    }
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
  return judge(samples, pairs);
}

/** The report of a verdict that fails the gate, for the failure to show what it judged. */
export const failure = (v: Verdict, budget = BUDGET_MS): string | undefined =>
  v.withinBudget && v.conclusive ? undefined : report(v, budget);

/**
 * Why a developer machine gets no verdict this run, or undefined: one too slow to settle it in
 * `MEASURE_MS`. CI is never excused, as with `overloaded`.
 */
export function inconclusive(
  v: Verdict,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  if (env["CI"] !== undefined || v.conclusive) return undefined;
  return `no verdict in ${MEASURE_MS / 1000} s: ${report(v)}`;
}

if (isMain(import.meta)) {
  const verdict = await measure(process.argv[2]);
  console.log(report(verdict));
  if (failure(verdict) !== undefined) process.exitCode = 1;
}
