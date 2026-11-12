import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SendMessageResponse, StateSnapshot, type LaunchAgentResponse } from "@bazhen/protocol";
import { BANNER, Daemon, waitUntil } from "./daemon.ts";
import { startFakeResponses } from "./fake-responses.ts";
import type { FakeModel } from "./fake-model.ts";

let model: FakeModel;
let daemon: Daemon;
let launched: LaunchAgentResponse;
/** An agent of its own for the approval tests, so their interrupted turns touch no other test. */
let asker: LaunchAgentResponse;
beforeAll(async () => {
  model = await startFakeResponses();
  daemon = await Daemon.start({ responsesUrl: model.url });
  [launched, asker] = await Promise.all([
    daemon.launch("codex", "codex"),
    daemon.launch("codex-asker", "codex"),
  ]);
  await waitUntil(() => daemon.screen(asker.agentId).includes(BANNER.codex), "Codex's TUI", 30_000);
});
afterAll(async () => {
  await daemon?.stop();
  await model?.close();
});

/**
 * Whether a pane title names `threadId`. Codex cuts a long title short with an ellipsis, so the
 * title is a long enough prefix of it: thread ids are UUIDv7, and a thread started later differs
 * well within 20 characters.
 */
const showsThread = (title: string, threadId: string) => {
  const shown = title.replace(/(\.\.\.|…)$/, "");
  return shown.length >= 20 && threadId.startsWith(shown);
};

const state = async () => StateSnapshot.parse((await daemon.request("/v1/state")).body);
/** The id of the open item whose summary names this command, once there is one. */
async function openItemFor(command: string): Promise<string> {
  let id: string | undefined;
  const find = async () => {
    id = (await state()).attention.find(
      (a) => a.state === "open" && a.summary.includes(command),
    )?.id;
    return id !== undefined;
  };
  await waitUntil(find, `an item for ${command}`, 30_000);
  return String(id);
}
const closeReasonOf = async (id: string) =>
  (await state()).attention.find((a) => a.id === id)?.closeReason;

describe("a Codex agent", () => {
  it("is bound to the thread Bazhen started for it, before its TUI runs", async () => {
    expect((await state()).agents.find((a) => a.id === launched.agentId)).toMatchObject({
      harness: "codex",
      state: "running",
      externalRef: { kind: "codex-thread", id: expect.any(String) },
    });
  });

  it("runs its TUI in its terminal, which takes a turn through the fake model", async () => {
    await waitUntil(
      () => daemon.screen(launched.agentId).includes(BANNER.codex),
      "Codex's TUI",
      30_000,
    );
    await daemon.prompt(launched, "hello from bazhen");
    await expect
      .poll(() => daemon.screen(launched.agentId), { timeout: 30_000 })
      .toContain("echo: hello from bazhen");
  });

  it("delivers mail to the agent through Codex's own queue, labelled with its id", async () => {
    const sent = await daemon.request(`/v1/agents/${launched.agentId}/messages`, {
      method: "POST",
      body: { idempotencyKey: "mail", body: "a message for codex" },
    });
    const { messageId } = SendMessageResponse.parse(sent.body);
    await expect
      .poll(async () => (await state()).messages.find((m) => m.id === messageId)?.state, {
        timeout: 30_000,
      })
      .toBe("delivered");
    await expect
      .poll(() => String(model.requests.find((r) => r.includes(messageId))), { timeout: 30_000 })
      .toContain("a message for codex");
  });

  it("asks the inbox before running a command outside the sandbox, and runs it once allowed", async () => {
    await daemon.prompt(asker, "[[fake:shell:touch approved-by-inbox]]");
    const id = await openItemFor("approved-by-inbox");
    const answered = await daemon.request(`/v1/attention/${id}/answer`, {
      method: "POST",
      body: { idempotencyKey: "allow", decision: "allow" },
    });
    expect(answered.status).toBe(200);
    await expect.poll(() => daemon.hasFile("approved-by-inbox"), { timeout: 30_000 }).toBe(true);
    expect(await closeReasonOf(id)).toBe("answered");
  });

  it("closes the item when the request is answered in the TUI instead", async () => {
    await daemon.prompt(asker, "[[fake:shell:touch approved-in-tui]]");
    const id = await openItemFor("approved-in-tui");
    // The TUI shows its own prompt a moment after the request reaches the inbox.
    await expect.poll(() => daemon.screen(asker.agentId)).toContain("Yes, proceed");
    const view = await daemon.view(String(asker.terminalId), "interactive");
    await view.drive();
    view.type("y");
    await expect.poll(() => daemon.hasFile("approved-in-tui"), { timeout: 30_000 }).toBe(true);
    await expect.poll(() => closeReasonOf(id)).toBe("answered_in_tui");
    view.close();
  });

  it("closes the item when the turn that asked is interrupted", async () => {
    await daemon.prompt(asker, "[[fake:shell:touch never-run]]");
    const id = await openItemFor("never-run");
    await expect.poll(() => daemon.screen(asker.agentId)).toContain("Yes, proceed");
    const view = await daemon.view(String(asker.terminalId), "interactive");
    await view.drive();
    // Ctrl-C, as a person stops the agent mid-turn.
    view.type("\u0003");
    await expect.poll(() => closeReasonOf(id), { timeout: 20_000 }).toBe("answered_in_tui");
    expect(daemon.hasFile("never-run")).toBe(false);
    view.close();
  });

  it("resumes the agent's thread itself after a kill -9, with no TUI to do it", async () => {
    const threadId = String(
      (await state()).agents.find((a) => a.id === launched.agentId)?.externalRef?.id,
    );
    // With nothing but Bazhen to subscribe, a restarted Codex has the thread loaded only if
    // Bazhen resumed it.
    daemon.runInTerminal(launched.agentId, ["sleep", "600"]);
    await daemon.kill();
    // A stop and a start, not a restart: a restarted server reloads its threads by itself.
    await daemon.codex("app-server", "daemon", "stop");
    await daemon.codex("app-server", "daemon", "start");
    await daemon.restart();
    await expect
      .poll(async () => JSON.stringify(await daemon.codexRequest("thread/loaded/list", {})), {
        timeout: 30_000,
      })
      .toContain(threadId);
  });

  it("respawns on the agent's own thread, with the TUI back on screen", async () => {
    const agent = async () => (await state()).agents.find((a) => a.id === launched.agentId);
    const thread = (await agent())?.externalRef;
    await daemon.signalAgent(launched.agentId, "SIGKILL");
    await expect.poll(async () => (await agent())?.state, { timeout: 10_000 }).toBe("exited");
    const respawned = await daemon.request(`/v1/agents/${launched.agentId}/respawn`, {
      method: "POST",
      body: { idempotencyKey: "respawn", generation: Number((await agent())?.generation) },
    });
    expect(respawned.status).toBe(200);
    await waitUntil(
      () => daemon.screen(launched.agentId).includes(BANNER.codex),
      "Codex's TUI after the respawn",
      30_000,
    );
    expect(await agent()).toMatchObject({ state: "running", generation: 1, externalRef: thread });
    // The TUI titles its pane with the thread it shows: the same thread, not a new one.
    await expect
      .poll(() => showsThread(daemon.paneTitle(launched.agentId), String(thread?.id)), {
        timeout: 30_000,
      })
      .toBe(true);
  });
});
