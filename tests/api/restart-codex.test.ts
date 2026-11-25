import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { StateSnapshot, type LaunchAgentResponse } from "@bazhen/protocol/web";
import { BANNER, Daemon, showsThread, waitUntil } from "./daemon.ts";
import { type FakeModel } from "./fake-model.ts";
import { startFakeResponses } from "./fake-responses.ts";

let responses: FakeModel;
let daemon: Daemon;
let codex: LaunchAgentResponse;
let codexThread = "";

const state = async () => StateSnapshot.parse((await daemon.request("/v1/state")).body);
const launch = async (key: string, harness: "codex") => {
  const launched = await daemon.launch(key, harness);
  await waitUntil(
    async () => (await daemon.screen(launched.agentId)).includes(BANNER[harness]),
    BANNER[harness],
    30_000,
  );
  return launched;
};

beforeAll(async () => {
  responses = await startFakeResponses();
  daemon = await Daemon.start({ responsesUrl: responses.url });
  codex = await launch("codex", "codex");
  codexThread = String((await state()).agents.find((a) => a.id === codex.agentId)?.externalRef?.id);
  await daemon.crash();
  await daemon.restart();
});
afterAll(async () => {
  await daemon?.stop();
  await responses?.close();
});

describe("a Codex agent after the daemon is killed with -9 and started again", () => {
  it("still runs the Codex agent, whose TUI takes turns on the same thread", async () => {
    await daemon.running(codex.agentId);
    expect((await state()).agents.find((a) => a.id === codex.agentId)).toMatchObject({
      state: "running",
      externalRef: { kind: "codex-thread" },
    });
    await daemon.prompt(codex, "still there, codex?");
    await expect
      .poll(() => daemon.screen(codex.agentId), { timeout: 30_000 })
      .toContain("echo: still there, codex?");
    // The TUI titles its terminal with the thread it shows, so the turn was on the one from before.
    await expect
      .poll(
        async () => ({
          bound: (await state()).agents.find((a) => a.id === codex.agentId)?.externalRef?.id,
          shown: showsThread(await daemon.title(codex.agentId), codexThread),
        }),
        { timeout: 30_000 },
      )
      .toEqual({ bound: codexThread, shown: true });
  });

  it("launches a new Codex agent through a new connection to the app-server", async () => {
    const again = await launch("codex-after-restart", "codex");
    await daemon.running(again.agentId);
    expect((await state()).agents.find((a) => a.id === again.agentId)?.externalRef).toMatchObject({
      kind: "codex-thread",
    });
  });
});
