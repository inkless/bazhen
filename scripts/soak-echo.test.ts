import { describe, expect, it } from "vitest";
import { EchoTimer, parseEchoArgs, type Typing } from "./soak-echo.ts";

/** A view the test plays: what was typed, and output to send back, on a clock the test moves. */
function fakeView() {
  const clock = { now: 0 };
  const typed: string[] = [];
  let listener: ((chunk: Buffer) => void) | undefined;
  const snapshot = { arrived: true };
  const view: Typing = {
    hasSnapshot: () => snapshot.arrived,
    type: (text) => typed.push(text),
    onOutput: (l) => {
      listener = l;
    },
  };
  const output = (text: string, at: number) => {
    clock.now = at;
    listener?.(Buffer.from(text));
  };
  return { view, clock, typed, output, snapshot };
}

describe("EchoTimer", () => {
  it("times a keystroke from its typing to the output that echoes it", async () => {
    const { view, clock, typed, output } = fakeView();
    const timer = new EchoTimer(view, () => clock.now);
    clock.now = 100;
    const timed = timer.time();
    output("#soak e1 7\r\r\n", 103);
    output("x", 112);
    expect(await timed).toBe(12);
    expect(typed).toEqual(["x"]);
  });

  it("records a keystroke never echoed as null", async () => {
    const { view, clock } = fakeView();
    const timer = new EchoTimer(view, () => clock.now);
    expect(await timer.time(20)).toBeNull();
  });

  it("times the next keystroke from its own typing after one gave up", async () => {
    const { view, clock, output } = fakeView();
    const timer = new EchoTimer(view, () => clock.now);
    expect(await timer.time(10)).toBeNull();
    output("x", 50);
    clock.now = 60;
    const next = timer.time();
    output("x", 65);
    expect(await next).toBe(5);
  });
});

describe("EchoTimer before its view's snapshot", () => {
  it("takes no x in the snapshot, an earlier echo, for this keystroke's", async () => {
    const { view, clock, output, snapshot } = fakeView();
    snapshot.arrived = false;
    const timer = new EchoTimer(view, () => clock.now);
    const timed = timer.time(20);
    output("x", 1);
    expect(await timed).toBeNull();
  });
});

describe("parseEchoArgs", () => {
  it("takes the daemon, the terminal, the file, and the floods' schedule", () => {
    expect(
      parseEchoArgs([
        "http://127.0.0.1:1",
        "term_1",
        "/r/echo.jsonl",
        "--every",
        "500",
        "--flood-starts",
        "10,20",
      ]),
    ).toEqual({
      url: "http://127.0.0.1:1",
      terminalId: "term_1",
      out: "/r/echo.jsonl",
      everyMs: 500,
      floodOnMs: 60_000,
      floodOffMs: 300_000,
      floodStarts: [10, 20],
    });
  });

  it("refuses a missing file, and a time that isn't a number of milliseconds", () => {
    expect(() => parseEchoArgs(["http://x", "term_1"])).toThrow(/usage/);
    expect(() => parseEchoArgs(["http://x", "term_1", "/f", "--every", "soon"])).toThrow(
      /milliseconds/,
    );
    expect(() => parseEchoArgs(["http://x", "term_1", "/f", "--flood-starts", "5,-1"])).toThrow(
      /milliseconds/,
    );
  });
});
