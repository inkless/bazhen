import { basename } from "node:path";
import {
  isId,
  LaunchFailed,
  newId,
  UnsupportedHarness,
  type EnvironmentAdapter,
  type EnvironmentId,
  type Size,
} from "@bazhen/core";
import { HarnessId, LaunchAgentResponse, type LaunchAgentRequest } from "@bazhen/protocol";
import { z } from "zod";
import { IdempotencyConflict, runtimePayload, type Store } from "../store/store.ts";

/** The local environment's id, registering it on the first run (foundation-design §3). */
export function localEnvironmentId(store: Store): EnvironmentId {
  const existing = store.environments("local")[0];
  if (existing !== undefined) return existing;
  const id = newId("env");
  store.append({
    type: "environment.registered",
    entityId: id,
    actor: "system",
    payload: { kind: "local" },
  });
  return id;
}

/** What a launch key remembers: the request it was for, and how that launch ended. */
const LaunchRecord = z.object({
  request: z.object({ harness: HarnessId, cwd: z.string(), project: z.string() }),
  response: LaunchAgentResponse,
  failed: z.boolean(),
});
type LaunchRecord = z.infer<typeof LaunchRecord>;

export interface LaunchDeps {
  readonly store: Store;
  readonly environment: EnvironmentAdapter;
  /** The terminal's size until a view attaches and sets its own. */
  readonly size: Size;
}

/**
 * Launches one agent. The daemon mints every id and records the launch before the environment
 * starts anything (foundation-design §8.1), and the request's key makes a retry return the first
 * answer instead of launching twice (§5.1).
 */
/** The first answer a key got: the same response, or the same failure. */
function replay(
  prior: LaunchRecord,
  key: string,
  request: LaunchRecord["request"],
): LaunchAgentResponse {
  const same =
    prior.request.harness === request.harness &&
    prior.request.cwd === request.cwd &&
    prior.request.project === request.project;
  if (!same) throw new IdempotencyConflict(key);
  if (prior.failed) {
    const agentId = prior.response.agentId;
    throw new LaunchFailed(
      isId("agent", agentId) ? agentId : newId("agent"),
      "an earlier attempt failed",
    );
  }
  return prior.response;
}

export async function launchAgent(
  { store, environment, size }: LaunchDeps,
  req: LaunchAgentRequest,
): Promise<LaunchAgentResponse> {
  const request = { harness: req.harness, cwd: req.cwd, project: req.project ?? basename(req.cwd) };
  const prior = store.recall(req.idempotencyKey);
  if (prior !== undefined) return replay(LaunchRecord.parse(prior), req.idempotencyKey, request);
  if (!environment.harnesses.includes(req.harness)) throw new UnsupportedHarness(req.harness);

  const agentId = newId("agent");
  const terminalId = newId("term");
  const event = { entityId: agentId, actor: "system" };
  // Each step's event and the key's answer are written together, so a repeat sees exactly
  // what the first request has done so far.
  const record = (append: () => number, earlier: number[], failed = false) =>
    store.transaction(() => {
      const response = { agentId, terminalId, eventIds: [...earlier, append()] };
      const remembered: LaunchRecord = { request, response, failed };
      store.remember(req.idempotencyKey, remembered);
      return response;
    });

  const launched = record(
    () =>
      store.append({
        ...event,
        type: "agent.launched",
        payload: { environmentId: environment.id, ...request, terminalId },
      }),
    [],
  );
  const refs = await environment.launch({ agentId, terminalId, request, size }).catch((cause) => {
    // The client learns only that it failed; the daemon's log says why.
    console.error(`agent ${agentId} failed to launch:`, cause);
    record(
      () =>
        store.append({ ...event, type: "agent.failed", payload: { reason: "launch_rejected" } }),
      launched.eventIds,
      true,
    );
    throw new LaunchFailed(agentId, cause);
  });
  return record(
    () =>
      store.append({
        ...event,
        type: "agent.running",
        payload: {
          externalRef: refs.externalRef,
          runtimeRef: refs.runtime && runtimePayload(refs.runtime),
        },
      }),
    launched.eventIds,
  );
}
