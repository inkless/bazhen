import { describe, expect, it } from "vitest";
import type { Agent, AgentState, StateSnapshot } from "@bazhen/protocol";
import {
  agentActions,
  agentLabel,
  agentLabelOf,
  defaultNamePreview,
  groupFleet,
  observedRows,
  themeRespawn,
} from "./model.ts";

let serial = 0;
/** An id of the protocol's shape: a prefix and 32 hex digits, version 7. */
const newId = <P extends string>(prefix: P) =>
  `${prefix}_0190000000007000800000000000${String(++serial).padStart(4, "0")}` as const;

const environmentId = newId("env");

const agentIn = (project: string, state: AgentState = "running", over: Partial<Agent> = {}) => ({
  id: newId("agent"),
  name: project,
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
  resumable: true,
  canOpenShell: false,
  launchedBy: null,
  listening: false,
  headline: null,
  ...over,
});

const snapshot = (agents: Agent[], waitingOn: Agent[] = []): StateSnapshot => ({
  epoch: "e",
  eventId: 1,
  environments: [{ id: environmentId, kind: "local", host: "laptop" }],
  agents,
  shells: [],
  tasks: [],
  assignments: [],
  notices: [],
  observed: [],
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
      agentActions(agentIn("p", "lost", { commands: ["close", "relaunch"] })).buttons,
      agentActions(agentIn("p", "lost", { commands: ["close"] })).buttons,
      agentActions(agentIn("p", "running", { commands: ["close", "signal"] })).buttons,
    ]).toEqual([["respawn", "close"], ["relaunch", "remove"], ["remove"], ["close"]]);
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

describe("agentLabel", () => {
  it("names a live agent by its name alone, which no other live agent holds", () => {
    const a = agentIn("web", "running", { name: "reviewer" });
    expect([
      agentLabel(a),
      agentLabel({ ...a, state: "lost" }),
      agentLabel({ ...a, state: "exited" }),
    ]).toEqual(["reviewer", "reviewer", "reviewer"]);
  });

  it("adds an ended agent's short id, since a live agent may hold its name now", () => {
    const a = agentIn("web", "closed", { name: "reviewer" });
    expect([agentLabel(a), agentLabel({ ...a, state: "failed" })]).toEqual([
      `reviewer (${a.id.slice(-6)})`,
      `reviewer (${a.id.slice(-6)})`,
    ]);
  });

  it("names an agent from a daemon that gave it no name by its project and short id", () => {
    const a = agentIn("web", "running", { name: "" });
    expect(agentLabel(a)).toBe(`web (${a.id.slice(-6)})`);
  });
});

describe("agentLabelOf", () => {
  it("labels the agent an id names, and an id the snapshot doesn't hold by its short id", () => {
    const a = agentIn("web", "running", { name: "reviewer" });
    const gone = newId("agent");
    expect([agentLabelOf([a], a.id), agentLabelOf([a], gone)]).toEqual([
      "reviewer",
      `agent ${gone.slice(-6)}`,
    ]);
  });
});

/** A message `from` sent `to`, as the daemon observed it. */
const sent = (from: Agent, to: Agent, summary: string, accepted = true) => ({
  id: newId("obs"),
  from: from.id,
  to: to.id,
  summary,
  accepted,
  at: "2026-11-12T00:00:00.000Z",
});

describe("observedRows", () => {
  it("lists what an agent sent and was sent, newest first, each by the other agent's name", () => {
    const [me, peer, other] = [agentIn("me"), agentIn("BZ-127"), agentIn("other")];
    const state = {
      agents: [me, peer, other],
      observed: [
        sent(me, peer, "first"),
        sent(peer, other, "elsewhere"),
        sent(peer, me, "back", false),
      ],
    };
    expect(observedRows(state, me.id).map((r) => [r.with, r.summary, r.accepted])).toEqual([
      ["From BZ-127", "back", false],
      ["To BZ-127", "first", true],
    ]);
  });
});

describe("defaultNamePreview", () => {
  it("names a launch in an absolute directory after its last part, as the daemon's default does", () => {
    expect([
      defaultNamePreview("/work/playground"),
      defaultNamePreview("/work/playground/"),
      defaultNamePreview("/work/my app (old)"),
      defaultNamePreview("/"),
      defaultNamePreview("/work/playground/.."),
      defaultNamePreview("/work/../web"),
    ]).toEqual([
      "playground-<n>",
      "playground-<n>",
      "my-app-old-<n>",
      "agent-<n>",
      "agent-<n>",
      "web-<n>",
    ]);
  });

  it("can't say the project of a directory the daemon resolves, so it doesn't guess", () => {
    expect([
      defaultNamePreview("~/work/web"),
      defaultNamePreview("web"),
      defaultNamePreview(""),
    ]).toEqual(["<project>-<n>", "<project>-<n>", "<project>-<n>"]);
  });
});

describe("themeRespawn", () => {
  it("allows an exited agent, and a running one only between turns as its harness reports it", () => {
    const resumable = true;
    expect([
      themeRespawn({ state: "exited", resumable }),
      themeRespawn({ state: "running", resumable, activity: activity("idle") }),
      themeRespawn({ state: "running", resumable, activity: activity("waiting_input") }),
      themeRespawn({ state: "running", resumable, activity: activity("working") }),
      themeRespawn({ state: "running", resumable, activity: activity("needs_approval") }),
      themeRespawn({ state: "running", resumable }),
    ]).toEqual([
      null,
      null,
      "Waiting on your answer in its terminal",
      "Mid-turn: wait for it to finish",
      "Mid-turn: wait for it to finish",
      "Can't tell whether it's mid-turn",
    ]);
  });

  it("allows none whose session has no conversation to resume, rather than stop it for nothing", () => {
    expect([
      themeRespawn({ state: "exited", resumable: false }),
      themeRespawn({ state: "running", resumable: false, activity: activity("idle") }),
    ]).toEqual(["No conversation to resume yet", "No conversation to resume yet"]);
  });
});
