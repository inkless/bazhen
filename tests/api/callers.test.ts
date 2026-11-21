// Who the daemon takes a socket caller for, by what it presents and the process it runs in,
// with no agent to vouch for: the human, or a refusal. Both daemons pass it.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Daemon, overSocket, overSocketUnderCodex } from "./daemon.ts";

const DEAD_TOKEN = "u".repeat(43);
const NO_AGENT = "agent_0190a1b2c3d47abc8def0123456789ab";

function saying(said: string) {
  return { headers: { "bazhen-agent-id": said } };
}

function forbidden(message: string) {
  return { status: 403, body: { error: "forbidden", message } };
}

describe("a socket caller no agent vouches for", () => {
  let daemon: Daemon;
  beforeAll(async () => {
    daemon = await Daemon.start();
  });
  afterAll(async () => {
    await daemon?.stop();
  });

  it("is the human when it presents nothing, an empty agent id, or a Codex thread alone", async () => {
    for (const headers of [{}, { "bazhen-agent-id": "" }, { "bazhen-codex-thread": "t-1" }]) {
      expect(await overSocket(daemon.socket, "GET", "/v1/caller", { headers })).toEqual({
        status: 200,
        body: { agentId: null },
      });
    }
  });

  it("is refused on every route, stopping included, when its token is no live agent's", async () => {
    const headers = { "bazhen-agent-token": DEAD_TOKEN };
    const reason = "the agent token is no live agent's";
    for (const path of ["/v1/health", "/v1/state", "/v1/caller"]) {
      expect(await overSocket(daemon.socket, "GET", path, { headers })).toEqual(forbidden(reason));
    }
    expect(await overSocket(daemon.socket, "POST", "/v1/daemon/stop", { headers })).toEqual(
      forbidden(`an agent can't stop the daemon: ${reason}`),
    );
    expect((await overSocket(daemon.socket, "GET", "/v1/health")).status).toBe(200);
  });

  it("is refused when it names an agent without its token, or names no agent id", async () => {
    expect(await overSocket(daemon.socket, "GET", "/v1/caller", saying(NO_AGENT))).toEqual(
      forbidden(`agent ${NO_AGENT} must present its agent token`),
    );
    expect(await overSocket(daemon.socket, "GET", "/v1/caller", saying("agent_x"))).toEqual(
      forbidden("not an agent id: agent_x"),
    );
  });

  it("is refused under a Codex app-server when it names no thread", () => {
    expect(overSocketUnderCodex(daemon.socket, "/v1/caller")).toEqual(
      forbidden("a Codex tool call names no thread"),
    );
  });
});
