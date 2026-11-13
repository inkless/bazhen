import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LaunchAgentResponse, SendMessageResponse, StateSnapshot } from "@bazhen/protocol";
import { BANNER, Daemon, waitUntil } from "./daemon.ts";
import { startFakeResponses } from "./fake-responses.ts";
import type { FakeModel } from "./fake-model.ts";

/** The 256-colour background Codex 0.166 draws its prompt on, told a light terminal. */
const LIGHT_TINT = "\x1b[48;5;255m";

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

/** Each user input item a model request carries, as its JSON text. */
function userInputs(request: string): string[] {
  const parsed: unknown = JSON.parse(request);
  const input = typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "input") : [];
  return (Array.isArray(input) ? input : [])
    .filter(
      (item) => typeof item === "object" && item !== null && Reflect.get(item, "role") === "user",
    )
    .map((item) => JSON.stringify(item));
}

const inputs = () => model.requests.flatMap(userInputs);

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

/** The agent's latest activity, or the error that kept the daemon from answering within 2 s. */
async function activityOf(agentId: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("no answer from /v1/state in 2 s")), 2000);
  });
  try {
    const snapshot = await Promise.race([state(), late]);
    return { value: snapshot.agents.find((a) => a.id === agentId)?.activity?.value };
  } catch (err) {
    return { error: String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Waits 20 s for the model to be asked for `text`, a prompt just submitted. If it isn't, the
 * failure says what had happened by then: when the daemon first saw the agent working, if it did,
 * how many requests the model had in all and on the agent's thread, and the end of the screen.
 * This tells a turn that never started from one whose model call came late.
 */
async function untilAsked(agent: LaunchAgentResponse, text: string) {
  const start = Date.now();
  const thread = (await state()).agents.find((a) => a.id === agent.agentId)?.externalRef?.id;
  let workingAfterMs: number | null = null;
  const stateErrors: string[] = [];
  const asked = () => model.requests.some((r) => r.includes(text));
  while (!asked() && Date.now() - start < 20_000) {
    const activity = await activityOf(agent.agentId);
    if (activity.error !== undefined) stateErrors.push(activity.error);
    if (workingAfterMs === null && activity.value === "working")
      workingAfterMs = Date.now() - start;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const seen = asked()
    ? { asked: true }
    : {
        asked: false,
        workingAfterMs,
        stateErrors: stateErrors.slice(-3),
        modelRequests: {
          all: model.requests.length,
          // Codex keys each request's prompt cache by its thread.
          onItsThread: model.requests.filter((r) => thread !== undefined && r.includes(thread))
            .length,
        },
        screen: daemon
          .screen(agent.agentId)
          .split("\n")
          .filter((line) => line.trim() !== "")
          .slice(-12),
      };
  expect(seen).toEqual({ asked: true });
}

describe("a Codex agent", () => {
  it("starts in the theme its launch names, told the terminal's background from its first query", async () => {
    const res = await daemon.request("/v1/agents", {
      method: "POST",
      body: { idempotencyKey: "codex-light", harness: "codex", cwd: daemon.work, theme: "light" },
    });
    const light = LaunchAgentResponse.parse(res.body);
    await waitUntil(
      () => daemon.screen(light.agentId).includes(BANNER.codex),
      "Codex's TUI",
      30_000,
    );
    expect(daemon.agentCommand(light.agentId)).toContain('tui.theme="one-half-light"');
    expect((await state()).agents.find((a) => a.id === light.agentId)?.theme).toBe("light");
    // Codex tints its prompt from the background it was told: a light grey on light. Told nothing,
    // as the agents launched without a theme are, it draws no tint at all.
    await expect.poll(() => daemon.capture(light.agentId, 0, true)).toContain(LIGHT_TINT);
    expect(daemon.capture(asker.agentId, 0, true)).not.toContain("\x1b[48;5;");
  });

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

  it("delivers each of two messages that wait for the same turn boundary", async () => {
    await daemon.prompt(asker, "[[fake:slow:8000]] keep busy");
    // The turn is under way once the model has been asked; its reply is held back.
    await untilAsked(asker, "keep busy");
    const send = async (key: string, body: string) =>
      SendMessageResponse.parse(
        (
          await daemon.request(`/v1/agents/${asker.agentId}/messages`, {
            method: "POST",
            body: { idempotencyKey: key, body },
          })
        ).body,
      ).messageId;
    const ids = [await send("first", "first of two"), await send("second", "second of two")];
    const states = async () =>
      (await state()).messages.filter((m) => ids.includes(m.id)).map((m) => m.state);
    await expect.poll(states, { timeout: 60_000 }).toEqual(["delivered", "delivered"]);
    // Codex 0.166 hands each queued message over as an input item of its own, never two in one.
    await expect
      .poll(() => ids.map((id) => inputs().some((item) => item.includes(id))), { timeout: 30_000 })
      .toEqual([true, true]);
    expect(inputs().filter((item) => ids.every((id) => item.includes(id)))).toEqual([]);
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

  it("follows its TUI to the new thread a /new starts, and takes mail there", async () => {
    const bound = async () =>
      (await state()).agents.find((a) => a.id === launched.agentId)?.externalRef?.id;
    const before = await bound();
    await daemon.prompt(launched, "/new");
    // The new session is up once the TUI titles its pane with another thread.
    await expect
      .poll(() => showsThread(daemon.paneTitle(launched.agentId), String(before)), {
        timeout: 30_000,
      })
      .toBe(false);
    await daemon.prompt(launched, "hello from the new thread");
    // The pane's title names the thread the TUI shows; the agent is bound to that one now.
    await expect
      .poll(
        async () => {
          const now = await bound();
          return {
            moved: now !== before,
            shown: showsThread(daemon.paneTitle(launched.agentId), String(now)),
          };
        },
        { timeout: 30_000 },
      )
      .toEqual({ moved: true, shown: true });
    const sent = await daemon.request(`/v1/agents/${launched.agentId}/messages`, {
      method: "POST",
      body: { idempotencyKey: "mail-after-new", body: "mail for the new thread" },
    });
    const { messageId } = SendMessageResponse.parse(sent.body);
    await expect
      .poll(async () => (await state()).messages.find((m) => m.id === messageId)?.state, {
        timeout: 30_000,
      })
      .toBe("delivered");
  });
});
