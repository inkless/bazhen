// Who the daemon takes a socket caller for when no agent vouches for it, as only the process it
// runs in tells: the human, or a refusal. Both daemons pass it.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Daemon, overSocket, overSocketUnderCodex } from "./daemon.ts";

describe("a socket caller no agent vouches for", () => {
  let daemon: Daemon;
  beforeAll(async () => {
    daemon = await Daemon.start();
  });
  afterAll(async () => {
    await daemon?.stop();
  });

  it("is answered as the human on /v1/caller, through an empty agent id or a Codex thread alone", async () => {
    for (const headers of [{}, { "bazhen-agent-id": "" }, { "bazhen-codex-thread": "t-1" }]) {
      expect(await overSocket(daemon.socket, "GET", "/v1/caller", { headers })).toEqual({
        status: 200,
        body: { agentId: null },
      });
    }
  });

  it("is refused under a Codex app-server when it names no thread, on a route the human may use", () => {
    expect(overSocketUnderCodex(daemon.socket, "/v1/health")).toEqual({
      status: 403,
      body: { error: "forbidden", message: "a Codex tool call names no thread" },
    });
  });
});
