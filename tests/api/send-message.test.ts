import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SendMessageResponse, StateSnapshot, type LaunchAgentResponse } from "@bazhen/protocol";
import { Daemon, waitUntil } from "./daemon.ts";
import { startFakeModel, type FakeModel } from "./fake-model.ts";

let model: FakeModel;
let daemon: Daemon;
let sender: LaunchAgentResponse;
let peer: LaunchAgentResponse;
beforeAll(async () => {
  model = await startFakeModel();
  daemon = await Daemon.start({ modelUrl: model.url });
  sender = await daemon.launch("sender");
  peer = await daemon.launch("peer");
  for (const { agentId } of [sender, peer])
    await waitUntil(
      async () => (await daemon.screen(agentId)).includes("Claude Code"),
      "Claude Code's TUI",
    );
});
afterAll(async () => {
  await daemon?.stop();
  await model?.close();
});

const state = async () => StateSnapshot.parse((await daemon.request("/v1/state")).body);
const nameOf = async (agentId: string) =>
  String((await state()).agents.find((a) => a.id === agentId)?.name);
const mail = async (key: string, body: string) =>
  SendMessageResponse.parse(
    (
      await daemon.request(`/v1/agents/${sender.agentId}/messages`, {
        method: "POST",
        body: { idempotencyKey: key, body },
      })
    ).body,
  );
const delivered = async (messageId: string) =>
  (await state()).messages.find((m) => m.id === messageId)?.state === "delivered";
const openFor = async (command: string) =>
  (await state()).attention.filter((a) => a.state === "open" && a.summary.includes(command));
/** Whether the turn carrying `messageId` has ended, or stopped to ask before running `command`. */
const endedOrAsked = async (messageId: string, command: string) =>
  (await delivered(messageId)) || (await openFor(command)).length > 0;

describe("Claude Code's own SendMessage between Bazhen agents", () => {
  it("is recorded from the sender's hook as sent to the agent its name reaches", async () => {
    const to = await nameOf(peer.agentId);
    const { messageId } = await mail("send", `[[fake:send:${to}:Rebased and green.]]`);
    await expect
      .poll(async () => (await state()).observed, { timeout: 30_000 })
      .toEqual([
        expect.objectContaining({
          from: sender.agentId,
          to: peer.agentId,
          summary: "A test message",
          accepted: true,
        }),
      ]);
    await expect.poll(() => delivered(messageId), { timeout: 30_000 }).toBe(true);
  });
});

/** Whether `command` asked before it ran; the ask is denied, and the turn left to end. */
async function asks(key: string, command: string, shownAs: string): Promise<boolean> {
  const { messageId } = await mail(key, `[[fake:bash:${command}]]`);
  const opened = await expect
    .poll(async () => (await openFor(shownAs)).length, { timeout: 30_000 })
    .toBe(1)
    .then(
      () => true,
      () => false,
    );
  for (const item of await openFor(shownAs))
    await daemon.request(`/v1/attention/${item.id}/answer`, {
      method: "POST",
      body: { idempotencyKey: `deny-${key}`, decision: "deny" },
    });
  await expect.poll(() => delivered(messageId), { timeout: 60_000 }).toBe(true);
  return opened;
}

describe("the bazhen verbs a Claude Code agent is taught", () => {
  it("run without asking, while the daemon's other commands still ask", async () => {
    const { messageId } = await mail("whoami", "[[fake:bash:bazhen agents whoami]]");
    // The turn ends, or stops at an ask, which is the one thing the verb must not do.
    await expect
      .poll(() => endedOrAsked(messageId, "bazhen agents whoami"), { timeout: 30_000 })
      .toBe(true);
    const name = await nameOf(sender.agentId);
    const ran = model.requests.filter((r) => r.includes("tool_result")).at(-1);
    expect([(await openFor("bazhen agents whoami")).length, ran]).toEqual([
      0,
      expect.stringContaining(`${name}  ${sender.agentId}`),
    ]);

    expect(await asks("status", "bazhen status", "bazhen status")).toBe(true);
  });

  it("still ask to read a file, to run another command with one, or to run a substitution", async () => {
    const to = await nameOf(peer.agentId);
    expect([
      await asks("file", `bazhen agents send ${to} --file notes.txt`, "--file notes.txt"),
      await asks("brief", "bazhen tasks create --title t --brief-file brief.md", "brief.md"),
      await asks("compound", "bazhen agents whoami && touch compound-x", "touch compound-x"),
      await asks("substitution", `bazhen agents send ${to} "$(cat secret-x)"`, "cat secret-x"),
    ]).toEqual([true, true, true, true]);
  });
});

describe("an agent that unsets its environment", () => {
  it(
    "is known as that agent while it calls from inside its own process tree, so it can't pair a browser",
    {
      timeout: 120_000,
    },
    async () => {
      // `devices pair` finds the daemon by its home, which agents aren't given; this test's daemon isn't
      // at the default one.
      const command = `env -u BAZHEN_AGENT_ID -u BAZHEN_AGENT_AUTH_FILE BAZHEN_HOME=${daemon.home} bazhen devices pair > unset-pair.txt 2>&1`;
      await mail("unset", `[[fake:bash:${command}]]`);
      await expect.poll(async () => (await openFor(command)).length, { timeout: 30_000 }).toBe(1);
      for (const item of await openFor(command))
        await daemon.request(`/v1/attention/${item.id}/answer`, {
          method: "POST",
          body: { idempotencyKey: "allow-unset", decision: "allow" },
        });
      await expect
        .poll(() => String(daemon.workFile("unset-pair.txt")), { timeout: 60_000 })
        .toContain("an agent can't pair a device");
    },
  );
});
