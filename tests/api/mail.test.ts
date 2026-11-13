import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EVENTS, SendMessageResponse, StateSnapshot, type Event } from "@bazhen/protocol";
import { Daemon, waitUntil, type EventClient } from "./daemon.ts";
import { startFakeModel, type FakeModel } from "./fake-model.ts";

let model: FakeModel;
let daemon: Daemon;
let agentId = "";
let terminalId: string | null = null;
beforeAll(async () => {
  model = await startFakeModel();
  daemon = await Daemon.start({ modelUrl: model.url });
  ({ agentId, terminalId } = await daemon.launch("mail"));
  await waitUntil(() => daemon.screen(agentId).includes("Claude Code"), "Claude Code's TUI");
});
afterAll(async () => {
  await daemon?.stop();
  await model?.close();
});

const state = async () => StateSnapshot.parse((await daemon.request("/v1/state")).body);
const agentIn = (s: StateSnapshot) => s.agents.find((a) => a.id === agentId);
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

/** Whether the agent's TUI is in the middle of a turn, offering to interrupt it. */
const busy = () => /esc to interrupt/i.test(daemon.screen(agentId));
/** The events a stream received about one entity, in order. */
const eventsAbout = (stream: EventClient, entityId: string): Event[] =>
  stream.frames.flatMap((f) =>
    f.type === "event" && f.event.entityId === entityId ? [f.event] : [],
  );
/** Why each requeue among these events happened. */
const requeueReasons = (events: Event[]) =>
  events.flatMap((e) =>
    e.type === "mailbox.requeued" ? [EVENTS[e.type].payload.parse(e.payload).reason] : [],
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
    const { messageId } = await send("late", "[[fake:bash:touch answered-once]]");
    await expect.poll(() => openItemFor("touch answered-once"), { timeout: 30_000 }).toBeDefined();
    const id = String(await openItemFor("touch answered-once"));
    const answer = (key: string) =>
      daemon.request(`/v1/attention/${id}/answer`, {
        method: "POST",
        body: { idempotencyKey: key, decision: "allow" },
      });
    expect((await answer("first")).status).toBe(200);
    expect((await answer("second")).status).toBe(409);
    // Its turn ends before the next test kills the agent, so nothing is left to re-deliver.
    await expect
      .poll(async () => (await state()).messages.find((m) => m.id === messageId)?.state, {
        timeout: 30_000,
      })
      .toBe("delivered");
  });

  // Mail reaches Claude Code only through hooks installed at launch, so this shows a respawn
  // resumes the session with them.
  it("delivers mail to the agent once it has been respawned on its session", async () => {
    await daemon.signalAgent(agentId, "SIGKILL");
    await expect
      .poll(async () => agentIn(await state())?.state, { timeout: 10_000 })
      .toBe("exited");
    const generation = Number(agentIn(await state())?.generation);
    const respawned = await daemon.request(`/v1/agents/${agentId}/respawn`, {
      method: "POST",
      body: { idempotencyKey: "respawn", generation },
    });
    expect(respawned.status).toBe(200);
    await waitUntil(() => daemon.screen(agentId).includes("Claude Code"), "the resumed TUI");
    const { messageId } = await send("after-respawn", "Reply to confirm, after the respawn.");
    await expect
      .poll(async () => (await state()).messages.find((m) => m.id === messageId)?.state, {
        timeout: 30_000,
      })
      .toBe("delivered");
  });

  it("follows the agent to the session /clear starts, and its mail with it", async () => {
    const before = agentIn(await state())?.externalRef?.id;
    expect(before).toEqual(expect.any(String));
    await daemon.prompt({ agentId, terminalId }, "/clear");
    // The new session's SessionStart, from the pane's own process, moves the binding.
    await expect
      .poll(async () => agentIn(await state())?.externalRef?.id, { timeout: 20_000 })
      .not.toBe(before);
    const { messageId } = await send("after-clear", "Reply to confirm, after the clear.");
    await expect
      .poll(async () => (await state()).messages.find((m) => m.id === messageId)?.state, {
        timeout: 30_000,
      })
      .toBe("delivered");
  });

  it("takes a prompt the human types mid-turn for part of the turn, not an interrupt", async () => {
    const now = await state();
    const stream = await daemon.events({ epoch: now.epoch, eventId: now.eventId });
    const { messageId } = await send("typed-over", "[[fake:slow:6000]] Take your time.");
    await expect.poll(() => busy(), { timeout: 20_000 }).toBe(true);
    await daemon.prompt({ agentId, terminalId }, "Also say hi.");
    await expect
      .poll(async () => (await state()).messages.find((m) => m.id === messageId)?.state, {
        timeout: 30_000,
      })
      .toBe("delivered");
    const story = eventsAbout(stream, messageId);
    stream.close();
    expect(requeueReasons(story)).toEqual([]);
  });

  it("offers a message again when the human interrupts its turn, and delivers it after", async () => {
    const now = await state();
    const stream = await daemon.events({ epoch: now.epoch, eventId: now.eventId });
    const { messageId } = await send("interrupted", "[[fake:slow:6000]] Take your time.");
    // Mid-reply: the TUI offers to interrupt while the model's answer is held back.
    await expect.poll(() => busy(), { timeout: 20_000 }).toBe(true);
    const view = await daemon.view(String(terminalId), "interactive");
    await view.drive();
    view.type("\x1b");
    view.close();
    await daemon.prompt({ agentId, terminalId }, "Something else, please.");
    await expect
      .poll(async () => (await state()).messages.find((m) => m.id === messageId)?.state, {
        timeout: 60_000,
      })
      .toBe("delivered");
    const story = eventsAbout(stream, messageId);
    stream.close();
    expect(requeueReasons(story)).toEqual(["interrupted"]);
  });

  it("offers a message again after the turn carrying it fails, and gives up after four", async () => {
    const now = await state();
    const stream = await daemon.events({ epoch: now.epoch, eventId: now.eventId });
    const { messageId } = await send("fails", "[[fake:error]] This turn always fails.");
    // Each offer is woken and seen, and its turn ends in StopFailure, which requeues it.
    await expect
      .poll(async () => (await state()).messages.find((m) => m.id === messageId)?.state, {
        timeout: 90_000,
      })
      .toBe("undeliverable");
    const story = eventsAbout(stream, messageId);
    stream.close();
    expect(story.filter((e) => e.type === "mailbox.offered")).toHaveLength(4);
    expect(story.filter((e) => e.type === "mailbox.seen")).toHaveLength(4);
    expect(requeueReasons(story)).toEqual([
      "stop_failed",
      "stop_failed",
      "stop_failed",
      "stop_failed",
    ]);
    expect(model.requests.some((r) => r.includes(`possible re-delivery of ${messageId}`))).toBe(
      true,
    );
  });
});
