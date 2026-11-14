import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  HOLDER_ERROR_CODES,
  HolderError,
  HolderExited,
  HolderForeground,
  HolderRespawned,
  HolderHelloReply,
  HolderHelloRequest,
  HolderSetThemeRequest,
  HolderSignalRequest,
  HolderSpawnSpec,
  HolderStats,
  HolderSubscribeRequest,
  negotiateHolder,
} from "./holder.ts";
import { HISTORY_LINES } from "./stream.ts";

const TERMINAL = "term_0190a1b2c3d47abc8def0123456789ab";

const spawnSpec = {
  protocol: ["1.0"],
  terminalId: TERMINAL,
  socket: "/run/bazhen/holders/t.sock",
  tags: { kind: "agent" },
  size: { cols: 80, rows: 24 },
  argv: ["claude"],
  cwd: "/home/u",
  env: {},
  generation: 0,
  theme: "dark",
};

const hello = {
  version: "1.0",
  protocol: ["1.0"],
  terminalId: TERMINAL,
  tags: {},
  generation: 2,
  holderPid: 41,
  holderStart: 1_763_000_000,
  childPid: 42,
  childStart: 1_763_000_001,
  exit: null,
  size: { cols: 80, rows: 24 },
  offset: 0,
  title: "",
  alternate: false,
  historyLines: 10_000,
  writer: true,
};

const respawned = { generation: 3, childPid: 50, childStart: 1_763_000_002 };
const stats = { engineBytes: 1, rss: null, ringBytes: 2, historyLines: 3 };
const foreground = { childPid: 42, childStart: 1, pgid: 43, pgidStart: 2 };

describe("negotiateHolder", () => {
  it("agrees on the lower minor of a shared major, whichever side has it", () => {
    expect([negotiateHolder(["1.4"], ["1.2"]), negotiateHolder(["1.2"], ["1.4"])]).toEqual([
      "1.2",
      "1.2",
    ]);
  });

  it("agrees on the highest major both speak", () => {
    expect([
      negotiateHolder(["1.4", "2.3"], ["1.9", "2.1"]),
      negotiateHolder(["1.4", "2.3"], ["1.9"]),
    ]).toEqual(["2.1", "1.4"]);
  });

  it("agrees on nothing when no major is shared", () => {
    expect(negotiateHolder(["2.0"], ["1.5"])).toBeNull();
  });

  it("compares minors as numbers, not text", () => {
    expect(negotiateHolder(["1.10"], ["1.9"])).toBe("1.9");
  });

  it("ignores a malformed version instead of reading its prefix", () => {
    expect(negotiateHolder(["1.0"], ["1", "1.0-beta"])).toBeNull();
  });

  it("takes a peer's highest minor when it lists a major twice", () => {
    expect(negotiateHolder(["1.2", "1.5"], ["1.9"])).toBe("1.5");
  });

  it("ignores a version too long to read exactly, rather than merging it with another", () => {
    expect([
      negotiateHolder(["9007199254740993.0"], ["9007199254740992.0"]),
      negotiateHolder(["1.9007199254740993"], ["1.9007199254740992"]),
    ]).toEqual([null, null]);
  });
});

const broken: [string, z.ZodType, unknown, unknown][] = [
  ["a spawn spec with an empty argv", HolderSpawnSpec, spawnSpec, { ...spawnSpec, argv: [] }],
  ["a spawn spec with an empty cwd", HolderSpawnSpec, spawnSpec, { ...spawnSpec, cwd: "" }],
  [
    "a terminal id that isn't a plain file name",
    HolderSpawnSpec,
    spawnSpec,
    { ...spawnSpec, terminalId: "../t" },
  ],
  ["a spawn spec in no version", HolderSpawnSpec, spawnSpec, { ...spawnSpec, protocol: [] }],
  ["a spawn spec with no socket", HolderSpawnSpec, spawnSpec, { ...spawnSpec, socket: "" }],
  [
    "more columns than the maximum",
    HolderSpawnSpec,
    spawnSpec,
    { ...spawnSpec, size: { cols: 1001, rows: 24 } },
  ],
  [
    "more rows than the maximum",
    HolderSpawnSpec,
    spawnSpec,
    { ...spawnSpec, size: { cols: 80, rows: 1001 } },
  ],
  [
    "more history than the maximum",
    HolderSpawnSpec,
    { ...spawnSpec, historyLines: 100_000 },
    { ...spawnSpec, historyLines: 100_001 },
  ],
  [
    "a tag named __proto__",
    HolderSpawnSpec,
    spawnSpec,
    { ...spawnSpec, tags: JSON.parse('{"__proto__":"x"}') },
  ],
  [
    "a tag named constructor",
    HolderSpawnSpec,
    spawnSpec,
    { ...spawnSpec, tags: { constructor: "x" } },
  ],
  [
    "a tag value one UTF-8 byte over the limit",
    HolderSpawnSpec,
    { ...spawnSpec, tags: { k: `${"界".repeat(341)}a` } },
    { ...spawnSpec, tags: { k: `${"界".repeat(341)}ab` } },
  ],
  ["a negative size", HolderSpawnSpec, spawnSpec, { ...spawnSpec, size: { cols: 80, rows: -1 } }],
  ["a fractional generation", HolderSpawnSpec, spawnSpec, { ...spawnSpec, generation: 1.5 }],
  ["an empty tag name", HolderSpawnSpec, spawnSpec, { ...spawnSpec, tags: { "": "x" } }],
  [
    "a tag name too long",
    HolderSpawnSpec,
    spawnSpec,
    { ...spawnSpec, tags: { ["k".repeat(65)]: "x" } },
  ],
  [
    "a tag value of more UTF-8 bytes than allowed, though fewer characters",
    HolderSpawnSpec,
    spawnSpec,
    { ...spawnSpec, tags: { k: "界".repeat(342) } },
  ],
  [
    "a tag value too long",
    HolderSpawnSpec,
    spawnSpec,
    { ...spawnSpec, tags: { k: "x".repeat(1025) } },
  ],
  ["a theme that isn't one", HolderSpawnSpec, spawnSpec, { ...spawnSpec, theme: "blue" }],
  ["a hello with no versions", HolderHelloReply, hello, { ...hello, protocol: [] }],
  [
    "a hello with too many versions",
    HolderHelloReply,
    hello,
    { ...hello, protocol: Array.from({ length: 17 }, (_, i) => `${i}.0`) },
  ],
  ["a hello agreeing on no version", HolderHelloReply, hello, { ...hello, version: "1" }],
  ["a start before the epoch", HolderHelloReply, hello, { ...hello, holderStart: -1 }],
  [
    "a hello without the child's start",
    HolderHelloReply,
    hello,
    { ...hello, childStart: undefined },
  ],
  ["a hello from pid 0", HolderHelloReply, hello, { ...hello, holderPid: 0 }],
  ["an offset past 2^53 - 1", HolderHelloReply, hello, { ...hello, offset: 2 ** 53 }],
  ["an exit status of no kind", HolderHelloReply, hello, { ...hello, exit: { type: "gone" } }],
  ["a negative rss", HolderStats, stats, { ...stats, rss: -1 }],
  ["a foreground group 0", HolderForeground, foreground, { ...foreground, pgid: 0 }],
  [
    "a subscribe from before 0",
    HolderSubscribeRequest,
    { from: { generation: 0, offset: 0 } },
    { from: { generation: 0, offset: -1 } },
  ],
  [
    "a subscribe from an offset of no generation",
    HolderSubscribeRequest,
    { from: { generation: 0, offset: 5 } },
    { from: { offset: 5 } },
  ],
  [
    "a signal Bazhen doesn't send",
    HolderSignalRequest,
    { signal: "SIGINT" },
    { signal: "SIGSTOP" },
  ],
  ["a theme left out instead of null", HolderSetThemeRequest, { theme: null }, {}],
  [
    "an error without a code",
    HolderError,
    { request: "input", code: "not-writer", message: "" },
    { request: "input", message: "" },
  ],
  [
    "an exit of no generation",
    HolderExited,
    { generation: 1, status: { type: "unknown" } },
    { status: { type: "unknown" } },
  ],
  [
    "an exit of a fractional generation",
    HolderExited,
    { generation: 1, status: { type: "unknown" } },
    { generation: 1.5, status: { type: "unknown" } },
  ],
  ["a child start before the epoch", HolderHelloReply, hello, { ...hello, childStart: -1 }],
  ["a respawn to pid 0", HolderRespawned, respawned, { ...respawned, childPid: 0 }],
  ["a respawn of no generation", HolderRespawned, respawned, { ...respawned, generation: -1 }],
  [
    "a respawned child's start before the epoch",
    HolderRespawned,
    respawned,
    { ...respawned, childStart: -1 },
  ],
  [
    "a subscribe in a generation before 0",
    HolderSubscribeRequest,
    { from: { generation: 0, offset: 0 } },
    { from: { generation: -1, offset: 0 } },
  ],
];

describe("holder/1 schemas", () => {
  it.each(broken)("refuse %s", (_, schema, valid, invalid) => {
    expect([schema.safeParse(valid).success, schema.safeParse(invalid).success]).toEqual([
      true,
      false,
    ]);
  });

  it("read a peer's versions leniently, so one this build can't parse doesn't refuse its hello", () => {
    expect(HolderHelloRequest.parse({ protocol: ["1.0", "2.0-beta"] })).toEqual({
      protocol: ["1.0", "2.0-beta"],
    });
  });

  it("give a spawn spec without a history depth the default one", () => {
    const { historyLines: _, ...spec } = HolderSpawnSpec.parse(spawnSpec);
    expect(HolderSpawnSpec.parse(spec).historyLines).toBe(HISTORY_LINES);
  });
});

describe("holder error codes", () => {
  it("keep the strings every version of either peer reads them by", () => {
    expect(HOLDER_ERROR_CODES).toEqual([
      "unknown-request",
      "stale-generation",
      "out-of-range",
      "invalid",
      "no-shared-version",
      "not-writer",
      "input-full",
      "exited",
      "snapshot-too-large",
      "failed",
    ]);
  });
});
