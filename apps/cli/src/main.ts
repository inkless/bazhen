#!/usr/bin/env node
// `bazhen <verb>`: the daemon's command-line client. It holds no logic; every verb is a call to
// the daemon's API over its Unix socket, except `start`, which runs the daemon's own start-up.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { currentInputs, resolvePaths } from "@bazhen/daemon/paths";
import { DaemonError, DaemonUnreachable, answers, call } from "@bazhen/daemon/client";
import {
  DoctorResponse,
  EnvRefreshResponse,
  HealthResponse,
  StateSnapshot,
  StopResponse,
} from "@bazhen/protocol";

/** The exit status when the daemon isn't running. */
const NOT_RUNNING = 3;
const STOPPED_WITHIN_MS = 5000;
/** A daemon that holds a status call this long is wedged, and reported as not answering. */
const CALL_MS = 5000;
const USAGE = `usage: bazhen <start|stop|status|doctor|env refresh> [--home <dir>] [--port <port>]`;

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

/** Idempotent: a daemon that isn't running is already stopped. */
async function stop(): Promise<number> {
  if (!(await answers(socket))) {
    console.log("bazhen is not running");
    return 0;
  }
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
    call(socket, { method: "GET", path: "/v1/health", reply: HealthResponse }, CALL_MS),
    call(socket, { method: "GET", path: "/v1/state", reply: StateSnapshot }, CALL_MS),
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

/**
 * What the daemon runs with, for diagnosing it. Fails when the daemon or its tmux server can't be
 * reached; a missing hook binary is a warning, since hooks still work through the slower script.
 */
async function doctor(): Promise<number> {
  if (!(await answers(socket))) {
    console.log(`daemon: not running (no answer on ${socket})`);
    return 1;
  }
  const d = await call(
    socket,
    { method: "GET", path: "/v1/daemon/doctor", reply: DoctorResponse },
    CALL_MS,
  );
  const removed = Object.entries(d.env.removed)
    .map(([rule, count]) => `${rule} ${count}`)
    .join(", ");
  console.log(`bazhen ${d.appVersion} (protocol ${d.protocolVersion})`);
  console.log(`tmux: ${d.runtime.state}${d.runtime.version ? ` ${d.runtime.version}` : ""}`);
  console.log(`hook client: ${d.hookClient.path}`);
  if (d.hookClient.fallback) {
    console.log("  warning: bazhen-hook is not built; hooks use the slower curl script");
  }
  console.log(`config: ${d.config.path}${d.config.found ? "" : " (none; defaults)"}`);
  console.log(
    `agents.shell: ${d.agents.shell}${d.agents.loginShell ? ` (${d.agents.loginShell})` : ""}`,
  );
  if (d.codex !== undefined) {
    const { daemon, cli } = d.codex;
    const server = daemon === null ? "not connected yet" : `${daemon} (as last connected)`;
    console.log(`codex: app-server ${server}, cli ${cli ?? "not found"}`);
  }
  const source = d.env.source === "start" ? "at start" : "by bazhen env refresh";
  console.log(`environment: captured ${d.env.capturedAt} ${source}, ${d.env.kept} variables kept`);
  console.log(`  removed: ${removed || "none"}`);
  return d.runtime.state === "unreachable" ? 1 : 0;
}

/**
 * Gives agents started from now on this shell's environment, so a rotated token or a fixed
 * PATH reaches them without restarting anything. Agents already running keep theirs.
 */
async function envRefresh(): Promise<number> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
  );
  const r = await call(socket, {
    method: "POST",
    path: "/v1/daemon/env",
    reply: EnvRefreshResponse,
    body: { env },
  });
  const removed = Object.entries(r.removed).map(([rule, count]) => `${rule} ${count}`);
  console.log(
    `environment refreshed: ${r.kept} variables kept; removed: ${removed.join(", ") || "none"}`,
  );
  if (r.refused.length > 0) {
    console.log(`  left as they were (tmux can't take them as data): ${r.refused.join(", ")}`);
  }
  if (r.unchanged.length > 0) {
    console.log(`  ${r.unchanged.length} running agents keep their environment until respawned:`);
    for (const id of r.unchanged) console.log(`    ${id}`);
  }
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
    case "doctor":
      return doctor();
    case "env":
      if (positionals[1] === "refresh") return envRefresh();
      console.error(USAGE);
      return 2;
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
