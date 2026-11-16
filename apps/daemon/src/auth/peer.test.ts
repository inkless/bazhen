import { describe, expect, it } from "vitest";
import { newId } from "@bazhen/core";
import { parsePeer, readingOf, type TerminalPids } from "./peer.ts";

const agent = newId("agent");
const other = newId("agent");

/** `agent`'s pane runs pid 100 and `other`'s 200, a shell's 300, on a tmux server of pid 10. */
const terminals: TerminalPids = {
  agents: new Map([
    [100, agent],
    [200, other],
  ]),
  shells: new Set([300]),
  runtimes: new Set([10]),
};

const chain = (pid: number, session: number, ...ancestors: number[]) => ({
  pid,
  session,
  codexServer: undefined as number | undefined,
  ancestors,
});

/** `line` with a Codex app-server at `server`, as `bazhen-peer` marks one. */
const via = (server: number, line: ReturnType<typeof chain>) => ({ ...line, codexServer: server });

describe("parsePeer", () => {
  it("reads the pid, the session and each ancestor bazhen-peer prints", () => {
    expect(parsePeer("50 40 0 40 1\n")).toEqual(chain(50, 40, 40, 1));
  });

  it("reads the Codex app-server bazhen-peer names before the ancestors", () => {
    expect(parsePeer("50 50 40 40 1\n")).toEqual(via(40, chain(50, 50, 40, 1)));
  });

  it("reads nothing from a line that isn't one", () => {
    expect(
      ["", "50", "50 40", "50 x 0 1", "-5 1 0", "50 40 0 1 x"].map((line) => parsePeer(line)),
    ).toEqual([undefined, undefined, undefined, undefined, undefined, undefined]);
  });
});

describe("readingOf", () => {
  it("names the agent whose pane process is the caller or its nearest such ancestor", () => {
    expect([
      readingOf(chain(100, 100, 10, 1), terminals),
      readingOf(chain(150, 150, 140, 100, 10, 1), terminals),
    ]).toEqual([
      { kind: "agent", agentId: agent },
      { kind: "agent", agentId: agent },
    ]);
  });

  it("names the agent whose pane leads the session of a caller orphaned away from it", () => {
    expect(readingOf(chain(150, 100, 1), terminals)).toEqual({ kind: "agent", agentId: agent });
  });

  it("names nobody for a caller in a shell's terminal or outside every terminal", () => {
    expect([
      readingOf(chain(350, 300, 300, 10, 1), terminals),
      readingOf(chain(950, 900, 900, 1), terminals),
    ]).toEqual([{ kind: "outside" }, { kind: "outside" }]);
  });

  it("reads a caller under a Codex app-server as a Codex tool call, never as outside", () => {
    expect([
      readingOf(via(900, chain(950, 950, 900, 1)), terminals),
      readingOf(via(900, chain(900, 900, 1)), terminals),
      readingOf(via(900, chain(950, 950, 900, 300, 10, 1)), terminals),
      readingOf(via(900, chain(950, 950, 900, 15, 10, 1)), terminals),
      readingOf(via(900, chain(950, 100, 900, 1)), terminals),
    ]).toEqual([
      { kind: "codex" },
      { kind: "codex" },
      { kind: "codex" },
      { kind: "codex" },
      { kind: "codex" },
    ]);
  });

  it("reads whichever is nearer the caller, a Codex app-server or an agent's process", () => {
    expect([
      readingOf(via(900, chain(950, 950, 900, 100, 10, 1)), terminals),
      readingOf(via(900, chain(150, 150, 100, 10, 900, 1)), terminals),
    ]).toEqual([{ kind: "codex" }, { kind: "agent", agentId: agent }]);
  });

  it("names the agent whose terminal a caller marked only by its environment runs in", () => {
    expect([
      readingOf(via(150, chain(150, 150, 100, 10, 1)), terminals),
      readingOf(via(150, chain(150, 100, 1)), terminals),
      readingOf(via(950, chain(950, 950, 1)), terminals),
      readingOf(via(350, chain(350, 300, 300, 10, 1)), terminals),
    ]).toEqual([
      { kind: "agent", agentId: agent },
      { kind: "agent", agentId: agent },
      { kind: "codex" },
      { kind: "codex" },
    ]);
  });

  it("refuses a caller the runtime runs in no terminal, as tmux run-shell starts one", () => {
    expect(readingOf(chain(15, 15, 10, 1), terminals).kind).toBe("refused");
  });
});
