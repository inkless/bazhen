// A control client per terminal for the terminal's whole life: attached when the terminal is
// made, read at full rate, and never detached; it ends only when its session does.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ConfiguredTmuxServer } from "@bazhen/host-guard";
import { ControlClient } from "./control-client.ts";
import { BUSY_AGENT, FLOOD, bigFileLoop } from "./load.ts";
import { foreground, newTerminal, report, sleep, spikeServer, type Terminal } from "./spike.ts";

const servers: ConfiguredTmuxServer[] = [];
const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  for (const s of servers.splice(0)) s.kill();
});

const CYCLES = 1000;
const ROUNDS = 40;

interface Live {
  readonly t: Terminal;
  readonly client: ControlClient;
}

const commandFor = (i: number, cat: string) =>
  i % 5 === 0 ? FLOOD : i % 5 === 1 ? cat : BUSY_AGENT;

async function setup(label: string, verbose: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "bz-cc-"));
  const logDir = mkdtempSync("/dev/shm/bz-cc-log-");
  const server = spikeServer(label);
  servers.push(server);
  const fg = await foreground(server, verbose ? logDir : undefined);
  const cat = bigFileLoop(dir);
  let made = 0;
  const make = async (): Promise<Live> => {
    const i = made++;
    const t = newTerminal(server, `t${i}`, commandFor(i, cat));
    const client = await ControlClient.attach(server, t.session);
    closers.push(() => client.close());
    return { t, client };
  };
  const live = await Promise.all(Array.from({ length: 25 }, make));
  const finish = () => {
    const log = fg.log?.stop() ?? null;
    rmSync(logDir, { recursive: true, force: true });
    return log;
  };
  return { server, fg, make, live, finish };
}

/**
 * Terminals come and go while 25 live: each cycle ends the oldest terminal's session, which ends
 * its client with it, and makes a new one with its own client.
 */
async function terminalChurn(name: string, verbose = false) {
  const { server, fg, make, live, finish } = await setup(`persist-${name}`, verbose);
  let cycles = 0;
  let clientExits = 0;
  const started = Date.now();
  while (cycles < CYCLES && fg.end() === null) {
    const old = live.shift();
    if (old === undefined) break;
    await server.run(["kill-session", "-t", old.t.session]).catch(() => undefined);
    await Promise.race([old.client.exited, sleep(2000)]);
    clientExits += Number(old.client.child.exitCode !== null);
    if (fg.end() !== null) break;
    live.push(await make());
    cycles++;
  }
  const churnMs = Date.now() - started;
  await Promise.race([fg.ended, sleep(5000)]);
  const end = fg.end();
  const row = {
    scenario: name,
    cycles,
    churnMs,
    clientsEndedWithSession: clientExits,
    serverAlive: end === null,
    serverCode: end?.code ?? null,
    serverSignal: end?.signal ?? null,
    log: finish(),
    liveClientsRunning: live.filter((l) => l.client.child.exitCode === null).length,
  };
  report("persistent-crash", row);
  return row;
}

/** A daemon restart, `ROUNDS` times: every client leaves, then each terminal gets a new one. */
async function restarts(name: string) {
  const { server, fg, live, finish } = await setup(`restart-${name}`, false);
  let rounds = 0;
  while (rounds < ROUNDS && fg.end() === null) {
    await Promise.all(live.map((l) => l.client.close()));
    const fresh = await Promise.all(
      live.map(async (l) => ({ t: l.t, client: await ControlClient.attach(server, l.t.session) })),
    ).catch(() => []);
    for (const f of fresh) closers.push(() => f.client.close());
    live.splice(0, live.length, ...fresh);
    rounds++;
  }
  await Promise.race([fg.ended, sleep(5000)]);
  const end = fg.end();
  const row = {
    scenario: name,
    rounds,
    attachDetachCycles: rounds * 25,
    serverAlive: end === null,
    serverCode: end?.code ?? null,
    log: finish(),
  };
  report("persistent-restart", row);
  return row;
}

/** 25 persistent clients and no churn at all, for a minute. */
async function hold() {
  const { fg, live, finish } = await setup("persist-hold", false);
  await Promise.race([fg.ended, sleep(60_000)]);
  const end = fg.end();
  const row = {
    serverAlive: end === null,
    serverCode: end?.code ?? null,
    mbReceived: Math.round(live.reduce((a, l) => a + l.client.bytes, 0) / 1e6),
    log: finish(),
  };
  report("persistent-hold", row);
  return row;
}

describe("a control client per terminal, never detached", () => {
  it.each(["1", "2", "3"])("1000 terminals made and ended under floods, run %s", async (n) => {
    const row = await terminalChurn(`terminal-churn-${n}`);
    expect(row.scenario).toBe(`terminal-churn-${n}`);
  });

  it("1000 terminals made and ended under floods, with tmux's verbose log", async () => {
    const row = await terminalChurn("terminal-churn-verbose", true);
    expect(row.scenario).toBe("terminal-churn-verbose");
  });

  it("40 daemon restarts: every client leaves and comes back, under floods", async () => {
    const row = await restarts("restart");
    expect(row.scenario).toBe("restart");
  });

  it("25 clients and no churn for 60 s under floods", async () => {
    const row = await hold();
    expect(typeof row.serverAlive).toBe("boolean");
  });
});
