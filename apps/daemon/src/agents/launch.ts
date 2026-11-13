import { basename } from "node:path";
import {
  isId,
  LaunchFailed,
  newId,
  UnsupportedHarness,
  type EnvironmentAdapter,
  type EnvironmentId,
  type Size,
  type LaunchOptions,
} from "@bazhen/core";
import {
  HarnessId,
  LaunchAgentResponse,
  type LaunchAgentRequest,
  type TuiTheme,
} from "@bazhen/protocol";
import { z } from "zod";
import { IdempotencyConflict, runtimePayload, type Store } from "../store/store.ts";
import { resolveDirectory } from "./cwd.ts";

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

/** What a launch key remembers: the request as it was asked, and how that launch ended. */
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
  /** The daemon user's home, which a launch directory's leading `~` names. */
  readonly home: string;
}

/**
 * Launches one agent. The daemon mints every id and records the launch before the environment
 * starts anything (foundation-design §8.1), and the request's key makes a retry return the first
 * answer instead of launching twice (§5.1).
 */
/**
 * The first answer a key got: the same response, or the same failure. A launch the daemon died
 * in the middle of is settled after the key was answered, by reconciliation, so whether it failed
 * is read from the agent as well.
 */
function replay(
  store: Store,
  prior: LaunchRecord,
  key: string,
  request: LaunchRecord["request"],
): LaunchAgentResponse {
  const same =
    prior.request.harness === request.harness &&
    prior.request.cwd === request.cwd &&
    prior.request.project === request.project;
  if (!same) throw new IdempotencyConflict(key);
  const settled = store.agentTerminal({ agentId: prior.response.agentId })?.state;
  if (prior.failed || settled === "failed") {
    const agentId = prior.response.agentId;
    throw new LaunchFailed(
      isId("agent", agentId) ? agentId : newId("agent"),
      "an earlier attempt failed",
    );
  }
  return prior.response;
}

/** The options a request names; one without a theme leaves it to the harness. Never stored. */
export const launchOptions = (theme: TuiTheme | undefined): LaunchOptions =>
  theme === undefined ? {} : { theme };

export async function launchAgent(
  { store, environment, size, home }: LaunchDeps,
  req: LaunchAgentRequest,
): Promise<LaunchAgentResponse> {
  const asked = { harness: req.harness, cwd: req.cwd, project: req.project ?? basename(req.cwd) };
  const prior = store.recall(req.idempotencyKey);
  // A retry gets the first answer, whatever has happened to the directory since.
  if (prior !== undefined)
    return replay(store, LaunchRecord.parse(prior), req.idempotencyKey, asked);
  if (!environment.harnesses.includes(req.harness)) throw new UnsupportedHarness(req.harness);
  const cwd = resolveDirectory(req.cwd, home);
  const request = { harness: req.harness, cwd, project: req.project ?? basename(cwd) };

  const agentId = newId("agent");
  const terminalId = newId("term");
  const event = { entityId: agentId, actor: "system" };
  // Each step's event and the key's answer are written together, so a repeat sees exactly
  // what the first request has done so far.
  const record = (append: () => number, earlier: number[], failed = false) =>
    store.transaction(() => {
      const response = { agentId, terminalId, eventIds: [...earlier, append()] };
      const remembered: LaunchRecord = { request: asked, response, failed };
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
  const options = launchOptions(req.theme);
  const launching = environment.launch({ agentId, terminalId, request, options, size });
  const refs = await launching.catch((cause) => {
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
