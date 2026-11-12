// What the hook client adds to every hook a harness runs: the median wall time of
// `sh -c '<client> PreToolUse'` against a stub daemon socket, minus that of a bare `sh -c true`
// (foundation-design §5.6 sets the budget at under 10 ms). Harnesses run each hook through a
// shell, so both sides pay for it. Run: `pnpm bench:hook [client]`.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { frameHookReply } from "../packages/protocol/src/index.ts";
import { isMain } from "./is-main.ts";

export const BUDGET_MS = 10;
const RUNS = 40;
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
function time(argv: [string, ...string[]], env: Record<string, string>): Promise<number> {
  const start = performance.now();
  // A run that hangs fails the measurement instead of holding it for the client's 10 min backstop.
  const child = spawn(argv[0], argv.slice(1), {
    env,
    stdio: ["pipe", "ignore", "ignore"],
    timeout: 5000,
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

export interface Measurement {
  readonly floorMs: number;
  readonly clientMs: number;
  readonly overheadMs: number;
}

/** Times `client` and the floor alternately, so drift in the machine's load hits both alike. */
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
    for (let i = 0; i < runs; i++) {
      floor.push(await time(["sh", "-c", "true"], env));
      samples.push(await time(["sh", "-c", '"$BZ_HOOK_CLIENT" PreToolUse'], env));
    }
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
  const floorMs = median(floor);
  const clientMs = median(samples);
  return { floorMs, clientMs, overheadMs: clientMs - floorMs };
}

if (isMain(import.meta)) {
  const m = await measure(process.argv[2]);
  console.log(
    `floor ${m.floorMs.toFixed(1)} ms, client ${m.clientMs.toFixed(1)} ms, ` +
      `overhead ${m.overheadMs.toFixed(1)} ms (budget ${BUDGET_MS} ms)`,
  );
  if (m.overheadMs >= BUDGET_MS) process.exitCode = 1;
}
