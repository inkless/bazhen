import { describe, expect, it } from "vitest";
import { newId } from "@bazhen/core";
import { identify, presentedBy, type AgentCredentials } from "./callers.ts";

const tokened = newId("agent");
const other = newId("agent");
const coder = newId("agent");
const TOKEN = "t".repeat(43);

/** Codex thread `tokened` is bound to. */
const THREAD = "01a1e0f0-593e-7ae1-9d31-769db26227fc";
/** Codex thread `coder` is bound to. */
const CODER_THREAD = "01a1e0f0-0000-7ae1-9d31-769db26227fc";

/**
 * `tokened` was given TOKEN and is bound to THREAD; `other` runs from before agents had tokens;
 * `coder` is bound to CODER_THREAD.
 */
const credentials: AgentCredentials = {
  agentOf: (token) => (token === TOKEN ? tokened : undefined),
  untokened: (agentId) => agentId === other,
  codexAgent: (thread) =>
    thread === THREAD ? tokened : thread === CODER_THREAD ? coder : undefined,
};

/** A Codex tool call, by the app-server above it or by its own environment only. */
const underServer = { kind: "codex", via: "server" } as const;
const markedOnly = { kind: "codex", via: "environment" } as const;

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

  it("refuses a Codex tool call that names no thread, whatever it presents, and never takes it for the human", () => {
    const presented = [
      { token: undefined, said: undefined },
      { token: TOKEN, said: undefined },
      { token: TOKEN, said: tokened },
      { token: undefined, said: other },
    ];
    expect(
      [underServer, markedOnly].flatMap((r) =>
        presented.map((p) => identify(credentials, p, r).kind),
      ),
    ).toEqual(Array(8).fill("refused"));
  });

  it("takes a Codex tool call as the live agent bound to the thread it names, and only it", () => {
    const named = { token: undefined, said: undefined, thread: THREAD };
    expect([
      identify(credentials, named, underServer),
      identify(credentials, named, markedOnly),
      identify(credentials, { token: TOKEN, said: tokened, thread: THREAD }, underServer),
      identify(credentials, named, { kind: "outside" }),
      identify(credentials, named, under(other)),
    ]).toEqual([
      { kind: "agent", agentId: tokened },
      { kind: "agent", agentId: tokened },
      { kind: "agent", agentId: tokened },
      { kind: "human" },
      { kind: "agent", agentId: other },
    ]);
  });

  it("refuses a Codex tool call whose thread is no live agent's, or that names none", () => {
    const tokensOnly: AgentCredentials = {
      agentOf: (token) => credentials.agentOf(token),
      untokened: (agentId) => credentials.untokened(agentId),
    };
    const kinds = [
      [credentials, { token: undefined, said: undefined, thread: "01a1e0f0-0000-7000-8000-0" }],
      [credentials, { token: undefined, said: undefined, thread: "not a thread" }],
      [tokensOnly, { token: undefined, said: undefined, thread: THREAD }],
    ] as const;
    expect(
      [underServer, markedOnly].flatMap((r) => kinds.map(([c, p]) => identify(c, p, r).kind)),
    ).toEqual(Array(6).fill("refused"));
  });

  // The app-server's environment is whoever started it, which may be another agent's terminal:
  // every command on every thread then presents that agent's id and token.
  it("takes a call under the app-server as its thread's agent, whatever id or token the server's environment gave it", () => {
    const presented = [
      { token: TOKEN, said: tokened, thread: CODER_THREAD },
      { token: TOKEN, said: undefined, thread: CODER_THREAD },
      { token: undefined, said: other, thread: CODER_THREAD },
      { token: "u".repeat(43), said: tokened, thread: CODER_THREAD },
    ];
    expect(presented.map((p) => identify(credentials, p, underServer))).toEqual(
      presented.map(() => ({ kind: "agent", agentId: coder })),
    );
  });

  it("refuses a caller marked only by its environment beside another agent's token or id", () => {
    const presented = [
      { token: TOKEN, said: undefined, thread: CODER_THREAD },
      { token: undefined, said: tokened, thread: CODER_THREAD },
      { token: "u".repeat(43), said: undefined, thread: CODER_THREAD },
    ];
    expect(presented.map((p) => identify(credentials, p, markedOnly).kind)).toEqual(
      Array(3).fill("refused"),
    );
  });

  it("never takes a caller in an agent's terminal or outside every one for the thread it names", () => {
    const own = { token: TOKEN, said: undefined, thread: CODER_THREAD };
    expect([
      identify(credentials, own, under(tokened)),
      identify(credentials, own, under(other)).kind,
      identify(credentials, own, { kind: "outside" }),
      identify(credentials, own),
    ]).toEqual([
      { kind: "agent", agentId: tokened },
      "refused",
      { kind: "agent", agentId: tokened },
      { kind: "agent", agentId: tokened },
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

/** A request's headers, by name, as `presentedBy` reads them. */
const headers =
  (values: Record<string, string>) =>
  (name: string): string | undefined =>
    values[name];

describe("presentedBy", () => {
  it("reads the token, the agent id and the Codex thread from their headers", () => {
    expect(
      presentedBy(
        headers({
          "bazhen-agent-token": TOKEN,
          "bazhen-agent-id": tokened,
          "bazhen-codex-thread": THREAD,
        }),
      ),
    ).toEqual({ token: TOKEN, said: tokened, thread: THREAD });
  });

  // A Codex thread sets BAZHEN_AGENT_ID empty over the app-server's environment.
  it("reads an empty agent id as none, so a caller that sends one is as one that sends nothing", () => {
    const empty = presentedBy(headers({ "bazhen-agent-id": "" }));
    expect([
      empty.said,
      identify(credentials, empty),
      identify(credentials, empty, under(tokened)),
    ]).toEqual([undefined, { kind: "human" }, { kind: "agent", agentId: tokened }]);
  });
});
