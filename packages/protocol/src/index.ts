import { z } from "zod";
import { Id } from "./ids.ts";
import { ProtocolVersion } from "./version.ts";

export * from "./agents.ts";
export * from "./events.ts";
export * from "./ids.ts";
export * from "./input.ts";
export * from "./json.ts";
export * from "./mail.ts";
export * from "./stream.ts";
export * from "./version.ts";

export const RuntimeHealthState = z.enum(["healthy", "unreachable", "not-running"]);
export type RuntimeHealthState = z.infer<typeof RuntimeHealthState>;

export const HealthResponse = z.object({
  status: z.literal("ok"),
  appVersion: z.string(),
  protocolVersion: ProtocolVersion,
  schemaVersion: z.number().int().nonnegative(),
  runtime: z.object({
    kind: z.literal("tmux"),
    state: RuntimeHealthState,
    version: z.string().nullable(),
  }),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

/**
 * `GET /v1/daemon/doctor`, on the Unix socket only: what `bazhen doctor` shows. The environment
 * the daemon captured is counted, never listed, so no value of the user's leaves the daemon.
 */
export const DoctorResponse = z.object({
  appVersion: z.string(),
  protocolVersion: ProtocolVersion,
  runtime: z.object({ state: RuntimeHealthState, version: z.string().nullable() }),
  hookClient: z.object({ path: z.string(), fallback: z.boolean() }),
  config: z.object({ path: z.string(), found: z.boolean() }),
  /** `agents.shell`, and the login shell agents start through when it is "login". */
  agents: z.object({ shell: z.enum(["direct", "login"]), loginShell: z.string().nullable() }),
  env: z.object({
    capturedAt: z.string(),
    /** Captured when the daemon started, or by the latest `bazhen env refresh`. */
    source: z.enum(["start", "refresh"]),
    kept: z.int().nonnegative(),
    /** How many variables each denying rule removed. */
    removed: z.record(z.string(), z.int().nonnegative()),
  }),
});
export type DoctorResponse = z.infer<typeof DoctorResponse>;

/**
 * `POST /v1/daemon/env`, on the Unix socket only: the environment of the shell running
 * `bazhen env refresh`, for every agent started from now on (foundation-design §9.5).
 */
export const EnvRefreshRequest = z.object({ env: z.record(z.string(), z.string()) });
export type EnvRefreshRequest = z.infer<typeof EnvRefreshRequest>;

export const EnvRefreshResponse = z.object({
  capturedAt: z.string(),
  kept: z.int().nonnegative(),
  removed: z.record(z.string(), z.int().nonnegative()),
  /** Names left as they were, because tmux can't take their name or value as data. */
  refused: z.array(z.string()),
  /** Agents running now, which keep the environment they started with until respawned. */
  unchanged: z.array(Id("agent")),
});
export type EnvRefreshResponse = z.infer<typeof EnvRefreshResponse>;

export const TerminalState = z.enum([
  "creating",
  "running",
  "exited",
  "unknown",
  "lost",
  "closing",
  "closed",
  "failed",
]);
export type TerminalState = z.infer<typeof TerminalState>;
