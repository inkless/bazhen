import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  SendMessageResponse,
  StateSnapshot,
  type Agent,
  type LaunchAgentResponse,
} from "@bazhen/protocol";
import { BANNER, Daemon, waitUntil } from "./daemon.ts";
import { startFakeModel, type FakeModel } from "./fake-model.ts";

let model: FakeModel;

const snapshot = async (daemon: Daemon) =>
  StateSnapshot.parse((await daemon.request("/v1/state")).body);
const agentOf = async (daemon: Daemon, agentId: string) =>
  (await snapshot(daemon)).agents.find((a) => a.id === agentId);
const stateOf = async (daemon: Daemon, agentId: string) => (await agentOf(daemon, agentId))?.state;
/** The agent's activity, if its harness reported it before `ts`. */
const signalsBefore = (agent: Agent | undefined, ts: string) =>
  [agent?.activity].filter((a) => a !== undefined && a.observedAt < ts);
const messageOf = async (daemon: Daemon, messageId: string) =>
  (await snapshot(daemon)).messages.find((m) => m.id === messageId);

/** A daemon with one Claude Code agent up and showing its banner. */
async function withLiveAgent(): Promise<{ daemon: Daemon; agent: LaunchAgentResponse }> {
  const daemon = await Daemon.start({ modelUrl: model.url });
  const agent = await daemon.launch("agent", "claude-code");
  await waitUntil(
    () => daemon.screen(agent.agentId).includes(BANNER["claude-code"]),
    "the agent's banner",
    30_000,
  );
  return { daemon, agent };
}

/** The same, then the daemon killed with -9. */
async function killedWithAgent(): Promise<{ daemon: Daemon; agent: LaunchAgentResponse }> {
  const live = await withLiveAgent();
  await live.daemon.kill();
  return live;
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

describe("a running daemon whose tmux server dies", () => {
  let daemon: Daemon;
  let agent: LaunchAgentResponse;
  beforeAll(async () => {
    ({ daemon, agent } = await withLiveAgent());
    daemon.tmuxServer.kill();
  });
  afterAll(async () => {
    await daemon?.stop();
  });

  it("marks the agent that ran on it lost, without a restart", async () => {
    await expect.poll(() => stateOf(daemon, agent.agentId), { timeout: 20_000 }).toBe("lost");
  });

  it("offers a lost agent that never had a turn only a fresh session, and starts one when asked", async () => {
    await expect.poll(() => stateOf(daemon, agent.agentId), { timeout: 20_000 }).toBe("lost");
    const lost = await agentOf(daemon, agent.agentId);
    const relaunch = (key: string, fresh: boolean) =>
      daemon.request(`/v1/agents/${agent.agentId}/relaunch`, {
        method: "POST",
        body: { idempotencyKey: key, generation: lost?.generation, fresh },
      });
    const resumed = await relaunch("resume", false);
    const fresh = await relaunch("fresh", true);
    const after = await agentOf(daemon, agent.agentId);
    expect([
      lost?.resumable,
      resumed.status,
      fresh.status,
      after?.state,
      after?.externalRef?.id === lost?.externalRef?.id,
    ]).toEqual([false, 409, 200, "running", false]);
    await waitUntil(
      () => daemon.screen(agent.agentId).includes(BANNER["claude-code"]),
      "the fresh session's banner",
      30_000,
    );
    // Idle on its new session, it is woken for mail with nothing typed into it.
    const sent = SendMessageResponse.parse(
      (
        await daemon.request(`/v1/agents/${agent.agentId}/messages`, {
          method: "POST",
          body: { idempotencyKey: "after-fresh", body: "hello, new session" },
        })
      ).body,
    );
    await expect
      .poll(async () => (await messageOf(daemon, sent.messageId))?.state, { timeout: 60_000 })
      .toBe("delivered");
  });
});

describe("an agent lost with its tmux server, relaunched", () => {
  let daemon: Daemon;
  let agent: LaunchAgentResponse;
  beforeAll(async () => {
    ({ daemon, agent } = await withLiveAgent());
    await daemon.prompt(agent, "remember this line");
    // The model's reply on screen: a session with no turn yet has no conversation to resume, and
    // an idle signal can arrive before the typed prompt has started one.
    await waitUntil(
      () => daemon.screen(agent.agentId).includes("● ok"),
      "the model's reply",
      30_000,
    );
    daemon.tmuxServer.kill();
    await waitUntil(
      async () => (await stateOf(daemon, agent.agentId)) === "lost",
      "the agent to be lost",
      20_000,
    );
  });
  afterAll(async () => {
    await daemon?.stop();
  });

  it("starts on a new terminal and server, on its session, with mail sent while it was lost", async () => {
    const lost = await agentOf(daemon, agent.agentId);
    // Its hooks named the transcript, which its turn wrote.
    expect(lost?.resumable).toBe(true);
    const sent = SendMessageResponse.parse(
      (
        await daemon.request(`/v1/agents/${agent.agentId}/messages`, {
          method: "POST",
          body: { idempotencyKey: "while-lost", body: "hello again" },
        })
      ).body,
    );
    const asked = new Date().toISOString();
    const res = await daemon.request(`/v1/agents/${agent.agentId}/relaunch`, {
      method: "POST",
      body: { idempotencyKey: "relaunch", generation: lost?.generation, theme: "light" },
    });
    const relaunched = await agentOf(daemon, agent.agentId);
    expect([
      res.status,
      relaunched?.state,
      relaunched?.terminalId === lost?.terminalId,
      relaunched?.generation,
      relaunched?.externalRef?.id,
      relaunched?.theme,
    ]).toEqual([
      200,
      "running",
      false,
      Number(lost?.generation) + 1,
      lost?.externalRef?.id,
      "light",
    ]);
    // What the lost process was last doing is gone with it; only the new one's can show.
    expect(signalsBefore(relaunched, asked)).toEqual([]);
    // The resumed session shows the conversation it had before its server died.
    await expect
      .poll(() => daemon.screen(agent.agentId), { timeout: 30_000 })
      .toContain("remember this line");
    await expect
      .poll(async () => (await messageOf(daemon, sent.messageId))?.state, { timeout: 60_000 })
      .toBe("delivered");
  });
});

describe("a running daemon whose tmux server's socket is deleted", () => {
  let daemon: Daemon;
  let agent: LaunchAgentResponse;
  beforeAll(async () => {
    ({ daemon, agent } = await withLiveAgent());
    daemon.deleteTmuxSocket();
  });
  afterAll(async () => {
    await daemon?.stop();
  });

  it("keeps the agent running, and shows its terminal once the socket is back", async () => {
    await expect.poll(() => daemon.tmuxSocketExists(), { timeout: 20_000 }).toBe(true);
    const view = await daemon.view(String(agent.terminalId), "observe");
    await expect.poll(() => view.text(), { timeout: 10_000 }).toContain(BANNER["claude-code"]);
    view.close();
    expect(await stateOf(daemon, agent.agentId)).toBe("running");
  });
});
