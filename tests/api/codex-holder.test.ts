import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SendMessageResponse, StateSnapshot, type LaunchAgentResponse } from "@bazhen/protocol";
import { BANNER, Daemon, promptHolder, showsThread, waitUntil } from "./daemon.ts";
import { startFakeResponses } from "./fake-responses.ts";
import type { FakeModel } from "./fake-model.ts";

let model: FakeModel;
let daemon: Daemon;
let launched: LaunchAgentResponse;

/** A title naming a thread, as the TUI sets it: an id's first characters, perhaps cut with `...`. */
const THREAD_TITLE = /^[0-9a-f]{8}-[0-9a-f-]{20,27}(\.\.\.|…)?$/;

const state = async () => StateSnapshot.parse((await daemon.request("/v1/state")).body);

/**
 * Sends the agent `body` as mail and resolves, once the model has been asked with it, with the
 * request that carried it: Codex keys each request's prompt cache by its thread, so the request
 * names the thread the mail went to.
 */
async function mailed(key: string, body: string): Promise<string> {
  const sent = await daemon.request(`/v1/agents/${launched.agentId}/messages`, {
    method: "POST",
    body: { idempotencyKey: key, body },
  });
  SendMessageResponse.parse(sent.body);
  let carried: string | undefined;
  await waitUntil(
    () => (carried = model.requests.find((r) => r.includes(body))) !== undefined,
    `the model asked with ${body}`,
    30_000,
  );
  return String(carried);
}
const bound = async () =>
  (await state()).agents.find((a) => a.id === launched.agentId)?.externalRef?.id;

/** Whether the agent's TUI is titled with a thread, and one other than `threadId`. */
async function titledWithAnother(threadId: string) {
  const title = await daemon.title(launched.agentId);
  return THREAD_TITLE.test(title) && !showsThread(title, threadId);
}

/** Whether the agent is bound to the thread its TUI's title names, and which that is. */
async function following() {
  const thread = String(await bound());
  return { thread, shown: showsThread(await daemon.title(launched.agentId), thread) };
}

beforeAll(async () => {
  model = await startFakeResponses();
  daemon = await Daemon.start({ responsesUrl: model.url });
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
    const carried = await mailed("mail-after-new", "mail for the new thread");
    const now = String(await bound());
    expect([carried.includes(now), carried.includes(String(before))]).toEqual([true, false]);
  });

  // The new thread's first prompt waits until the daemon is back: a /new thread is listed only once
  // that prompt saves it, and its announcement went out while the daemon was down, so the daemon
  // starts on a title naming a thread it can't find yet, every run.
  it("is bound, once the daemon is back, to the thread its TUI went to while it was down, and holds mail till then", async () => {
    const before = String(await bound());
    await daemon.crash();
    const holder = daemon.holderOf(launched.agentId);
    expect(holder).toBeDefined();
    await promptHolder(String(holder), "/new");
    await waitUntil(() => titledWithAnother(before), "the TUI titled with a new thread", 30_000);
    await daemon.restart();
    const carrying = mailed("mail-after-restart", "mail sent as the daemon came back");
    // Awaited below; until then a failure must not count as unhandled.
    carrying.catch(() => {});
    await daemon.prompt(launched, "hello from the thread made while the daemon was down");
    await expect
      .poll(
        async () => {
          const now = await following();
          return { moved: now.thread !== before, shown: now.shown };
        },
        { timeout: 30_000 },
      )
      .toEqual({ moved: true, shown: true });
    const carried = await carrying;
    const now = String(await bound());
    expect([carried.includes(now), carried.includes(before)]).toEqual([true, false]);
  });
});
