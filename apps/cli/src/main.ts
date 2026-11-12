#!/usr/bin/env node
// `bazhen <verb>`: the daemon's command-line client. It holds no logic; every verb is a call to
// the daemon's API over its Unix socket, except `start`, which runs the daemon's own start-up.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { currentInputs, resolvePaths } from "@bazhen/daemon/paths";
import { DaemonError, DaemonUnreachable, answers, call } from "@bazhen/daemon/client";
import { HealthResponse, StateSnapshot, StopResponse } from "@bazhen/protocol";

/** The exit status when the daemon isn't running. */
const NOT_RUNNING = 3;
const STOPPED_WITHIN_MS = 5000;
const USAGE = `usage: bazhen <start|stop|status> [--home <dir>] [--port <port>]`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { home: { type: "string" }, port: { type: "string" } },
});
// The flags reach the daemon as the variables it reads, above any already set.
if (values.home !== undefined) process.env["BAZHEN_HOME"] = values.home;
if (values.port !== undefined) process.env["BAZHEN_PORT"] = values.port;
const { socket } = resolvePaths(currentInputs());

/** Runs the daemon's own start-up, which detaches it and reports whether it came up. */
function start(): number {
  const entry = fileURLToPath(import.meta.resolve("@bazhen/daemon/start"));
  const result = spawnSync(process.execPath, [entry], { stdio: "inherit" });
  return result.status ?? 1;
}

async function stop(): Promise<number> {
  await call(socket, { method: "POST", path: "/v1/daemon/stop", reply: StopResponse });
  for (const begun = Date.now(); Date.now() - begun < STOPPED_WITHIN_MS;) {
    if (!(await answers(socket))) {
      console.log("bazhen stopped; agents keep running");
      return 0;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  console.error(`bazhen is still answering after ${STOPPED_WITHIN_MS / 1000} s`);
  return 1;
}

async function status(): Promise<number> {
  const [health, state] = await Promise.all([
    call(socket, { method: "GET", path: "/v1/health", reply: HealthResponse }),
    call(socket, { method: "GET", path: "/v1/state", reply: StateSnapshot }),
  ]);
  const byState = Map.groupBy(state.agents, (a) => a.state);
  const agents = [...byState].map(([s, list]) => `${list.length} ${s}`).join(", ") || "none";
  console.log(`bazhen ${health.appVersion} (protocol ${health.protocolVersion}), running`);
  console.log(
    `tmux: ${health.runtime.state}${health.runtime.version ? ` ${health.runtime.version}` : ""}`,
  );
  console.log(`agents: ${agents}`);
  return 0;
}

async function run(verb: string): Promise<number> {
  switch (verb) {
    case "start":
      return start();
    case "stop":
      return stop();
    case "status":
      return status();
    default:
      console.error(USAGE);
      return 2;
  }
}

try {
  process.exitCode = await run(positionals[0] ?? "");
} catch (err) {
  if (err instanceof DaemonUnreachable) {
    console.error("bazhen is not running; start it with `bazhen start`");
    process.exitCode = NOT_RUNNING;
  } else if (err instanceof DaemonError) {
    console.error(err.message);
    process.exitCode = 1;
  } else {
    throw err;
  }
}
