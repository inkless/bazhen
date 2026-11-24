// The Dual test's type leg, which tsc judges in `moon run :check` (the `protocol-dual-types`
// task): each schema the zod generated from the Rust protocol shares a name with is the protocol's
// own type, as it parses and as it is written. Its runtime leg is src/dual.medium.test.ts.
// tsconfig.json maps the generated file's `zod` to this package's, which no node_modules under
// target/ holds.

import type { z } from "zod";
import type * as Generated from "../../../target/protocol-shadow/gen/protocol.ts";
import type * as Protocol from "../src/index.ts";

type Equal<A, B> =
  (<T>(t: T) => T extends A ? 1 : 2) extends <T>(t: T) => T extends B ? 1 : 2 ? true : false;

/** `"none"` when `T` is empty, and otherwise a type naming `T`, which `"none"` fails. */
type None<T> = [T] extends [never] ? "none" : { names: T };

type Theirs = typeof Generated;
type Ours = typeof Protocol;
type Schemas = { [K in keyof Theirs]: Theirs[K] extends z.ZodType ? K : never }[keyof Theirs];

/**
 * The generated schemas the protocol exports nothing of the name of: each a part the Rust protocol
 * names and the protocol writes inline in its message, whose type that message's holds.
 */
type GeneratedOnly =
  | "ActivitySource"
  | "ActivityValue"
  | "AgentCli"
  | "AgentShell"
  | "AgentsSettings"
  | "CapturedEnv"
  | "Certificate"
  | "ClosedFrom"
  | "Codex"
  | "ConfigFile"
  | "Containment"
  | "DaemonHolderStats"
  | "EndedReason"
  | "EnvSource"
  | "ErrorCode"
  | "EventId"
  | "ExternalRefKind"
  | "FleetAttention"
  | "FleetHeadline"
  | "FleetSignal"
  | "FleetTask"
  | "Foreground"
  | "Grant"
  | "Headline"
  | "HealthStatus"
  | "Holder"
  | "HolderArgv"
  | "HolderEnv"
  | "HolderExitCode"
  | "HolderProtocolVersion"
  | "HolderSubscribeFrom"
  | "HolderTerminalId"
  | "HookClient"
  | "HostPtys"
  | "Lan"
  | "Launch"
  | "Notifications"
  | "OriginsFrom"
  | "Pairing"
  | "PairingLan"
  | "PairingMode"
  | "PeerReader"
  | "Refusing"
  | "Resumes"
  | "RunningHolder"
  | "SentTo"
  | "Skipped"
  | "Subnet"
  | "TaskCondition"
  | "Terminals"
  | "Timestamp"
  | "ToolCalls"
  | "Web";

type Unexported = Exclude<Schemas, keyof Ours>;

/** Each shared schema whose `side` of the type differs between the two. */
type Differing<Side extends "input" | "output"> = {
  [K in Exclude<Schemas, Unexported>]: K extends keyof Ours
    ? Ours[K] extends z.ZodType
      ? Side extends "output"
        ? Equal<z.output<Theirs[K]>, z.output<Ours[K]>> extends true
          ? never
          : K
        : Equal<z.input<Theirs[K]>, z.input<Ours[K]>> extends true
          ? never
          : K
      : K
    : never;
}[Exclude<Schemas, Unexported>];

export const parsedTypesDiffer: None<Differing<"output">> = "none";
export const writtenTypesDiffer: None<Differing<"input">> = "none";
export const unexportedAndUnlisted: None<Exclude<Unexported, GeneratedOnly>> = "none";
export const listedButExported: None<Exclude<GeneratedOnly, Unexported>> = "none";
