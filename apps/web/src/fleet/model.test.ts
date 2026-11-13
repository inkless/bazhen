import { describe, expect, it } from "vitest";
import type { Agent, AgentState, StateSnapshot } from "@bazhen/protocol";
import { agentActions, groupFleet, themeRespawn } from "./model.ts";

let serial = 0;
/** An id of the protocol's shape: a prefix and 32 hex digits, version 7. */
const newId = <P extends string>(prefix: P) =>
  `${prefix}_0190000000007000800000000000${String(++serial).padStart(4, "0")}` as const;

const environmentId = newId("env");

const agentIn = (project: string, state: AgentState = "running", over: Partial<Agent> = {}) => ({
  id: newId("agent"),
  environmentId,
  harness: "claude-code" as const,
  project,
  cwd: `/work/${project}`,
  state,
  terminalId: newId("term"),
  generation: 0,
  externalRef: { environmentId, kind: "claude-session" as const, id: "s" },
  exit: null,
  theme: "dark" as const,
  themes: ["light" as const, "dark" as const],
  attachCommand: "tmux attach",
  commands: [],
  ...over,
});

const snapshot = (agents: Agent[], waitingOn: Agent[] = []): StateSnapshot => ({
  epoch: "e",
  eventId: 1,
  environments: [{ id: environmentId, kind: "local", host: "laptop" }],
  agents,
  shells: [],
  attention: waitingOn.map((a) => ({
    id: newId("attn"),
    agentId: a.id,
    state: "open" as const,
    closeReason: null,
    summary: "Run tests?",
    kind: "approval" as const,
    taskId: null,
    messageId: null,
    openedAt: "2026-11-12T00:00:00.000Z",
    actions: ["allow" as const, "deny" as const],
  })),
  messages: [],
});

describe("agentActions", () => {
  it("opens only an agent whose terminal the runtime still holds", () => {
    expect([
      agentActions(agentIn("p", "running")).open,
      agentActions(agentIn("p", "lost", { attachCommand: null })).open,
    ]).toEqual([true, false]);
  });

  it("shows the daemon's commands, and close on a lost agent as remove", () => {
    expect([
      agentActions(agentIn("p", "exited", { commands: ["close", "respawn"] })).buttons,
      agentActions(agentIn("p", "lost", { commands: ["close"] })).buttons,
      agentActions(agentIn("p", "running", { commands: ["close", "signal"] })).buttons,
    ]).toEqual([["respawn", "close"], ["remove"], ["close"]]);
  });
});

describe("groupFleet", () => {
  it("puts agents that need you, and their projects, first; the rest as launched", () => {
    const [a1, a2, b1, c1] = [
      agentIn("alpha"),
      agentIn("alpha"),
      agentIn("beta"),
      agentIn("gamma"),
    ];
    const fleet = groupFleet(snapshot([a1, a2, b1, c1], [a2, c1]), false);
    expect(
      fleet.groups.map((g) => [
        g.environment.host,
        g.projects.map((p) => [p.name, p.rows.map((r) => r.agent.id)]),
      ]),
    ).toEqual([
      [
        "laptop",
        [
          ["alpha", [a2.id, a1.id]],
          ["gamma", [c1.id]],
          ["beta", [b1.id]],
        ],
      ],
    ]);
  });

  it("leaves ended agents out unless asked, and counts them", () => {
    const agents = [
      agentIn("p"),
      agentIn("p", "closed"),
      agentIn("p", "failed"),
      agentIn("p", "lost"),
    ];
    const count = (showEnded: boolean) => {
      const fleet = groupFleet(snapshot(agents), showEnded);
      return [fleet.groups[0]?.projects[0]?.rows.length, fleet.hidden];
    };
    expect([count(false), count(true)]).toEqual([
      [2, 2],
      [4, 0],
    ]);
  });
});

/** An activity signal its harness reported, with `value`. */
const activity = (value: "idle" | "waiting_input" | "working" | "needs_approval") => ({
  value,
  source: "native" as const,
  confidence: 1,
  observedAt: "2026-11-13T00:00:00.000Z",
});

describe("themeRespawn", () => {
  it("allows an exited agent, and a running one only between turns as its harness reports it", () => {
    expect([
      themeRespawn({ state: "exited" }),
      themeRespawn({ state: "running", activity: activity("idle") }),
      themeRespawn({ state: "running", activity: activity("waiting_input") }),
      themeRespawn({ state: "running", activity: activity("working") }),
      themeRespawn({ state: "running", activity: activity("needs_approval") }),
      themeRespawn({ state: "running" }),
    ]).toEqual([
      null,
      null,
      "Waiting on your answer in its terminal",
      "Mid-turn: wait for it to finish",
      "Mid-turn: wait for it to finish",
      "Can't tell whether it's mid-turn",
    ]);
  });
});
