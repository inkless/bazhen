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
  // The user's own status line, which Bazhen's must keep drawing.
  daemon.claudeSettings({
    statusLine: { type: "command", command: "printf 'user line: '; cat >/dev/null; printf ok" },
  });
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

/** A model request that continues a turn after a tool ran. */
const withToolResult = (request: string) => request.includes("tool_result");
/**
 * Sends Esc to a turn still in progress, and says whether it still is: polled, a keystroke a
 * slow runner lost is sent again, and none once the turn stops, since Esc at the prompt opens a
 * menu.
 */
const interrupt = (view: { type(text: string): void }) => {
  const still = busy();
  if (still) view.type("\x1b");
  return still;
};
/** The model the agent runs and its context use, as its status line reported them. */
const usage = async () => agentIn(await state())?.usage;
/** What the agent's harness last said it is doing. */
const doing = async () => agentIn(await state())?.activity?.value;
/**
 * Whether the agent's TUI is in the middle of a turn: its spinner, a glyph then a verb that ends
 * in "…" (a finished turn's line, "✻ Worked for 3s", has none). With a status line set, as
 * Bazhen always sets one, the TUI shows no "esc to interrupt" hint.
 */
const busy = () => /^\s*[·✢✳✶✻✽*] \S[^\n]*…/m.test(daemon.screen(agentId));
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
  it("keeps drawing the user's own status line, and learns the model and context use from it", async () => {
    await expect.poll(() => daemon.screen(agentId), { timeout: 20_000 }).toContain("user line: ok");
    await expect
      .poll(async () => (await usage())?.model, { timeout: 20_000 })
      .toEqual(expect.any(String));
    expect(await usage()).toMatchObject({ contextWindowTokens: expect.any(Number) });
  });

  it("reports what the agent is doing: idle once started, working through a turn, idle after", async () => {
    // A fresh agent's SessionStart says it waits for its first prompt.
    await expect.poll(doing, { timeout: 20_000 }).toBe("idle");
    const { messageId } = await send("activity", "[[fake:slow:4000]] Take a moment.");
    await expect.poll(doing, { timeout: 20_000 }).toBe("working");
    await expect.poll(() => busy(), { timeout: 20_000 }).toBe(true);
    expect(await doing()).toBe("working");
    await expect
      .poll(async () => (await state()).messages.find((m) => m.id === messageId)?.state, {
        timeout: 30_000,
      })
      .toBe("delivered");
    await expect.poll(doing, { timeout: 10_000 }).toBe("idle");
    expect(agentIn(await state())?.activity?.source).toBe("native");
  });

  it("reports an agent asking to run a tool as needing approval, until it is answered", async () => {
    const { messageId } = await send("activity-tool", "[[fake:bash:touch activity-tool]]");
    await expect.poll(() => openItemFor("touch activity-tool"), { timeout: 30_000 }).toBeDefined();
    expect(await doing()).toBe("needs_approval");
    await daemon.request(
      `/v1/attention/${String(await openItemFor("touch activity-tool"))}/answer`,
      {
        method: "POST",
        body: { idempotencyKey: "activity-allow", decision: "allow" },
      },
    );
    await expect
      .poll(async () => (await state()).messages.find((m) => m.id === messageId)?.state, {
        timeout: 30_000,
      })
      .toBe("delivered");
    await expect.poll(doing, { timeout: 10_000 }).toBe("idle");
  });

  it("keeps an agent working while a background subagent outlives the turn that started it", async () => {
    const { messageId } = await send("subagent", "[[fake:agent]] Start a helper.");
    // The main turn launches the subagent and stops at once; the subagent answers 8 s later.
    await expect
      .poll(async () => (await state()).messages.find((m) => m.id === messageId)?.state, {
        timeout: 30_000,
      })
      .toBe("delivered");
    await expect.poll(doing, { timeout: 10_000 }).toBe("working");
    expect(agentIn(await state())?.activity?.detail).toBe("subagent running");
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect(await doing()).toBe("working");
    // Its result starts one more main turn; when that stops, nothing is left running.
    await expect.poll(doing, { timeout: 30_000 }).toBe("idle");
    expect(model.requests.some((r) => r.includes("A background task."))).toBe(true);
  });

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
    const { messageId } = await send("tool", "[[fake:bash:touch approved-by-inbox]]");
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
    // Its turn ends before the next test's mail, which would otherwise be folded into it.
    await expect
      .poll(async () => (await state()).messages.find((m) => m.id === messageId)?.state, {
        timeout: 30_000,
      })
      .toBe("delivered");
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
    // The resumed TUI replays the conversation, which can push its banner off the screen; its
    // SessionStart says it is up, and a respawn's first signal is its own.
    await expect.poll(doing, { timeout: 30_000 }).toBe("idle");
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
    const { messageId } = await send("interrupted", "[[fake:slow:15000]] Take your time.");
    // Mid-reply: the TUI offers to interrupt while the model's answer is held back.
    await expect.poll(() => busy(), { timeout: 20_000 }).toBe(true);
    const view = await daemon.view(String(terminalId), "interactive");
    await view.drive();
    await expect.poll(() => interrupt(view), { timeout: 10_000, interval: 1_000 }).toBe(false);
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

  it("folds mail sent during a turn into it at the next tool call, and delivers it with the turn", async () => {
    const now = await state();
    const stream = await daemon.events({ epoch: now.epoch, eventId: now.eventId });
    const first = await send("fold-tool", "[[fake:bash:touch fold-tool-ran]]");
    // The wake took the waiter; the turn now waits for the inbox to allow its tool call.
    await expect.poll(() => openItemFor("touch fold-tool-ran"), { timeout: 30_000 }).toBeDefined();
    const folded = await send("folded", "A message for the running turn.");
    const id = String(await openItemFor("touch fold-tool-ran"));
    await daemon.request(`/v1/attention/${id}/answer`, {
      method: "POST",
      body: { idempotencyKey: "fold-allow", decision: "allow" },
    });
    for (const { messageId } of [first, folded]) {
      await expect
        .poll(async () => (await state()).messages.find((m) => m.id === messageId)?.state, {
          timeout: 30_000,
        })
        .toBe("delivered");
    }
    const story = eventsAbout(stream, folded.messageId);
    stream.close();
    // Folded, not woken: no prompt carried it, so it was never `seen`.
    expect(story.map((e) => e.type)).toEqual([
      "mailbox.queued",
      "mailbox.offered",
      "mailbox.emitted",
      "mailbox.delivered",
    ]);
    // The model read it beside the tool's result, in the same turn.
    expect(model.requests.filter(withToolResult).join()).toContain(
      "A message for the running turn.",
    );
  });

  it("leaves mail too long to fold for a wake, which hands it over whole", async () => {
    const now = await state();
    const stream = await daemon.events({ epoch: now.epoch, eventId: now.eventId });
    const first = await send("long-tool", "[[fake:bash:touch long-tool-ran]]");
    await expect.poll(() => openItemFor("touch long-tool-ran"), { timeout: 30_000 }).toBeDefined();
    // Claude Code cuts a fold's text at about 10,000 characters; a wake's arrives whole.
    const long = await send("long", `${"z".repeat(12_000)} END-OF-LONG`);
    const id = String(await openItemFor("touch long-tool-ran"));
    await daemon.request(`/v1/attention/${id}/answer`, {
      method: "POST",
      body: { idempotencyKey: "long-allow", decision: "allow" },
    });
    for (const { messageId } of [first, long]) {
      await expect
        .poll(async () => (await state()).messages.find((m) => m.id === messageId)?.state, {
          timeout: 30_000,
        })
        .toBe("delivered");
    }
    const story = eventsAbout(stream, long.messageId);
    stream.close();
    expect(story.map((e) => e.type)).toContain("mailbox.seen");
    expect(model.requests.join()).toContain(`${"z".repeat(12_000)} END-OF-LONG`);
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
