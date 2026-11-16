import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SendMessageResponse, StateSnapshot, type LaunchAgentResponse } from "@bazhen/protocol";
import { BANNER, Daemon, promptHolder, showsThread, waitUntil } from "./daemon.ts";
import { startFakeResponses } from "./fake-responses.ts";
import type { FakeModel } from "./fake-model.ts";

let model: FakeModel;
let daemon: Daemon;
let launched: LaunchAgentResponse;

const state = async () => StateSnapshot.parse((await daemon.request("/v1/state")).body);
const bound = async () =>
  (await state()).agents.find((a) => a.id === launched.agentId)?.externalRef?.id;

/** Whether the agent is bound to the thread its TUI's title names, and which that is. */
async function following() {
  const thread = String(await bound());
  return { thread, shown: showsThread(await daemon.title(launched.agentId), thread) };
}

beforeAll(async () => {
  model = await startFakeResponses();
  daemon = await Daemon.start({ responsesUrl: model.url });
  await daemon.kill();
  daemon.writeConfig('[runtime]\ndefault = "holder"\n');
  await daemon.restart();
  launched = await daemon.launch("codex-on-holder", "codex");
  await waitUntil(
    async () => (await daemon.shows(launched.agentId)).includes(BANNER.codex),
    "Codex's TUI on its holder",
    30_000,
  );
}, 120_000);
afterAll(async () => {
  await daemon?.stop();
  await model?.close();
});

describe("a Codex agent on a holder", () => {
  it("runs on a holder, its TUI titled with the thread Bazhen bound it to", async () => {
    expect(daemon.holderOf(launched.agentId)).toBeDefined();
    await expect.poll(async () => (await following()).shown, { timeout: 30_000 }).toBe(true);
  });

  it("follows its TUI to the new thread a /new starts, and takes mail there", async () => {
    const before = await bound();
    await daemon.prompt(launched, "/new");
    await expect
      .poll(async () => showsThread(await daemon.title(launched.agentId), String(before)), {
        timeout: 30_000,
      })
      .toBe(false);
    await daemon.prompt(launched, "hello from the new thread");
    await expect
      .poll(
        async () => {
          const now = await following();
          return { moved: now.thread !== before, shown: now.shown };
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
    await expect
      .poll(() => model.requests.some((r) => r.includes("mail for the new thread")), {
        timeout: 30_000,
      })
      .toBe(true);
  });

  it("moves to the thread its TUI went to while the daemon was down, once it is back", async () => {
    const before = await bound();
    await daemon.kill();
    const holder = daemon.holderOf(launched.agentId);
    expect(holder).toBeDefined();
    await promptHolder(String(holder), "/new");
    await promptHolder(String(holder), "hello while the daemon was down");
    await daemon.restart();
    await expect
      .poll(
        async () => {
          const now = await following();
          return { moved: now.thread !== before, shown: now.shown };
        },
        { timeout: 30_000 },
      )
      .toEqual({ moved: true, shown: true });
  });
});
