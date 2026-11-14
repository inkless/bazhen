import { afterEach, describe, expect, it } from "vitest";
import { nodePtySpawner } from "@bazhen/daemon/pty";
import type { ConfiguredTmuxServer } from "@bazhen/host-guard";
import type { PtyProcess } from "@bazhen/core";
import { ControlClient } from "./control-client.ts";
import { BUSY_AGENT, FLOOD } from "./load.ts";
import {
  attachEnv,
  SIZE,
  Screen,
  cpuSeconds,
  newTerminal,
  report,
  serverPid,
  sleep,
  spikeServer,
  type Terminal,
} from "./spike.ts";

const WINDOW_MS = 15_000;

const servers: ConfiguredTmuxServer[] = [];
const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  for (const s of servers.splice(0)) s.kill();
});

type Mode = "attach" | "control";

/** Views `terminals` the way `mode` does, each into a headless screen as the daemon keeps one. */
async function viewAll(server: ConfiguredTmuxServer, terminals: readonly Terminal[], mode: Mode) {
  for (const t of terminals) {
    const screen = new Screen(SIZE, 2000);
    if (mode === "control") {
      const client = await ControlClient.attach(server, t.session);
      client.onOutput((_pane, data) => screen.write(data));
      closers.push(() => client.close());
    } else {
      const proc: PtyProcess = nodePtySpawner.spawn(
        server.argv("attach-session", "-t", t.session),
        SIZE,
        attachEnv(),
      );
      proc.onData((data) => screen.write(data));
      closers.push(() => proc.kill());
    }
  }
}

function clientPids(server: ConfiguredTmuxServer): number[] {
  const out = server.runSync(["list-clients", "-F", "#{client_pid}"]).trim();
  return out === "" ? [] : out.split("\n").map(Number);
}

const sum = (ps: readonly number[]) => ps.reduce((a, p) => a + cpuSeconds(p), 0);

async function measure(workload: "busy" | "flood", viewed: number, mode: Mode) {
  const server = spikeServer(`cpu-${workload}-${viewed}-${mode}`);
  servers.push(server);
  const terminals: Terminal[] = [];
  for (let i = 0; i < 25; i++) {
    const command = workload === "flood" && i < 5 ? FLOOD : BUSY_AGENT;
    terminals.push(newTerminal(server, `t${i}`, command));
  }
  await viewAll(server, terminals.slice(0, viewed), mode);
  await sleep(2000);
  const tmuxPid = serverPid(server);
  const pids = clientPids(server);
  const t0 = { tmux: cpuSeconds(tmuxPid), clients: sum(pids), self: process.cpuUsage() };
  await sleep(WINDOW_MS);
  const self = process.cpuUsage(t0.self);
  const pct = (s: number) => Math.round((s / (WINDOW_MS / 1000)) * 1000) / 10;
  const row = {
    workload,
    viewed,
    mode,
    clients: pids.length,
    tmuxServerPct: pct(cpuSeconds(tmuxPid) - t0.tmux),
    tmuxClientsPct: pct(sum(pids) - t0.clients),
    consumerPct: pct((self.user + self.system) / 1e6),
    consumerRssMb: Math.round(process.memoryUsage().rss / 1e6),
  };
  report("cpu", row);
  for (const c of closers.splice(0)) await c();
  server.kill();
  return row;
}

describe("CPU, client mode against control mode", () => {
  it.each([
    ["busy", 0, "control"],
    ["busy", 2, "attach"],
    ["busy", 2, "control"],
    ["busy", 25, "attach"],
    ["busy", 25, "control"],
    ["flood", 2, "attach"],
    ["flood", 2, "control"],
    ["flood", 25, "attach"],
    ["flood", 25, "control"],
  ] as const)("%s agents, %i viewed, %s", async (workload, viewed, mode) => {
    const row = await measure(workload, viewed, mode);
    expect(row.clients).toBe(viewed);
  });
});
