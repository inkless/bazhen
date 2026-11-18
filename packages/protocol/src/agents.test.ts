import { describe, expect, it } from "vitest";
import {
  Activity,
  CallerResponse,
  LaunchAgentRequest,
  RespawnAgentRequest,
  StateSnapshot,
  Usage,
} from "./agents.ts";

const launch = { idempotencyKey: "k-1", harness: "claude-code", cwd: "/work" };
const window = (compactWindowTokens: unknown) =>
  LaunchAgentRequest.safeParse({ ...launch, compactWindowTokens }).success;

describe("LaunchAgentRequest", () => {
  it("accepts a launch with a key, a known harness and an absolute directory", () => {
    expect(LaunchAgentRequest.safeParse(launch).success).toBe(true);
  });

  it("refuses an empty directory, and leaves what a path means to the daemon", () => {
    expect([
      LaunchAgentRequest.safeParse({ ...launch, cwd: "" }).success,
      LaunchAgentRequest.safeParse({ ...launch, cwd: "~/work" }).success,
    ]).toEqual([false, true]);
  });

  it("refuses a launch without an idempotency key", () => {
    expect(LaunchAgentRequest.safeParse({ ...launch, idempotencyKey: "" }).success).toBe(false);
  });

  it("refuses a harness Bazhen has no adapter for", () => {
    expect(LaunchAgentRequest.safeParse({ ...launch, harness: "pi" }).success).toBe(false);
  });

  it("takes a light or dark theme for the TUI, or none, and nothing else", () => {
    const respawn = { idempotencyKey: "k-2", generation: 1 };
    expect([
      LaunchAgentRequest.safeParse({ ...launch, theme: "light" }).success,
      RespawnAgentRequest.safeParse({ ...respawn, theme: "dark" }).success,
      RespawnAgentRequest.safeParse(respawn).success,
      LaunchAgentRequest.safeParse({ ...launch, theme: "system" }).success,
      RespawnAgentRequest.safeParse({ ...respawn, theme: "Light" }).success,
    ]).toEqual([true, true, true, false, false]);
  });

  it("takes a compaction window of whole tokens from 100 000 to 10 000 000", () => {
    expect([
      window(100_000),
      window(10_000_000),
      window(99_999),
      window(10_000_001),
      window(300_000.5),
      window("300000"),
    ]).toEqual([true, true, false, false, false, false]);
  });
});

describe("CallerResponse", () => {
  it("names an agent by its id, or the human as null, and nothing else", () => {
    const agent = "agent_01900000000070008000000000000001";
    expect(
      [
        { agentId: agent },
        { agentId: null },
        {},
        { agentId: "BZ-127" },
        { agentId: "term_01900000000070008000000000000001" },
      ].map((r) => CallerResponse.safeParse(r).success),
    ).toEqual([true, true, false, false, false]);
  });
});

describe("StateSnapshot", () => {
  it("still reads a snapshot from a daemon older than its host, attach, command and fleet fields", () => {
    const environmentId = "env_01900000000070008000000000000001";
    const older = {
      epoch: "e",
      eventId: 1,
      environments: [{ id: environmentId, kind: "local" }],
      agents: [
        {
          id: "agent_01900000000070008000000000000002",
          environmentId,
          harness: "codex",
          project: "p",
          cwd: "/p",
          state: "running",
          terminalId: null,
          generation: null,
          externalRef: null,
          exit: null,
        },
      ],
      attention: [],
      messages: [],
    };
    const read = StateSnapshot.parse(older);
    expect([
      read.environments[0]?.host,
      read.agents[0]?.attachCommand,
      read.agents[0]?.commands,
      read.agents[0]?.listening,
      read.agents[0]?.headline,
    ]).toEqual(["", null, [], false, null]);
  });
});

describe("Activity", () => {
  const signal = { source: "native", confidence: 1, observedAt: "2026-11-18T10:00:00.000Z" };

  it("says an agent is stopped at its account's limit, and when the limit resets", () => {
    expect([
      Activity.safeParse({ ...signal, value: "limited", resetsAt: "2026-11-18T15:00:00.000Z" })
        .success,
      Activity.safeParse({ ...signal, value: "limited" }).success,
      Activity.safeParse({ ...signal, value: "limited", resetsAt: "at three" }).success,
    ]).toEqual([true, true, false]);
  });
});

describe("Usage", () => {
  it("carries each limit window's share used and its reset, which can be past 100", () => {
    const limits = [
      { window: "five_hour", usedPercent: 100, resetsAt: "2026-11-18T15:00:00.000Z" },
      { window: "spend_limit", usedPercent: 104.5 },
    ];
    expect([
      Usage.safeParse({ limits }).success,
      Usage.safeParse({ limits: [{ window: "five_hour", usedPercent: -1 }] }).success,
      Usage.safeParse({ limits: [{ window: "", usedPercent: 1 }] }).success,
    ]).toEqual([true, false, false]);
  });
});
