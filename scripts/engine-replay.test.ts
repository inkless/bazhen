import { describe, expect, it } from "vitest";
import { agentStream, flood, replayReport, sgrStream } from "./engine-replay.ts";

const SGR = new RegExp(`${String.fromCodePoint(0x1b)}\\[[0-9;]*m`, "g");
/** The lines a stream prints, without its colours. */
const printed = (stream: string) => stream.replaceAll(SGR, "").split("\r\n").slice(0, -1);

describe("sgrStream", () => {
  it("prints the lines asked for, each a full 160 columns", () => {
    const lines = printed(sgrStream(50));
    expect(lines).toHaveLength(50);
    expect(new Set(lines.map((line) => line.length))).toEqual(new Set([160]));
  });

  it("changes colour for every word, as the worst case for the store", () => {
    const line = sgrStream(1);
    const words = line.replaceAll(SGR, " ").trim().split(/ +/);
    expect(line.match(SGR)?.length).toBe(words.length + 1);
  });

  it("is the same on every run", () => {
    expect(sgrStream(20)).toBe(sgrStream(20));
  });
});

describe("agentStream", () => {
  it("prints at least the lines asked for", () => {
    const stream = agentStream(1000);
    expect(stream.split("\r\n").length - 1).toBeGreaterThanOrEqual(1000);
    expect(stream).toBe(agentStream(1000));
  });
});

describe("flood", () => {
  it("repeats the line to about the size asked for, and no less", () => {
    const text = flood("y\r\n", 1);
    expect(text.length).toBeGreaterThanOrEqual(1_048_576);
    expect(text.length).toBeLessThan(1_048_576 + 3);
    expect(text.slice(0, 6)).toBe("y\r\ny\r\n");
  });
});

describe("replayReport", () => {
  const report = {
    engineBytes: 1,
    historyBytes: 2,
    historyRows: 3,
    overflows: 0,
    mbPerSecond: 4.5,
  };

  it("reads the replay bin's report", () => {
    expect(replayReport({ ...report, fedBytes: 9 })).toEqual(report);
  });

  it("names the field a report lacks or got wrong", () => {
    expect(() => replayReport({ ...report, overflows: "0" })).toThrow(/overflows/);
    expect(() => replayReport(null)).toThrow(/engineBytes/);
  });
});
