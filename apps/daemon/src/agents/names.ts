import { TaskRefused, type Caller } from "@bazhen/core";
import { AgentCommandResponse, type AgentState, type RenameAgentRequest } from "@bazhen/protocol";
import { UnknownAgent, type Store } from "../store/store.ts";

/** A name another agent not ended already holds. */
export class NameTaken extends Error {
  constructor(name: string) {
    super(`another agent is named ${name}; close it or pick another name`);
  }
}

/** The agent no longer runs and can't again, so it has no name to address it by. */
export class AgentEnded extends Error {
  constructor(agentId: string, state: AgentState) {
    super(`agent ${agentId} is ${state}; only an agent not ended can be renamed`);
  }
}

const ENDED: ReadonlySet<AgentState> = new Set(["closed", "failed"]);

/**
 * The name a new agent takes, read in the transaction that records its launch: the one asked
 * for, refused when another live agent holds it, or its project's next default.
 */
export function launchName(
  store: Store,
  asked: string | undefined,
  projectName: string,
): { name: string; nameOrdinal?: number } {
  if (asked === undefined) {
    const { name, ordinal } = store.nextDefaultName(projectName);
    return { name, nameOrdinal: ordinal };
  }
  if (store.liveAgentNamed(asked) !== undefined) throw new NameTaken(asked);
  return { name: asked };
}

/**
 * Renames an agent not ended (foundation-design §11.4). The human renames any agent; an agent,
 * only itself. Its harness keeps the name it was started with until it is next started.
 */
export function renameAgent(
  store: Store,
  caller: Caller,
  agentId: string,
  req: RenameAgentRequest,
): AgentCommandResponse {
  return store.once(
    req.idempotencyKey,
    { caller, agentId, name: req.name },
    (r) => AgentCommandResponse.parse(r),
    () => {
      if (caller !== null && caller !== agentId)
        throw new TaskRefused("forbidden", "an agent can rename only itself");
      const found = store.agent(agentId);
      if (found === undefined) throw new UnknownAgent(agentId);
      if (ENDED.has(found.state)) throw new AgentEnded(agentId, found.state);
      if (found.name === req.name) return AgentCommandResponse.parse({ agentId, eventIds: [] });
      const holder = store.liveAgentNamed(req.name);
      if (holder !== undefined && holder !== agentId) throw new NameTaken(req.name);
      const eventId = store.append({
        type: "agent.renamed",
        entityId: agentId,
        actor: caller ?? "user",
        payload: { name: req.name, previous: found.name },
      });
      return AgentCommandResponse.parse({ agentId, eventIds: [eventId] });
    },
  );
}
