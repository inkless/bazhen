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
  ancestors,
});

describe("parsePeer", () => {
  it("reads the pid, the session and each ancestor bazhen-peer prints", () => {
    expect(parsePeer("50 40 40 1\n")).toEqual(chain(50, 40, 40, 1));
  });

  it("reads nothing from a line that isn't one", () => {
    expect([parsePeer(""), parsePeer("50"), parsePeer("50 x 1"), parsePeer("-5 1")]).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
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

  it("refuses a caller the runtime runs in no terminal, as tmux run-shell starts one", () => {
    expect(readingOf(chain(15, 15, 10, 1), terminals).kind).toBe("refused");
  });
});
