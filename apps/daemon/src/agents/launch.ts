import { basename } from "node:path";
import {
  LaunchFailed,
  newId,
  UnsupportedHarness,
  type EnvironmentAdapter,
  type EnvironmentId,
  type Size,
} from "@bazhen/core";
import { LaunchAgentResponse, type LaunchAgentRequest } from "@bazhen/protocol";
import type { Store } from "../store/store.ts";

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
export async function launchAgent(
  { store, environment, size }: LaunchDeps,
  req: LaunchAgentRequest,
): Promise<LaunchAgentResponse> {
  const prior = store.recall(req.idempotencyKey);
  if (prior !== undefined) return LaunchAgentResponse.parse(prior);
  if (!environment.harnesses.includes(req.harness)) throw new UnsupportedHarness(req.harness);

  const agentId = newId("agent");
  const terminalId = newId("term");
  const request = { harness: req.harness, cwd: req.cwd, project: req.project ?? basename(req.cwd) };
  const event = { entityId: agentId, actor: "system" };
  // Each step's event and its answer to a repeat are written together.
  const record = (append: () => number, earlier: number[] = []) =>
    store.transaction(() => {
      const response = { agentId, terminalId, eventIds: [...earlier, append()] };
      store.remember(req.idempotencyKey, response);
      return response;
    });

  const launched = record(() =>
    store.append({
      ...event,
      type: "agent.launched",
      payload: { environmentId: environment.id, ...request, terminalId },
    }),
  );
  const refs = await environment.launch({ agentId, terminalId, request, size }).catch((cause) => {
    record(
      () =>
        store.append({ ...event, type: "agent.failed", payload: { reason: "launch_rejected" } }),
      launched.eventIds,
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
          runtime: refs.runtime && { kind: refs.runtime.runtime, locator: refs.runtime.locator },
        },
      }),
    launched.eventIds,
  );
}
