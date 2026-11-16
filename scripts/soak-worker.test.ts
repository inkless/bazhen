import headless from "@xterm/headless";
import { describe, expect, it } from "vitest";
import { agentStream } from "../tests/support/agent-stream.ts";
import {
  flooding,
  marker,
  markersIn,
  parseWorkerArgs,
  printable,
  PROBE,
  Prober,
  replayTurns,
  takeReplies,
} from "./soak-worker.ts";

const ESC = "\x1b";

/** What a terminal shows, scrollback included, once `stream` is written to it. */
async function shown(stream: string): Promise<string> {
  const term = new headless.Terminal({
    cols: 120,
    rows: 40,
    scrollback: 100_000,
    allowProposedApi: true,
  });
  await new Promise<void>((resolve) => term.write(stream, resolve));
  const buffer = term.buffer.active;
  return Array.from(
    { length: buffer.length },
    (_, y) => buffer.getLine(y)?.translateToString(true) ?? "",
  )
    .map((line) => `${line}\n`)
    .join("");
}

/** What a terminal's output processing makes of text written to it: each \n becomes \r\n. */
const raw = (text: string) => text.replaceAll("\n", "\r\n");

describe("markersIn", () => {
  it("reads a name's markers in order, from the raw stream or rendered lines", () => {
    const stream = raw(`${marker("r1", 7)}noise\r\n${marker("r10", 1)}${marker("r1", 8)}`);
    expect(markersIn(stream, "r1")).toEqual([7, 8]);
    expect(markersIn("#soak r1 7\nother\n#soak r1 8\n", "r1")).toEqual([7, 8]);
  });

  it("skips a marker cut short, which might yet gain digits", () => {
    expect(markersIn(`${marker("f1", 1)}#soak f1 2`, "f1")).toEqual([1]);
  });

  it("finds a marker after typed text or a probe on the same line", () => {
    expect(markersIn(`ab${PROBE}${marker("e1", 3)}`, "e1")).toEqual([3]);
  });
});

describe("replayTurns", () => {
  it("cuts the agent stream into turns that join back into it", () => {
    const turns = replayTurns(300);
    expect(turns.join("")).toBe(agentStream(300));
    expect(turns.length).toBeGreaterThan(30);
    expect(turns.slice(1).every((turn) => turn.startsWith(`${ESC}[38;5;`))).toBe(true);
  });

  it("leaves every marker printed between turns on screen, none drawn over", async () => {
    const turns = replayTurns(300);
    const stream = turns.map((turn, i) => turn + marker("r1", i + 1)).join("");
    const seen = markersIn(await shown(stream), "r1");
    expect(seen).toEqual(Array.from({ length: turns.length }, (_, i) => i + 1));
  });
});

describe("printable", () => {
  it("keeps printable ASCII and drops what would move the cursor", () => {
    expect(printable("ab\rc\td\be\x1bf ~")).toBe("abcdef ~");
  });
});

describe("takeReplies", () => {
  it("counts CPR and DA replies and keeps what was typed apart", () => {
    expect(takeReplies(`a${ESC}[12;3Rb${ESC}[?62;22cc`)).toEqual({
      cpr: 1,
      da: 1,
      typed: "abc",
      rest: "",
    });
  });

  it("holds back a reply cut short, to read with the bytes that follow", () => {
    const first = takeReplies(`x${ESC}[12;`);
    expect(first).toEqual({ cpr: 0, da: 0, typed: "x", rest: `${ESC}[12;` });
    expect(takeReplies(`${first.rest}3R`)).toEqual({ cpr: 1, da: 0, typed: "", rest: "" });
  });

  it("drops the ESC of a sequence that is no reply, keeping the bytes after it", () => {
    expect(takeReplies(`${ESC}[2Jok`)).toEqual({ cpr: 0, da: 0, typed: "[2Jok", rest: "" });
  });
});

/** A prober on a clock the test moves, quiet for a second after a probe expires, and the clock. */
function proberAt(start: number) {
  const clock = { now: start };
  return { prober: new Prober(() => clock.now, 1_000), clock };
}

describe("Prober", () => {
  it("times a probe from its sending to its second reply", () => {
    const { prober, clock } = proberAt(1_000);
    expect(prober.send()).toBe(1);
    clock.now = 1_007;
    expect(prober.read(1, 0)).toBeUndefined();
    clock.now = 1_042;
    expect(prober.read(0, 1)).toBe(42);
  });

  it("sends no second probe while one waits", () => {
    const { prober } = proberAt(0);
    expect([prober.send(), prober.send()]).toEqual([1, undefined]);
  });

  it("calls a probe whose time ran out unanswered, credits its late reply to none, and waits", () => {
    const { prober, clock } = proberAt(0);
    const first = Number(prober.send());
    clock.now = 1_000;
    expect(prober.expire(first)).toBe(true);
    clock.now = 1_999;
    expect(prober.send()).toBeUndefined();
    expect(prober.read(1, 1)).toBeUndefined();
    clock.now = 2_000;
    expect(prober.send()).toBe(2);
    clock.now = 2_003;
    expect(prober.read(1, 1)).toBe(3);
  });

  it("leaves a probe answered in time, or a newer one, to an old probe's timer", () => {
    const { prober } = proberAt(0);
    const first = Number(prober.send());
    prober.read(1, 1);
    expect(prober.expire(first)).toBe(false);
    expect(prober.send()).toBe(2);
    expect(prober.expire(first)).toBe(false);
    expect(prober.read(1, 1)).toBe(0);
  });
});

describe("flooding", () => {
  it("is on for its on time, then off for its off time, round and round", () => {
    expect([0, 59_999, 60_000, 359_999, 360_000].map((t) => flooding(t, 60_000, 300_000))).toEqual([
      true,
      true,
      false,
      false,
      true,
    ]);
  });
});

describe("parseWorkerArgs", () => {
  it("takes a mode, a name and a file, with the soak's rates by default", () => {
    expect(parseWorkerArgs(["flood", "f1", "/tmp/f1.jsonl", "--flood-on", "20000"])).toEqual({
      mode: "flood",
      name: "f1",
      out: "/tmp/f1.jsonl",
      probeEveryMs: 10_000,
      probeTimeoutMs: 1_000,
      markerEveryMs: 1_000,
      linesPerSecond: 50,
      floodOnMs: 20_000,
      floodOffMs: 300_000,
      slowProbeMs: 0,
    });
  });

  it("refuses an unknown mode, a missing file, a name with a space and a rate that isn't whole", () => {
    expect(() => parseWorkerArgs(["spin", "x", "/tmp/x"])).toThrow(/usage/);
    expect(() => parseWorkerArgs(["idle", "x"])).toThrow(/usage/);
    expect(() => parseWorkerArgs(["idle", "a b", "/tmp/x"])).toThrow(/no spaces/);
    expect(() => parseWorkerArgs(["idle", "x", "/tmp/x", "--probe-every", "1.5"])).toThrow(
      /whole number/,
    );
  });
});
