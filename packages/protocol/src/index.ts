import { z } from "zod";
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
    kept: z.int().nonnegative(),
    /** How many variables each denying rule removed. */
    removed: z.record(z.string(), z.int().nonnegative()),
  }),
});
export type DoctorResponse = z.infer<typeof DoctorResponse>;

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
