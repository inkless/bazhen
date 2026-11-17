// Respawning a real Claude Code on its session. Claude Code writes a turn to its transcript just
// after the turn's Stop hook, and for a moment the file holds only metadata, which `--resume`
// can't load; each test waits for the turn on disk before it kills the TUI.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentCommandResponse, ErrorResponse, StateSnapshot } from "@bazhen/protocol";
import { Daemon, waitUntil } from "./daemon.ts";
import { startFakeModel, type FakeModel } from "./fake-model.ts";

let model: FakeModel;
let daemon: Daemon;
beforeAll(async () => {
  model = await startFakeModel();
  daemon = await Daemon.start({ modelUrl: model.url, claudeDebugLog: true });
});
afterAll(async () => {
  await daemon?.stop();
  await model?.close();
});

const agentOf = async (agentId: string) =>
  StateSnapshot.parse((await daemon.request("/v1/state")).body).agents.find(
    (a) => a.id === agentId,
  );
const respawn = (agentId: string, key: string, generation: number) =>
  daemon.request(`/v1/agents/${agentId}/respawn`, {
    method: "POST",
    body: { idempotencyKey: key, generation },
  });

/** A Claude Code agent that took one turn, which is on disk, then was killed from outside. */
async function killedAfterATurn(key: string, prompt: string) {
  const launched = await daemon.launch(key);
  await daemon.running(launched.agentId);
  await daemon.prompt(launched, prompt);
  await waitUntil(
    () => daemon.transcript(launched.agentId).includes('"type":"assistant"'),
    "the turn in its transcript",
    30_000,
  );
  await daemon.signalAgent(launched.agentId, "SIGKILL");
  await expect
    .poll(async () => (await agentOf(launched.agentId))?.state, { timeout: 10_000 })
    .toBe("exited");
  return launched;
}

describe("a Claude Code agent respawned on its session", () => {
  it("comes back on the same session, and its next turn sends the model the conversation before", () =>
    daemon.explained(async () => {
      const launched = await killedAfterATurn("resumed", "Remember the word kestrel.");
      // The daemon reads a transcript at most once per check window, so it can take a moment
      // after the file holds the turn to offer the respawn, as a client is shown it.
      await expect
        .poll(async () => (await agentOf(launched.agentId))?.commands, { timeout: 10_000 })
        .toContain("respawn");
      const session = (await agentOf(launched.agentId))?.externalRef;
      const res = await respawn(launched.agentId, "respawn", 0);
      expect(res.status).toBe(200);
      expect(AgentCommandResponse.parse(res.body).eventIds).toHaveLength(2);
      // Running only on a sign from the new TUI itself, which a TUI that can't resume never sends.
      await daemon.running(launched.agentId);
      expect(await agentOf(launched.agentId)).toMatchObject({
        generation: 1,
        externalRef: session,
      });
      const sent = model.requests.length;
      await daemon.prompt(launched, "Which bird?");
      await waitUntil(
        () => model.requests.slice(sent).some((r) => r.includes("Which bird?")),
        "the next turn's request",
        30_000,
      );
      expect(model.requests.slice(sent).filter((r) => r.includes("Which bird?"))).toContainEqual(
        expect.stringContaining("Remember the word kestrel."),
      );
    }));

  it("isn't offered, and is refused, while its transcript holds only what Claude Code writes ahead of a turn", () =>
    daemon.explained(async () => {
      const { agentId } = await killedAfterATurn("metadata-only", "Say ok.");
      const session = String((await agentOf(agentId))?.externalRef?.id);
      // The transcript as Claude Code 2.1.322 leaves it when killed a moment after a turn's Stop.
      daemon.rewriteTranscript(
        agentId,
        [
          { type: "mode", mode: "normal", sessionId: session },
          { type: "permission-mode", permissionMode: "default", sessionId: session },
          { type: "atis-latch", atis: "", sessionId: session },
        ]
          .map((entry) => `${JSON.stringify(entry)}\n`)
          .join(""),
      );
      await expect
        .poll(async () => (await agentOf(agentId))?.resumable, { timeout: 10_000 })
        .toBe(false);
      const offered = (await agentOf(agentId))?.commands;
      const refused = await respawn(agentId, "respawn-metadata-only", 0);
      const after = await agentOf(agentId);
      expect([
        offered?.includes("respawn"),
        refused.status,
        ErrorResponse.parse(refused.body).error,
        after?.state,
        after?.generation,
      ]).toEqual([false, 409, "not_resumable", "exited", 0]);
    }));
});
