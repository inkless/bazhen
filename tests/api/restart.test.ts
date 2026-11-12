import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LaunchAgentResponse, SendMessageResponse, StateSnapshot } from "@bazhen/protocol";
import { Daemon, waitUntil } from "./daemon.ts";
import { startFakeModel, type FakeModel } from "./fake-model.ts";

let model: FakeModel;
let daemon: Daemon;
let launched: LaunchAgentResponse;
beforeAll(async () => {
  model = await startFakeModel();
  daemon = await Daemon.start({ modelUrl: model.url });
  launched = LaunchAgentResponse.parse(
    (
      await daemon.request("/v1/agents", {
        method: "POST",
        body: { idempotencyKey: "survivor", harness: "claude-code", cwd: daemon.work },
      })
    ).body,
  );
  await waitUntil(
    () => daemon.screen(launched.agentId).includes("Claude Code"),
    "Claude Code's TUI",
  );
  await daemon.kill();
  await daemon.restart();
});
afterAll(async () => {
  await daemon?.stop();
  await model?.close();
});

const state = async () => StateSnapshot.parse((await daemon.request("/v1/state")).body);

describe("after the daemon is killed with -9 and started again", () => {
  it("still has the agent, running, under the same ids", async () => {
    expect((await state()).agents.find((a) => a.id === launched.agentId)).toMatchObject({
      state: "running",
      terminalId: launched.terminalId,
    });
  });

  it("shows the agent's terminal to a new view", async () => {
    const view = await daemon.view(String(launched.terminalId), "observe");
    await expect.poll(() => view.output(), { timeout: 10_000 }).toMatch(/Claude Code/);
    view.close();
  });

  it("delivers mail to the agent through its waiter, which reconnected by itself", async () => {
    const { messageId } = SendMessageResponse.parse(
      (
        await daemon.request(`/v1/agents/${launched.agentId}/messages`, {
          method: "POST",
          body: { idempotencyKey: "after-restart", body: "Still there?" },
        })
      ).body,
    );
    await expect
      .poll(async () => (await state()).messages.find((m) => m.id === messageId)?.state, {
        timeout: 30_000,
      })
      .toBe("delivered");
  });
});
