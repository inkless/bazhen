import {
  nameBase,
  type Agent,
  type Environment,
  type ExitStatus,
  type NeedsRestart,
  type StateSnapshot,
} from "@bazhen/protocol";

/**
 * What to tell the user of a terminal on a holder this Bazhen can't fully serve, or null for one
 * that needs no restart. The daemon never ends that holder itself, so the user is told how to.
 */
export function restartNote(needs: NeedsRestart, then: "relaunch" | "restart"): string {
  if (needs.served) {
    return (
      "Runs on a holder of an older protocol, which this version of Bazhen still serves, though " +
      `not in full. Close it and ${then} it to run on a current holder.`
    );
  }
  const how =
    needs.holderPid === null
      ? "That holder keeps running until its process is ended."
      : "That holder keeps running until its process is ended: check that " +
        `\`ps -o comm=,lstart= -p ${needs.holderPid}\` shows a command ending in bazhen-holder, ` +
        "started no later than this terminal, then end that process.";
  return (
    "Runs on a holder whose protocol this version of Bazhen doesn't speak, older or newer, so " +
    `it can't be served here. ${how} Then ${then} it to run on a current holder.`
  );
}

/** A button the workspace shows; `remove` is close, said of an agent whose terminal is gone. */
export type AgentButton = "respawn" | "relaunch" | "close" | "remove";

export interface AgentActions {
  /** Whether its terminal can be shown: the runtime still holds one. */
  readonly open: boolean;
  readonly buttons: readonly AgentButton[];
}

/** What the workspace offers for an agent: the commands the daemon says it would take now. */
export function agentActions(a: Agent): AgentActions {
  const buttons: AgentButton[] = [];
  if (a.commands.includes("respawn")) buttons.push("respawn");
  if (a.commands.includes("relaunch")) buttons.push("relaunch");
  if (a.commands.includes("close")) buttons.push(a.state === "lost" ? "remove" : "close");
  return { open: a.terminalId !== null && a.attachCommand !== null, buttons };
}

/** Agents that have finished for good, hidden from the fleet unless asked for. */
export const isEnded = (a: Pick<Agent, "state">) => a.state === "closed" || a.state === "failed";

export interface FleetRow {
  readonly agent: Agent;
  readonly needsYou: boolean;
}

export interface FleetProject {
  readonly name: string;
  readonly rows: readonly FleetRow[];
}

export interface FleetGroup {
  readonly environment: Environment;
  readonly projects: readonly FleetProject[];
}

export interface Fleet {
  readonly groups: readonly FleetGroup[];
  /** How many ended agents the groups leave out. */
  readonly hidden: number;
}

const urgent = (p: FleetProject) => p.rows.some((r) => r.needsYou);

/**
 * The fleet by environment, then project. Projects holding an agent that needs the human come
 * first, then by name; within a project those agents come first, then the rest as launched.
 */
export function groupFleet(state: StateSnapshot, showEnded: boolean): Fleet {
  const waiting = new Set(state.attention.filter((i) => i.state === "open").map((i) => i.agentId));
  const shown = state.agents.filter((a) => showEnded || !isEnded(a));
  const groups = state.environments.map((environment) => {
    const byProject = new Map<string, FleetRow[]>();
    for (const agent of shown.filter((a) => a.environmentId === environment.id)) {
      const rows = byProject.get(agent.project) ?? [];
      rows.push({ agent, needsYou: waiting.has(agent.id) });
      byProject.set(agent.project, rows);
    }
    const projects = [...byProject].map(([name, rows]) => ({
      name,
      rows: rows.toSorted((x, y) => Number(y.needsYou) - Number(x.needsYou)),
    }));
    return {
      environment,
      projects: projects.toSorted(
        (x, y) => Number(urgent(y)) - Number(urgent(x)) || x.name.localeCompare(y.name),
      ),
    };
  });
  return { groups, hidden: state.agents.length - shown.length };
}

export function exitText(exit: ExitStatus): string {
  if (exit.type === "exited") return `exited with code ${exit.code}`;
  if (exit.type === "signalled") return `killed by ${exit.signal}`;
  return "ended";
}

/** Enough of an id to tell two agents apart at a glance. */
export const shortId = (id: string) => id.slice(-6);

/**
 * How the page names an agent. A live agent's name is unique among live agents, so it is enough.
 * Closing frees a name for another agent to take, so an ended agent's carries its short id.
 */
export function agentLabel(a: Pick<Agent, "id" | "name" | "project" | "state">): string {
  if (a.name === "") return `${a.project} (${shortId(a.id)})`;
  return isEnded(a) ? `${a.name} (${shortId(a.id)})` : a.name;
}

/**
 * The name a launch in `cwd` would be given by default. The daemon takes the project from the
 * directory's last part as it was asked, `.` and `..` included, once it has resolved `~`, so only
 * an absolute directory's can be said here; the number is the daemon's counter, which the page
 * doesn't have.
 */
export function defaultNamePreview(cwd: string): string {
  if (!cwd.startsWith("/")) return "<project>-<n>";
  return `${nameBase(cwd.replace(/\/+$/, "").split("/").at(-1) ?? "")}-<n>`;
}

/** The label of the agent `id` names, for a site that holds only the id. */
export function agentLabelOf(
  agents: readonly Pick<Agent, "id" | "name" | "project" | "state">[],
  id: string,
): string {
  const a = agents.find((x) => x.id === id);
  return a === undefined ? `agent ${shortId(id)}` : agentLabel(a);
}

/** A message an agent sent or was sent outside Bazhen's mail, as its workspace lists it. */
export interface ObservedRow {
  readonly id: string;
  /** "To <peer>" for one the agent sent, "From <peer>" for one it was sent. */
  readonly with: string;
  readonly summary: string;
  readonly at: string;
  readonly accepted: boolean;
}

/** The messages `agentId` sent or was sent through its harness's own channel, newest first. */
export function observedRows(
  state: Pick<StateSnapshot, "observed" | "agents">,
  agentId: string,
): ObservedRow[] {
  return state.observed
    .filter((m) => m.from === agentId || m.to === agentId)
    .map(({ id, from, to, summary, at, accepted }) => ({
      id,
      with:
        from === agentId
          ? `To ${agentLabelOf(state.agents, to)}`
          : `From ${agentLabelOf(state.agents, from)}`,
      summary,
      at,
      accepted,
    }))
    .toReversed();
}

/**
 * Whether an agent can be respawned in another theme now, and why not: only on the session it
 * has, so not before that session has a conversation to resume. A running one is stopped
 * first, so only between turns, as its harness reports it: stopping it mid-turn would cut the turn
 * off, and an agent whose harness reports nothing can't be shown to be between turns. Waiting on
 * the human's input is mid-turn too: the turn goes on once the question is answered.
 */
export function themeRespawn(a: Pick<Agent, "state" | "activity" | "resumable">): string | null {
  // Stopped, it could only be started on a new session, which a theme isn't worth.
  if (!a.resumable) return "No conversation to resume yet";
  if (a.state === "exited") return null;
  const value = a.activity?.value;
  if (value === undefined || value === "unknown") return "Can't tell whether it's mid-turn";
  if (value === "waiting_input") return "Waiting on your answer in its terminal";
  return value === "idle" ? null : "Mid-turn: wait for it to finish";
}
