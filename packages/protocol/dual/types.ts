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
  | "AgentFailedReason"
  | "AgentShell"
  | "AgentsSettings"
  | "AssignmentEndedReason"
  | "AttachmentEndReason"
  | "AttentionClosedReason"
  | "CapturedEnv"
  | "Certificate"
  | "ClosedFrom"
  | "Codex"
  | "CompactedHook"
  | "CompactedSign"
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
  | "ReadySign"
  | "Refusing"
  | "RelaunchRejectedReason"
  | "RequeueReason"
  | "RespawnRejectedReason"
  | "Resumes"
  | "RunningHolder"
  | "RuntimeRefPayload"
  | "SentTo"
  | "Skipped"
  | "Subnet"
  | "TaskCondition"
  | "TerminalClosedReason"
  | "TerminalFailedReason"
  | "Terminals"
  | "Timestamp"
  | "ToolCalls"
  | "UndeliverableReason"
  | "Web";

type Unexported = Exclude<Schemas, keyof Ours>;

type Side = "input" | "output";
type Sided<T, S extends Side> = T extends z.ZodType
  ? S extends "output"
    ? z.output<T>
    : z.input<T>
  : never;
type Flat<T> = T extends unknown ? { [P in keyof T]: T[P] } : never;

/**
 * The schemas judged kind by kind below rather than whole: the protocol builds `Event`'s branches
 * from `EVENTS` in a loop, so its type is one branch of any type with its payload unknown, where
 * the generated one types each kind's.
 */
type ByKind = "Event" | "EventFrame";

/** Each shared schema, but those `ByKind` names, whose `S` side of the type differs. */
type Differing<S extends Side> = {
  [K in Exclude<Schemas, Unexported | ByKind>]: K extends keyof Ours
    ? Equal<Sided<Theirs[K], S>, Sided<Ours[K], S>> extends true
      ? never
      : K
    : never;
}[Exclude<Schemas, Unexported | ByKind>];

type OurEvents = Ours["EVENTS"];
type TheirEvents = Theirs["EVENTS"];
type Kind = keyof OurEvents;
type TheirKind = Sided<Theirs["Event"], "output">["type"];

/** What one of `A` and `B` holds and the other doesn't. */
type Apart<A, B> = Exclude<A, B> | Exclude<B, A>;

/** The branch of `Event` the protocol builds for kind `K`, from `EVENTS`, as `Event` builds it. */
type OurBranch<K, S extends Side> = K extends keyof OurEvents
  ? Flat<
      Omit<Sided<Ours["EventEnvelope"], S>, "type" | "entityType" | "payload"> & {
        type: K;
        entityType: OurEvents[K]["entity"];
        payload: Sided<OurEvents[K] extends { streamed: infer P } ? P : OurEvents[K]["payload"], S>;
      }
    >
  : never;

/** Whether kind `K`'s branch of `Event` is the same type on `S` on both. */
type KindAgrees<K, S extends Side> = Equal<
  Flat<Extract<Sided<Theirs["Event"], S>, { type: K }>>,
  OurBranch<K, S>
>;

/** Each kind whose branch of `Event` differs between the two, as it parses or as it is written. */
type DifferingKinds = {
  [K in Kind]: [KindAgrees<K, "output">, KindAgrees<K, "input">] extends [true, true] ? never : K;
}[Kind];

type Streamed<E> = E extends { streamed: infer P }
  ? [Sided<P, "output">, Sided<P, "input">]
  : "none";

/**
 * Whether kind `K`'s entry in `EVENTS` is the same on both: its entity, payload and streamed one.
 * A field a kind doesn't stream has no other check: the corpus plants cases only in what `Event`
 * streams, so its bounds and patterns go unjudged until a corpus covers the whole payloads.
 */
type EntryAgrees<K extends Kind> = K extends keyof TheirEvents
  ? [
      Equal<TheirEvents[K]["entity"], OurEvents[K]["entity"]>,
      Equal<Sided<TheirEvents[K]["payload"], "output">, Sided<OurEvents[K]["payload"], "output">>,
      Equal<Sided<TheirEvents[K]["payload"], "input">, Sided<OurEvents[K]["payload"], "input">>,
      Equal<Streamed<TheirEvents[K]>, Streamed<OurEvents[K]>>,
    ] extends [true, true, true, true]
    ? true
    : false
  : false;

/** Each kind whose entry in `EVENTS` differs between the two. */
type DifferingEntries = { [K in Kind]: EntryAgrees<K> extends true ? never : K }[Kind];

/** `EventFrame` but for the event it carries, which `DifferingKinds` judges. */
type FrameRest<T> = T extends { type: "event" } ? Omit<T, "event"> : T;
type FrameAgrees<S extends Side> = Equal<
  FrameRest<Sided<Theirs["EventFrame"], S>>,
  FrameRest<Sided<Ours["EventFrame"], S>>
>;
type FrameDiffers = [FrameAgrees<"output">, FrameAgrees<"input">] extends [true, true]
  ? never
  : "EventFrame";

const AGENT_EVENTS = "the port of agent_events.rs";
const MAIL_EVENTS = "the port of mail_events.rs";
const TASK_EVENTS = "the port of task_events.rs";

/**
 * The kinds whose payload's type differs, each with what owns it: a field the Rust payload takes
 * as null or leaves out where the protocol doesn't. The runtime leg's DUAL_KNOWN lists the cases of
 * those it streams. The list only shrinks: a kind listed whose branch and entry no longer differ
 * fails.
 */
interface KnownKinds {
  "agent.compacted": typeof AGENT_EVENTS;
  "agent.failed": typeof AGENT_EVENTS;
  "agent.launched": typeof AGENT_EVENTS;
  "agent.relaunch_rejected": typeof AGENT_EVENTS;
  "agent.relaunch_requested": typeof AGENT_EVENTS;
  "agent.relaunched": typeof AGENT_EVENTS;
  "agent.respawn_rejected": typeof AGENT_EVENTS;
  "agent.respawned": typeof AGENT_EVENTS;
  "agent.running": typeof AGENT_EVENTS;
  "assignment.granted": typeof TASK_EVENTS;
  "attention.opened": typeof MAIL_EVENTS;
  "mailbox.offered": typeof MAIL_EVENTS;
  "mailbox.queued": typeof MAIL_EVENTS;
  "task.finished": typeof TASK_EVENTS;
  "task.noted": typeof TASK_EVENTS;
  "task.owner_changed": typeof TASK_EVENTS;
}

export const parsedTypesDiffer: None<Differing<"output">> = "none";
export const writtenTypesDiffer: None<Differing<"input">> = "none";
export const eventKindsApart: None<Apart<TheirKind, Kind>> = "none";
export const eventEntriesApart: None<Apart<keyof TheirEvents, Kind>> = "none";
export const eventKindsDiffer: None<Exclude<DifferingKinds, keyof KnownKinds>> = "none";
export const eventEntriesDiffer: None<Exclude<DifferingEntries, keyof KnownKinds>> = "none";
export const knownKindsAgree: None<Exclude<keyof KnownKinds, DifferingKinds | DifferingEntries>> =
  "none";
export const eventFramesDiffer: None<FrameDiffers> = "none";
export const unexportedAndUnlisted: None<Exclude<Unexported, GeneratedOnly>> = "none";
export const listedButExported: None<Exclude<GeneratedOnly, Unexported>> = "none";
