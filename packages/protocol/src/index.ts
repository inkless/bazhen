import { z } from "zod";
import { ProtocolVersion } from "./version.ts";

export * from "./agents.ts";
export * from "./events.ts";
export * from "./ids.ts";
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
