import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nodePtySpawner } from "@bazhen/daemon/pty";
import type { ConfiguredTmuxServer } from "@bazhen/host-guard";
import { ControlClient } from "./control-client.ts";
import { BUSY_AGENT, FLOOD, bigFileLoop } from "./load.ts";
import {
  HISTORY,
  SIZE,
  attachEnv,
  foreground,
  newTerminal,
  report,
  sleep,
  spikeServer,
  type ServerEnd,
  type Terminal,
} from "./spike.ts";

const servers: ConfiguredTmuxServer[] = [];
const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  for (const s of servers.splice(0)) s.kill();
});

type Viewer = "none" | "control" | "attach";
type Load = "mixed" | "busy";
type Churn = "none" | "control-snapshot" | "control-bare" | "attach-snapshot";

interface Scenario {
  readonly viewers: Viewer;
  readonly load: Load;
  readonly churn: Churn;
}

const CYCLES = 1000;
const HOLD_MS = 15_000;

/** 5 `yes`, 5 loops over a 50 MB file and 15 busy agents; or 25 busy agents. */
function commandFor(load: Load, i: number, cat: string): string {
  if (load === "busy") return BUSY_AGENT;
  return i < 5 ? FLOOD : i < 10 ? cat : BUSY_AGENT;
}

/** A PTY `tmux attach`, as client mode keeps one per viewed terminal. */
function attachClient(server: ConfiguredTmuxServer, t: Terminal) {
  const proc = nodePtySpawner.spawn(
    server.argv("attach-session", "-t", t.session),
    SIZE,
    attachEnv(),
  );
  let bytes = 0;
  let exited = false;
  proc.onData((d) => (bytes += d.length));
  proc.onExit(() => (exited = true));
  return { proc, bytes: () => bytes, running: () => !exited };
}

/** Client mode's attach: the window's size, its history, then a PTY client, which then leaves. */
async function attachCycle(server: ConfiguredTmuxServer, t: Terminal): Promise<boolean> {
  try {
    await server.run(["display-message", "-p", "-t", t.pane, "#{window_width} #{history_size}"]);
    await server.run([
      "capture-pane",
      "-p",
      "-e",
      "-J",
      "-t",
      t.pane,
      "-S",
      `-${HISTORY}`,
      "-E",
      "-1",
    ]);
  } catch {
    return false;
  }
  const c = attachClient(server, t);
  const start = Date.now();
  while (c.bytes() === 0 && c.running() && Date.now() - start < 2000) await sleep(5);
  c.proc.kill();
  return c.bytes() > 0;
}

async function controlCycle(server: ConfiguredTmuxServer, t: Terminal, snapshot: boolean) {
  const extra = await ControlClient.attach(server, t.session).catch(() => undefined);
  if (extra === undefined) return false;
  if (snapshot) await extra.snapshot(t.pane, "#{cursor_x} #{cursor_y} #{alternate_on}");
  await extra.close();
  return true;
}

function cycle(churn: Churn, server: ConfiguredTmuxServer, t: Terminal): Promise<boolean> {
  if (churn === "attach-snapshot") return attachCycle(server, t);
  return controlCycle(server, t, churn === "control-snapshot");
}

async function viewAll(viewers: Viewer, server: ConfiguredTmuxServer, terminals: Terminal[]) {
  if (viewers === "control") {
    const clients = await Promise.all(
      terminals.map((t) => ControlClient.attach(server, t.session)),
    );
    for (const c of clients) closers.push(() => c.close());
    return () =>
      clients.filter((c) => c.child.exitCode === null && c.child.signalCode === null).length;
  }
  if (viewers === "attach") {
    const clients = terminals.map((t) => attachClient(server, t));
    for (const c of clients) closers.push(() => c.proc.kill());
    return () => clients.filter((c) => c.running()).length;
  }
  return () => 0;
}

async function run(name: string, s: Scenario) {
  const dir = mkdtempSync(join(tmpdir(), "bz-cc-"));
  const server = spikeServer(`crash-${name}`);
  servers.push(server);
  const fg = await foreground(server);
  const cat = bigFileLoop(dir);
  const terminals = Array.from({ length: 25 }, (_, i) =>
    newTerminal(server, `t${i}`, commandFor(s.load, i, cat)),
  );
  const running = await viewAll(s.viewers, server, terminals);
  const started = Date.now();
  let cycles = 0;
  let failed = 0;
  const churns = s.churn === "none" ? 0 : CYCLES;
  while (cycles < churns && fg.end() === null) {
    const t = terminals[cycles % terminals.length];
    if (t !== undefined && !(await cycle(s.churn, server, t))) failed++;
    cycles++;
  }
  const churnMs = Date.now() - started;
  await Promise.race([fg.ended, sleep(s.churn === "none" ? HOLD_MS : 5000)]);
  const end: ServerEnd | null = fg.end();
  const row = {
    scenario: name,
    ...s,
    cycles,
    failedCycles: failed,
    churnMs,
    serverAlive: end === null,
    serverSignal: end?.signal ?? null,
    serverCode: end?.code ?? null,
    serverDiedAtMs: end?.atMs ?? null,
    serverStderr: end?.stderr.trim() || null,
    viewersRunning: running(),
  };
  report("crash", row);
  return row;
}

async function offTrial(i: number): Promise<boolean> {
  const server = spikeServer(`off-${i}`);
  servers.push(server);
  const fg = await foreground(server);
  const t = newTerminal(server, "busy", FLOOD);
  const client = await ControlClient.attach(server, t.session);
  closers.push(() => client.close());
  await sleep(300);
  await Promise.race([client.command(`refresh-client -A '${t.pane}:off'`), sleep(2000)]);
  await Promise.race([fg.ended, sleep(1000)]);
  report("crash-positive-control-trial", { trial: i, end: fg.end() });
  return fg.end() !== null;
}

const CONTROL_FULL: Scenario = { viewers: "control", load: "mixed", churn: "control-snapshot" };
const ATTACH_FULL: Scenario = { viewers: "attach", load: "mixed", churn: "attach-snapshot" };

describe("what kills the server under 25 viewers, floods and churn", () => {
  it.each([
    ["control-viewers-only", { viewers: "control", load: "mixed", churn: "none" }],
    ["attach-viewers-only", { viewers: "attach", load: "mixed", churn: "none" }],
    ["control-churn-snapshot", { viewers: "none", load: "mixed", churn: "control-snapshot" }],
    ["control-churn-bare", { viewers: "none", load: "mixed", churn: "control-bare" }],
    ["control-churn-busy-only", { viewers: "none", load: "busy", churn: "control-snapshot" }],
    ["attach-churn-snapshot", { viewers: "none", load: "mixed", churn: "attach-snapshot" }],
    ["control-full-1", CONTROL_FULL],
    ["control-full-2", CONTROL_FULL],
    ["control-full-3", CONTROL_FULL],
    ["attach-full-1", ATTACH_FULL],
    ["attach-full-2", ATTACH_FULL],
    ["attach-full-3", ATTACH_FULL],
  ] as const)("%s", async (name, scenario) => {
    const row = await run(name, scenario);
    expect(row.scenario).toBe(name);
  });

  it("the harness can see a crash: refresh-client -A off on a busy pane, 8 trials", async () => {
    const TRIALS = 8;
    const deaths: boolean[] = [];
    for (let i = 0; i < TRIALS; i++) deaths.push(await offTrial(i));
    report("crash-positive-control", {
      trials: TRIALS,
      serverDeaths: deaths.filter(Boolean).length,
    });
    expect(deaths).toHaveLength(TRIALS);
  });
});
