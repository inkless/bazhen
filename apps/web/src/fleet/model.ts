import type { Agent, Environment, ExitStatus, StateSnapshot } from "@bazhen/protocol";

/** A button the workspace shows; `remove` is close, said of an agent whose terminal is gone. */
export type AgentButton = "respawn" | "close" | "remove";

export interface AgentActions {
  /** Whether its terminal can be shown: the runtime still holds one. */
  readonly open: boolean;
  readonly buttons: readonly AgentButton[];
}

/** What the workspace offers for an agent: the commands the daemon says it would take now. */
export function agentActions(a: Agent): AgentActions {
  const buttons: AgentButton[] = [];
  if (a.commands.includes("respawn")) buttons.push("respawn");
  if (a.commands.includes("close")) buttons.push(a.state === "lost" ? "remove" : "close");
  return { open: a.terminalId !== null && a.attachCommand !== null, buttons };
}

/** Agents that have finished for good, hidden from the fleet unless asked for. */
export const isEnded = (a: Agent) => a.state === "closed" || a.state === "failed";

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

/** Enough of an id to tell two agents in one project apart at a glance. */
export const shortId = (id: string) => id.slice(-6);

/**
 * Whether an agent can be respawned in another theme now, and why not. A running one is stopped
 * first, so only between turns, as its harness reports it: stopping it mid-turn would cut the turn
 * off, and an agent whose harness reports nothing can't be shown to be between turns. Waiting on
 * the human's input is mid-turn too: the turn goes on once the question is answered.
 */
export function themeRespawn(a: Pick<Agent, "state" | "activity">): string | null {
  if (a.state === "exited") return null;
  const value = a.activity?.value;
  if (value === undefined || value === "unknown") return "Can't tell whether it's mid-turn";
  if (value === "waiting_input") return "Waiting on your answer in its terminal";
  return value === "idle" ? null : "Mid-turn: wait for it to finish";
}
