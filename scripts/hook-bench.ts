// What the hook client adds to every hook a harness runs: the median wall time of
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
const RUNS = 40;
/**
 * A timed run taking longer than this has hung: the client's own deadline is 10 min. Only a
 * backstop; one slow run (an exec this machine stalled) is an outlier the median ignores.
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

const median = (xs: number[]) => xs.toSorted((a, b) => a - b)[Math.floor(xs.length / 2)] ?? NaN;

/** Async, so the stub daemon in this process can answer while the client waits. */
function time(
  argv: [string, ...string[]],
  env: Record<string, string>,
  timeoutMs = HANG_MS,
): Promise<number> {
  const start = performance.now();
  // A run that hangs fails the measurement instead of holding it for the client's 10 min backstop.
  const child = spawn(argv[0], argv.slice(1), {
    env,
    stdio: ["pipe", "ignore", "ignore"],
    timeout: timeoutMs,
  });
  return new Promise((resolve, reject) => {
    // `sh -c true` exits without reading its input, so the write can find the pipe closed.
    child.stdin.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code !== "EPIPE") reject(err);
    });
    child.stdin.end(PAYLOAD);
    child.on("error", reject);
    child.on("exit", (code, signal) =>
      signal === null
        ? resolve(performance.now() - start)
        : reject(new Error(`${argv.join(" ")} hung, killed by ${signal}`)),
    );
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

export interface Measurement {
  readonly floorMs: number;
  readonly clientMs: number;
  readonly overheadMs: number;
}

/**
 * Times `client` and the floor alternately, and takes the median of each pair's difference, so a
 * change in the machine's load hits both halves of a pair alike instead of skewing one median.
 */
export async function measure(client = BINARY, runs = RUNS): Promise<Measurement> {
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
  const floor: number[] = [];
  const samples: number[] = [];
  try {
    await time(["sh", "-c", '"$BZ_HOOK_CLIENT" PreToolUse'], env, PRIME_MS);
    for (let i = 0; i < WARM_UP + runs; i++) {
      const floorMs = await time(["sh", "-c", "true"], env);
      const clientMs = await time(["sh", "-c", '"$BZ_HOOK_CLIENT" PreToolUse'], env);
      if (i < WARM_UP) continue;
      floor.push(floorMs);
      samples.push(clientMs);
    }
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
  return {
    floorMs: median(floor),
    clientMs: median(samples),
    overheadMs: median(samples.map((ms, i) => ms - (floor[i] ?? NaN))),
  };
}

if (isMain(import.meta)) {
  const m = await measure(process.argv[2]);
  console.log(
    `floor median ${m.floorMs.toFixed(1)} ms, client median ${m.clientMs.toFixed(1)} ms; ` +
      `overhead ${m.overheadMs.toFixed(1)} ms, the median of each pair's difference ` +
      `(budget ${BUDGET_MS} ms)`,
  );
  if (m.overheadMs >= BUDGET_MS) process.exitCode = 1;
}
