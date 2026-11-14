import { basename } from "node:path";
import {
  isId,
  LaunchFailed,
  newId,
  UnsupportedHarness,
  type EnvironmentAdapter,
  type AgentSessionId,
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
import { failureDetail } from "../commands.ts";
import { IdempotencyConflict, runtimePayload, type Store } from "../store/store.ts";
import { FLEET_INSTRUCTIONS } from "../tasks/mail.ts";
import { resolveDirectory } from "./cwd.ts";
import type { AgentQueue } from "./queue.ts";

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
  /** The agents' command queue: a launch holds its new agent's slot until its last event. */
  readonly queue: AgentQueue;
}

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

/**
 * `launchAgent`, answered only once the launch has settled: a repeat of a launch still in flight
 * waits for it, then gets its outcome, its failure included, rather than the answer so far.
 */
export async function launchSettled(
  deps: LaunchDeps,
  req: LaunchAgentRequest,
  launchedBy?: AgentSessionId,
): Promise<LaunchAgentResponse> {
  const answer = await launchAgent(deps, req, launchedBy);
  const { agentId } = answer;
  if (deps.store.agentTerminal({ agentId })?.state !== "starting") return answer;
  // Only a repeat is answered while its launch is in flight, and that launch holds its agent's
  // slot until its last event.
  await deps.queue.run(agentId, async () => {});
  return launchAgent(deps, req, launchedBy);
}

/** The options a request names; one without a theme leaves it to the harness. Never stored. */
export const launchOptions = (theme: TuiTheme | undefined): LaunchOptions => ({
  instructions: FLEET_INSTRUCTIONS,
  ...(theme === undefined ? {} : { theme }),
});

/**
 * Launches one agent. The daemon mints every id and records the launch before the environment
 * starts anything (foundation-design §8.1), and the request's key makes a retry return the first
 * answer instead of launching twice (§5.1). A repeat while the launch is in flight gets the
 * answer so far. `launchedBy` is the agent launching this one to delegate to it; none when the
 * human does.
 */
export async function launchAgent(
  { store, environment, size, home, queue }: LaunchDeps,
  req: LaunchAgentRequest,
  launchedBy?: AgentSessionId,
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
  // Each step's event and the key's answer are written together, so a repeat sees exactly what
  // the first request has done so far.
  const record = (append: () => number, earlier: number[], failed = false) =>
    store.transaction(() => {
      const response = { agentId, terminalId, eventIds: [...earlier, append()] };
      const remembered: LaunchRecord = { request: asked, response, failed };
      store.remember(req.idempotencyKey, remembered);
      return response;
    });

  // Recorded before this call first yields, so a repeat in the same tick finds the key answered.
  const launched = record(
    () =>
      store.append({
        ...event,
        type: "agent.launched",
        payload: {
          environmentId: environment.id,
          ...request,
          terminalId,
          ...(launchedBy === undefined ? {} : { launchedBy }),
        },
      }),
    [],
  );
  // Nothing else may settle the agent while its launch is in flight, so it takes its slot in the
  // same synchronous step as it is recorded: no await may come between the two.
  return queue.run(agentId, async () => {
    const options = launchOptions(req.theme);
    const launching = environment.launch({
      agentId,
      terminalId,
      generation: 0,
      resume: null,
      request,
      options,
      size,
    });
    const refs = await launching.catch((cause) => {
      console.error(`agent ${agentId} failed to launch:`, cause);
      const detail = failureDetail(cause);
      record(
        () =>
          store.append({
            ...event,
            type: "agent.failed",
            payload: { reason: "launch_rejected", detail },
          }),
        launched.eventIds,
        true,
      );
      throw new LaunchFailed(agentId, detail, { cause });
    });
    return record(
      () =>
        store.append({
          ...event,
          type: "agent.running",
          payload: {
            externalRef: refs.externalRef,
            runtimeRef: refs.runtime && runtimePayload(refs.runtime),
            ...(refs.theme && { theme: refs.theme }),
          },
        }),
      launched.eventIds,
    );
  });
}
