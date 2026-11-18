import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StateSnapshot, TerminalScreen } from "@bazhen/protocol";
import { type Scene, scene } from "./cli.ts";
import { AGENT, agent, shell, snapshot } from "./fixtures.ts";

let s: Scene;
beforeEach(async () => {
  s = await scene();
});
afterEach(async () => {
  await s.cleanup();
});

const SH1 = "term_0190c3b2a1d47a3b8c1d2e3f4a5b6c71";
const TERM = "term_0190c3b2a1d47a3b8c1d2e3f4a5b6c75";

/** An exited agent: its terminal still held, but nothing to attach to. */
const reviewer = agent(AGENT, "reviewer", { state: "exited", terminalId: TERM });

const holding = () =>
  s.daemon.answer(
    "GET /v1/state",
    StateSnapshot,
    snapshot({ agents: [reviewer], shells: [shell(SH1, { name: "build" })] }),
  );

const screenOf = (terminal: string, history: number, text: string) =>
  s.daemon.answer(`GET /v1/terminals/${terminal}/screen?history=${history}`, TerminalScreen, {
    text,
    history,
  });

describe("bazhen terminals screen", () => {
  it("prints a shell's screen as text, after the rows of history asked for", async () => {
    holding();
    screenOf(SH1, 2, "1\n2\n$ ls\nREADME.md\n");
    expect(await s.bazhen(["terminals", "screen", "build", "--history", "2"])).toEqual({
      code: 0,
      stdout: "1\n2\n$ ls\nREADME.md\n",
      stderr: "",
    });
  });

  it("reads an exited agent's terminal by the agent's name, as the CLI reads it with --json", async () => {
    holding();
    screenOf(TERM, 0, "done\n");
    const ran = await s.bazhen(["terminals", "screen", "reviewer", "--json"]);
    expect([ran.code, JSON.parse(ran.stdout)]).toEqual([0, { text: "done\n", history: 0 }]);
  });

  it("prints a control the daemon sent as a replacement, never acting on the reader's terminal", async () => {
    holding();
    const body = JSON.stringify({ text: "\u001b]0;owned\u0007\n", history: 0 });
    s.daemon.raw(`GET /v1/terminals/${SH1}/screen?history=0`, 200, body);
    expect((await s.bazhen(["terminals", "screen", SH1])).stdout).toBe(
      "\u{fffd}]0;owned\u{fffd}\n",
    );
  });

  it("says when nothing has the name, or it has no terminal, reading no screen", async () => {
    s.daemon.answer(
      "GET /v1/state",
      StateSnapshot,
      snapshot({ agents: [agent(AGENT, "reviewer")] }),
    );
    const nothing = await s.bazhen(["terminals", "screen", "nobody"]);
    const bare = await s.bazhen(["terminals", "screen", "reviewer"]);
    expect([nothing.stderr, bare.stderr]).toEqual([
      "no agent, shell or terminal is named nobody\n",
      "reviewer has no terminal to read\n",
    ]);
    expect(s.daemon.routes()).toEqual(["GET /v1/state", "GET /v1/state"]);
  });

  it("prints the daemon's refusal", async () => {
    holding();
    s.daemon.fail(`GET /v1/terminals/${SH1}/screen?history=0`, 403, {
      error: "forbidden",
      message: "an agent can't read a terminal's screen",
    });
    const ran = await s.bazhen(["terminals", "screen", "build"]);
    expect([ran.code === 0, ran.stderr]).toEqual([
      false,
      expect.stringContaining("an agent can't read a terminal's screen"),
    ]);
  });

  it.each(["-1", "10001", "1.5", "x"])(
    "refuses --history %s, asking the daemon nothing",
    async (rows) => {
      const ran = await s.bazhen(["terminals", "screen", "build", `--history=${rows}`]);
      expect([ran.code, ran.stderr.split("\n")[0], s.daemon.routes()]).toEqual([
        2,
        `--history is a whole number of rows from 0 to 10000, not ${rows}`,
        [],
      ]);
    },
  );
});
