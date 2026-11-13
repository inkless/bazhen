import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { StateSnapshot, type LaunchAgentResponse } from "@bazhen/protocol";
import { BANNER, Daemon, waitUntil } from "./daemon.ts";
import { startFakeModel, type FakeModel } from "./fake-model.ts";

let model: FakeModel;

const stateOf = async (daemon: Daemon, agentId: string) =>
  StateSnapshot.parse((await daemon.request("/v1/state")).body).agents.find((a) => a.id === agentId)
    ?.state;

/** A daemon with one Claude Code agent up, then killed with -9. */
async function killedWithAgent(): Promise<{ daemon: Daemon; agent: LaunchAgentResponse }> {
  const daemon = await Daemon.start({ modelUrl: model.url });
  const agent = await daemon.launch("agent", "claude-code");
  await waitUntil(
    () => daemon.screen(agent.agentId).includes(BANNER["claude-code"]),
    "the agent's banner",
    30_000,
  );
  await daemon.kill();
  return { daemon, agent };
}

beforeAll(async () => {
  model = await startFakeModel();
});
afterAll(async () => {
  await model?.close();
});

describe("a daemon started again after its tmux server died", () => {
  let daemon: Daemon;
  let agent: LaunchAgentResponse;
  beforeAll(async () => {
    ({ daemon, agent } = await killedWithAgent());
    daemon.tmuxServer.kill();
    await daemon.restart();
  });
  afterAll(async () => {
    await daemon?.stop();
  });

  it("marks the agent that ran on it lost", async () => {
    expect(await stateOf(daemon, agent.agentId)).toBe("lost");
  });
});

describe("a daemon started again after its tmux server's socket was deleted", () => {
  let daemon: Daemon;
  let agent: LaunchAgentResponse;
  beforeAll(async () => {
    ({ daemon, agent } = await killedWithAgent());
    daemon.deleteTmuxSocket();
    await daemon.restart();
  });
  afterAll(async () => {
    await daemon?.stop();
  });

  it("keeps the agent running, and shows its terminal on the recreated socket", async () => {
    expect(await stateOf(daemon, agent.agentId)).toBe("running");
    const view = await daemon.view(String(agent.terminalId), "observe");
    await expect.poll(() => view.text(), { timeout: 10_000 }).toContain(BANNER["claude-code"]);
    view.close();
  });
});
