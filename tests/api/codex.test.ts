import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { StateSnapshot, type LaunchAgentResponse } from "@bazhen/protocol";
import { BANNER, Daemon, waitUntil } from "./daemon.ts";
import { startFakeResponses } from "./fake-responses.ts";
import type { FakeModel } from "./fake-model.ts";

let model: FakeModel;
let daemon: Daemon;
let launched: LaunchAgentResponse;
beforeAll(async () => {
  model = await startFakeResponses();
  daemon = await Daemon.start({ responsesUrl: model.url });
  launched = await daemon.launch("codex", "codex");
});
afterAll(async () => {
  await daemon?.stop();
  await model?.close();
});

const state = async () => StateSnapshot.parse((await daemon.request("/v1/state")).body);

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
});
