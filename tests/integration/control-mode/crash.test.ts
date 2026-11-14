import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ConfiguredTmuxServer } from "@bazhen/host-guard";
import { ControlClient } from "./control-client.ts";
import { BUSY_AGENT, FLOOD, bigFileLoop } from "./load.ts";
import { newTerminal, report, sleep, spikeServer, type Terminal } from "./spike.ts";

const servers: ConfiguredTmuxServer[] = [];
const clients: ControlClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close();
  for (const s of servers.splice(0)) s.kill();
});

const CHURN = 1000;

const commandFor = (i: number, cat: string) => (i < 5 ? FLOOD : i < 10 ? cat : BUSY_AGENT);

/** One extra client attaches to `t`, takes attach's snapshot and detaches; false if it failed. */
async function cycle(server: ConfiguredTmuxServer, t: Terminal): Promise<boolean> {
  const extra = await ControlClient.attach(server, t.session).catch(() => undefined);
  if (extra === undefined) return false;
  await extra.snapshot(t.pane, "#{cursor_x}");
  await extra.close();
  return true;
}

const running = (c: ControlClient) => c.child.exitCode === null && c.child.signalCode === null;

async function crash25() {
  const dir = mkdtempSync(join(tmpdir(), "bz-cc-"));
  const server = spikeServer("crash");
  servers.push(server);
  const cat = bigFileLoop(dir);
  const terminals = Array.from({ length: 25 }, (_, i) =>
    newTerminal(server, `t${i}`, commandFor(i, cat)),
  );
  const viewers = await Promise.all(terminals.map((t) => ControlClient.attach(server, t.session)));
  clients.push(...viewers);
  const start = Date.now();
  let failedAttaches = 0;
  for (let n = 0; n < CHURN; n++) {
    const t = terminals[n % terminals.length];
    if (t !== undefined && !(await cycle(server, t))) failedAttaches++;
  }
  const churnMs = Date.now() - start;
  await sleep(10_000);
  const received = viewers.map((v) => v.bytes);
  const row = {
    cycles: CHURN,
    churnMs,
    failedAttaches,
    serverAlive: server.alive(),
    viewersRunning: viewers.filter(running).length,
    exitReasons: viewers.map((v) => v.exitReason).filter((r) => r !== null),
    mbReceivedTotal: Math.round(received.reduce((a, b) => a + b, 0) / 1e6),
    mbReceivedMin: Math.round(Math.min(...received) / 1e6),
  };
  report("crash-25", row);
  return row;
}

async function offTrial(i: number): Promise<boolean> {
  const server = spikeServer(`control-${i}`);
  servers.push(server);
  const t = newTerminal(server, "busy", FLOOD);
  const client = await ControlClient.attach(server, t.session);
  clients.push(client);
  await sleep(300);
  await Promise.race([client.command(`refresh-client -A '${t.pane}:off'`), sleep(2000)]);
  await sleep(500);
  return !server.alive();
}

describe("25 control clients", () => {
  it("survive floods, a big cat and 1000 attach/detach cycles", async () => {
    const row = await crash25();
    expect(row).toMatchObject({ serverAlive: true, viewersRunning: 25, failedAttaches: 0 });
  });

  it("the harness can see a crash: refresh-client -A off on a busy pane, 8 trials", async () => {
    const TRIALS = 8;
    const deaths: boolean[] = [];
    for (let i = 0; i < TRIALS; i++) deaths.push(await offTrial(i));
    const serverDeaths = deaths.filter(Boolean).length;
    report("crash-positive-control", { trials: TRIALS, serverDeaths });
    expect(deaths).toHaveLength(TRIALS);
  });
});
