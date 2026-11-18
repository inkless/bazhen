import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HealthResponse, ShellCommandResponse, StateSnapshot } from "@bazhen/protocol";
import { closeHolderAt, holderSockets } from "../support/holder-close.ts";
import { bazhen, Daemon } from "./daemon.ts";
import { startFakeModel, type FakeModel } from "./fake-model.ts";

let model: FakeModel;

const snapshot = async (daemon: Daemon) =>
  StateSnapshot.parse((await daemon.request("/v1/state")).body);

async function openShell(daemon: Daemon, key: string): Promise<string> {
  const opened = await daemon.request("/v1/shells", {
    method: "POST",
    body: { idempotencyKey: key, cwd: daemon.work },
  });
  return ShellCommandResponse.parse(opened.body).terminalId;
}

const runtimeOf = (command: string | null) =>
  command === null ? "none" : command.startsWith("bazhen terminals attach") ? "holder" : "tmux";

/** Each runtime the daemon reports, as `<kind>: <state>`. */
async function runtimeStates(daemon: Daemon): Promise<string[]> {
  const { runtimes } = HealthResponse.parse((await daemon.request("/v1/health")).body);
  return runtimes.map((r) => `${r.kind}: ${r.state}`);
}

/** Each terminal's state and the runtime its attach command names, by TerminalId. */
async function terminals(daemon: Daemon): Promise<Record<string, string>> {
  const { agents, shells } = await snapshot(daemon);
  return Object.fromEntries([
    ...agents.map((a) => [String(a.terminalId), `${a.state} on ${runtimeOf(a.attachCommand)}`]),
    ...shells.map((s) => [s.id, `${s.state} on ${runtimeOf(s.attachCommand)}`]),
  ]);
}

beforeAll(async () => {
  model = await startFakeModel();
});
afterAll(async () => {
  await model?.close();
});

describe("a daemon running terminals on both runtimes", () => {
  let daemon: Daemon;
  let onTmux: string;
  let holderShell: string;
  let holderAgent: string;

  beforeAll(async () => {
    daemon = await Daemon.start({ modelUrl: model.url, runtime: "tmux" });
    onTmux = await openShell(daemon, "tmux-shell");
    await daemon.crash();
    daemon.useRuntime("holder");
    await daemon.restart();
    holderShell = await openShell(daemon, "holder-shell");
    const launched = await daemon.launch("holder-agent");
    holderAgent = String(launched.terminalId);
    await daemon.running(launched.agentId);
  }, 120_000);
  afterAll(async () => {
    await daemon?.stop();
  });

  it("makes new terminals on the default, and keeps the old one where it was made", async () => {
    expect(await terminals(daemon)).toEqual({
      [onTmux]: "running on tmux",
      [holderShell]: "running on holder",
      [holderAgent]: "running on holder",
    });
    expect(holderSockets(daemon.home).toSorted()).toEqual(
      [holderShell, holderAgent].map((id) => `${daemon.home}/run/holders/${id}.sock`).toSorted(),
    );
  });

  it("reads tmux while a terminal is open on it, though holders are the default", async () => {
    expect(await runtimeStates(daemon)).toEqual(["tmux: healthy", "holder: healthy"]);
  });

  it("finds each one on its own runtime after a crash", async () => {
    await daemon.crash();
    await daemon.restart();
    expect(await terminals(daemon)).toEqual({
      [onTmux]: "running on tmux",
      [holderShell]: "running on holder",
      [holderAgent]: "running on holder",
    });
  });

  it("calls only the agent whose holder ended lost, while the daemon runs, and leaves the rest", async () => {
    await closeHolderAt(`${daemon.home}/run/holders/${holderAgent}.sock`);
    await expect
      .poll(async () => (await terminals(daemon))[holderAgent], { timeout: 30_000 })
      .toBe("lost on none");
    expect(await terminals(daemon)).toEqual({
      [onTmux]: "running on tmux",
      [holderShell]: "running on holder",
      [holderAgent]: "lost on none",
    });
  });
});

describe("a holder daemon on a machine without tmux", () => {
  let daemon: Daemon;

  beforeAll(async () => {
    daemon = await Daemon.start({ runtime: "holder", withoutTmux: true });
  }, 60_000);
  afterAll(async () => {
    await daemon?.stop();
  });

  it("reports tmux unused, and passes doctor", async () => {
    const doctor = await bazhen(["doctor"], daemon.env);
    expect([
      await runtimeStates(daemon),
      doctor.code,
      doctor.out.split("\n").filter((l) => l.startsWith("tmux")),
    ]).toEqual([["tmux: unused", "holder: not-running"], 0, ["tmux: unused"]]);
  });

  it("runs no tmux while a holder shell runs, beyond asking its version at start", async () => {
    const shell = await openShell(daemon, "no-tmux-shell");
    await expect
      .poll(async () => (await terminals(daemon))[shell], { timeout: 30_000 })
      .toBe("running on holder");
    // Past several of tmux's exit polls and the shells' foreground reads.
    await new Promise((r) => setTimeout(r, 3_000));
    expect(daemon.tmuxRan().filter((args) => !args.endsWith(" -V"))).toEqual([]);
  });
});
