import { describe, expect, it } from "vitest";
import { newId } from "@bazhen/core";
import { identify, type AgentCredentials } from "./callers.ts";

const tokened = newId("agent");
const other = newId("agent");
const TOKEN = "t".repeat(43);

/** Codex thread `tokened` is bound to. */
const THREAD = "01a1e0f0-593e-7ae1-9d31-769db26227fc";

/** `tokened` was given TOKEN and is bound to THREAD; `other` runs from before agents had tokens. */
const credentials: AgentCredentials = {
  agentOf: (token) => (token === TOKEN ? tokened : undefined),
  untokened: (agentId) => agentId === other,
  codexAgent: (thread) => (thread === THREAD ? tokened : undefined),
};

const who = (token: string | undefined, said: string | undefined) =>
  identify(credentials, { token, said });

describe("identify", () => {
  it("takes a caller with an agent's token as that agent, naming it or not", () => {
    expect([who(TOKEN, undefined), who(TOKEN, tokened)]).toEqual([
      { kind: "agent", agentId: tokened },
      { kind: "agent", agentId: tokened },
    ]);
  });

  it("refuses an agent's token beside another agent's id", () => {
    expect(who(TOKEN, other).kind).toBe("refused");
  });

  it("refuses a token that is no live agent's, whatever agent it names", () => {
    expect([who("u".repeat(43), undefined).kind, who("u".repeat(43), other).kind]).toEqual([
      "refused",
      "refused",
    ]);
  });

  it("refuses an id alone for an agent that was given a token", () => {
    expect(who(undefined, tokened)).toEqual({
      kind: "refused",
      reason: `agent ${tokened} must present its agent token`,
    });
  });

  it("takes an id alone as that agent's for one started before agents had tokens", () => {
    expect(who(undefined, other)).toEqual({ kind: "agent", agentId: other });
  });

  it("refuses an id alone that names no agent it knows", () => {
    expect(who(undefined, newId("agent")).kind).toBe("refused");
  });

  it("refuses an id alone that is no agent id", () => {
    expect([who(undefined, "%3").kind, who(undefined, "BZ-127").kind]).toEqual([
      "refused",
      "refused",
    ]);
  });

  it("takes a caller that presents neither token nor id as the human", () => {
    expect(who(undefined, undefined)).toEqual({ kind: "human" });
  });
});

/** What reading a caller's process says when it runs under `agentId`'s pane. */
const under = (agentId: typeof tokened) => ({ kind: "agent" as const, agentId });

/** Who a caller is that presents `token` and `said` from under `of`'s pane. */
const peer = (token: string | undefined, said: string | undefined, of: typeof tokened) =>
  identify(credentials, { token, said }, under(of));

describe("identify, with the caller's process read", () => {
  it("takes a caller under an agent's process as that agent, though it presents nothing", () => {
    expect(peer(undefined, undefined, tokened)).toEqual({ kind: "agent", agentId: tokened });
  });

  it("takes a caller under an agent's process with that agent's own token or id", () => {
    expect([peer(TOKEN, undefined, tokened).kind, peer(undefined, tokened, tokened).kind]).toEqual([
      "agent",
      "agent",
    ]);
  });

  it("refuses another agent's token or id from under an agent's process", () => {
    expect([peer(TOKEN, undefined, other).kind, peer(undefined, tokened, other).kind]).toEqual([
      "refused",
      "refused",
    ]);
  });

  it("refuses a Codex tool call, whatever it presents, and never takes it for the human", () => {
    const codex = { kind: "codex" as const };
    const presented = [
      { token: undefined, said: undefined },
      { token: TOKEN, said: undefined },
      { token: TOKEN, said: tokened },
      { token: undefined, said: other },
    ];
    expect(presented.map((p) => identify(credentials, p, codex).kind)).toEqual([
      "refused",
      "refused",
      "refused",
      "refused",
    ]);
  });

  it("takes a Codex tool call as the live agent bound to the thread it names, and only it", () => {
    const named = { token: undefined, said: undefined, thread: THREAD };
    expect([
      identify(credentials, named, { kind: "codex" }),
      identify(credentials, { token: TOKEN, said: tokened, thread: THREAD }, { kind: "codex" }),
      identify(credentials, named, { kind: "outside" }),
      identify(credentials, named, under(other)),
    ]).toEqual([
      { kind: "agent", agentId: tokened },
      { kind: "agent", agentId: tokened },
      { kind: "human" },
      { kind: "agent", agentId: other },
    ]);
  });

  it("refuses a Codex tool call unless its thread is a live agent's with nothing of another beside it", () => {
    const tokensOnly: AgentCredentials = {
      agentOf: (token) => credentials.agentOf(token),
      untokened: (agentId) => credentials.untokened(agentId),
    };
    const kinds = [
      [credentials, { token: undefined, said: undefined, thread: THREAD }],
      [credentials, { token: undefined, said: undefined, thread: "01a1e0f0-0000-7000-8000-0" }],
      [credentials, { token: undefined, said: other, thread: THREAD }],
      [credentials, { token: "u".repeat(43), said: undefined, thread: THREAD }],
      [credentials, { token: undefined, said: undefined, thread: "not a thread" }],
      [tokensOnly, { token: undefined, said: undefined, thread: THREAD }],
    ] as const;
    expect(kinds.map(([c, p]) => identify(c, p, { kind: "codex" }).kind)).toEqual([
      "agent",
      "refused",
      "refused",
      "refused",
      "refused",
      "refused",
    ]);
  });

  it("refuses a caller whose process the reading refused, whatever it presents", () => {
    const refusedReading = { kind: "refused" as const, reason: "no terminal" };
    expect(identify(credentials, { token: TOKEN, said: undefined }, refusedReading)).toEqual({
      kind: "refused",
      reason: "no terminal",
    });
  });
});
