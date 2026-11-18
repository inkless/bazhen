import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeHolderAt, holderSockets } from "../support/holder-close.ts";
import { Daemon } from "./daemon.ts";
import { startFakeModel, type FakeModel } from "./fake-model.ts";
import { openShell, runtimeStates, terminals } from "./runtime-states.ts";

let model: FakeModel;

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

  it("reads tmux while a terminal is open on it, though holders are the default, and not after", async () => {
    const whileOpen = await runtimeStates(daemon);
    const closed = await daemon.request(`/v1/shells/${onTmux}/close`, {
      method: "POST",
      body: { idempotencyKey: "close-tmux-shell", generation: 0 },
    });
    expect([whileOpen, closed.status]).toEqual([["tmux: healthy", "holder: healthy"], 200]);
    await expect
      .poll(() => runtimeStates(daemon), { timeout: 15_000 })
      .toEqual(["tmux: unused", "holder: healthy"]);
  });
});
