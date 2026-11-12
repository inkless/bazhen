import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SendMessageResponse, StateSnapshot } from "@bazhen/protocol";
import { Daemon, waitUntil } from "./daemon.ts";
import { startFakeModel, type FakeModel } from "./fake-model.ts";

let model: FakeModel;
let daemon: Daemon;
let agentId = "";
beforeAll(async () => {
  model = await startFakeModel();
  daemon = await Daemon.start({ modelUrl: model.url });
  agentId = (await daemon.launch("mail")).agentId;
  await waitUntil(() => daemon.screen(agentId).includes("Claude Code"), "Claude Code's TUI");
});
afterAll(async () => {
  await daemon?.stop();
  await model?.close();
});

const state = async () => StateSnapshot.parse((await daemon.request("/v1/state")).body);
const openItems = (s: StateSnapshot) => s.attention.filter((a) => a.state === "open");
/** The open item whose summary names this tool call, if one is open. */
const openItemFor = async (call: string) =>
  openItems(await state()).find((a) => a.summary.includes(call))?.id;
const send = async (key: string, body: string) =>
  SendMessageResponse.parse(
    (
      await daemon.request(`/v1/agents/${agentId}/messages`, {
        method: "POST",
        body: { idempotencyKey: key, body },
      })
    ).body,
  );

describe("mail to a Claude Code agent", () => {
  it("wakes the idle agent with the message, and confirms it once that turn ends", async () => {
    const { messageId } = await send("hello", "Reply to confirm you got this.");
    await expect
      .poll(async () => (await state()).messages.find((m) => m.id === messageId)?.state, {
        timeout: 30_000,
      })
      .toBe("delivered");
    expect(model.requests.filter((r) => r.includes(messageId)).join()).toContain(
      "Reply to confirm",
    );
  });

  it("asks the inbox before the agent runs a tool, and runs it once allowed", async () => {
    await send("tool", "[[fake:bash:touch approved-by-inbox]]");
    const opened = async () => openItems(await state())[0];
    await expect
      .poll(async () => (await opened())?.summary, { timeout: 30_000 })
      .toContain("touch approved-by-inbox");
    const id = String((await opened())?.id);
    const answered = await daemon.request(`/v1/attention/${id}/answer`, {
      method: "POST",
      body: { idempotencyKey: "allow", decision: "allow" },
    });
    expect(answered.status).toBe(200);
    await expect.poll(() => daemon.hasFile("approved-by-inbox"), { timeout: 20_000 }).toBe(true);
    expect((await state()).attention.find((a) => a.id === id)).toMatchObject({
      state: "closed",
      closeReason: "answered",
    });
  });

  it("refuses an answer to an item that is already closed", async () => {
    await send("late", "[[fake:bash:touch answered-once]]");
    await expect.poll(() => openItemFor("touch answered-once"), { timeout: 30_000 }).toBeDefined();
    const id = String(await openItemFor("touch answered-once"));
    const answer = (key: string) =>
      daemon.request(`/v1/attention/${id}/answer`, {
        method: "POST",
        body: { idempotencyKey: key, decision: "allow" },
      });
    expect((await answer("first")).status).toBe(200);
    expect((await answer("second")).status).toBe(409);
  });
});
