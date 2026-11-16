import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ShellCommandResponse, StateSnapshot } from "@bazhen/protocol";
import { closeHolder, Daemon, holderSockets } from "./daemon.ts";
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
  command === null ? "none" : command.startsWith("bazhen attach") ? "holder" : "tmux";

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
    daemon = await Daemon.start({ modelUrl: model.url });
    onTmux = await openShell(daemon, "tmux-shell");
    await daemon.crash();
    daemon.writeConfig('[runtime]\ndefault = "holder"\n');
    await daemon.restart();
    holderShell = await openShell(daemon, "holder-shell");
    holderAgent = String((await daemon.launch("holder-agent")).terminalId);
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
    await closeHolder(`${daemon.home}/run/holders/${holderAgent}.sock`);
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
