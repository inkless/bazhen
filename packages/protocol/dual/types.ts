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
  | "HookEvent"
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
 * The schemas judged kind by kind below rather than whole: the protocol builds `Event`'s and
 * `RecordedEvent`'s branches from `EVENTS` in a loop, so each type is one branch of any type with
 * its payload unknown, where the generated one types each kind's.
 */
type ByKind = "Event" | "EventFrame" | "RecordedEvent";

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
type TheirRecordedKind = Sided<Theirs["RecordedEvent"], "output">["type"];

/** What one of `A` and `B` holds and the other doesn't. */
type Apart<A, B> = Exclude<A, B> | Exclude<B, A>;

/** `T` with only whether each part may be null or left out taken out, at every depth. */
type Loose<T> = T extends object ? { [P in keyof T]?: Loose<Exclude<T[P], null | undefined>> } : T;

/** The fields of kind `K`'s payload `KnownFields` excuses. */
type Excused<K> = K extends keyof KnownFields ? KnownFields[K]["fields"] : never;

/** Payload `T` of kind `K` with only what `KnownFields` excuses in it taken out. */
type Excusing<T, K> = Flat<Omit<T, Excused<K>> & Loose<Pick<T, Excused<K> & keyof T>>>;

/** The branch of `Event` the protocol builds for kind `K`, from `EVENTS`, as `Event` builds it. */
type OurBranch<K, S extends Side> = K extends keyof OurEvents
  ? Flat<
      Omit<Sided<Ours["EventEnvelope"], S>, "type" | "entityType" | "payload"> & {
        type: K;
        entityType: OurEvents[K]["entity"];
        payload: Excusing<
          Sided<OurEvents[K] extends { streamed: infer P } ? P : OurEvents[K]["payload"], S>,
          K
        >;
      }
    >
  : never;

/** The generated branch for kind `K` of union `T`, with what `KnownFields` excuses taken out. */
type TheirBranch<T, K> = T extends { type: K; payload: infer P }
  ? Flat<Omit<T, "payload"> & { payload: Excusing<P, K> }>
  : never;

/** Whether kind `K`'s branch of `Event` is the same type on `S` on both. */
type KindAgrees<K, S extends Side> = Equal<
  TheirBranch<Sided<Theirs["Event"], S>, K>,
  OurBranch<K, S>
>;

/** Whether kind `K`'s branch of `RecordedEvent` is the same type on `S` on both. */
type RecordedAgrees<K, S extends Side> = K extends keyof OurEvents
  ? Equal<
      TheirBranch<Sided<Theirs["RecordedEvent"], S>, K>,
      { type: K; payload: Excusing<Sided<OurEvents[K]["payload"], S>, K> }
    >
  : false;

/** Each kind whose branch of `Event` or `RecordedEvent` differs, as it parses or as it is written. */
type DifferingKinds = {
  [K in Kind]: [
    KindAgrees<K, "output">,
    KindAgrees<K, "input">,
    RecordedAgrees<K, "output">,
    RecordedAgrees<K, "input">,
  ] extends [true, true, true, true]
    ? never
    : K;
}[Kind];

type Streamed<E, K> = E extends { streamed: infer P }
  ? [Excusing<Sided<P, "output">, K>, Excusing<Sided<P, "input">, K>]
  : "none";

/** Payload `P` of kind `K` on both sides, with what `KnownFields` excuses taken out. */
type Payloads<P, K> = [Excusing<Sided<P, "output">, K>, Excusing<Sided<P, "input">, K>];

/** Whether kind `K`'s entry in `EVENTS` is the same on both: its entity, payload and streamed one. */
type EntryAgrees<K extends Kind> = K extends keyof TheirEvents
  ? [
      Equal<TheirEvents[K]["entity"], OurEvents[K]["entity"]>,
      Equal<Payloads<TheirEvents[K]["payload"], K>, Payloads<OurEvents[K]["payload"], K>>,
      Equal<Streamed<TheirEvents[K], K>, Streamed<OurEvents[K], K>>,
    ] extends [true, true, true]
    ? true
    : false
  : false;

/** Each kind whose entry in `EVENTS` differs between the two. */
type DifferingEntries = { [K in Kind]: EntryAgrees<K> extends true ? never : K }[Kind];

/** Field `F` of payload `P`, on side `S`. */
type Field<P, F, S extends Side> = Pick<Sided<P, S>, F & keyof Sided<P, S>>;

/** Whether field `F` of kind `K`'s payload is the same type on both, as it parses and as written. */
type FieldAgrees<K, F> = K extends keyof TheirEvents
  ? K extends Kind
    ? [
        Equal<
          Field<TheirEvents[K]["payload"], F, "output">,
          Field<OurEvents[K]["payload"], F, "output">
        >,
        Equal<
          Field<TheirEvents[K]["payload"], F, "input">,
          Field<OurEvents[K]["payload"], F, "input">
        >,
      ] extends [true, true]
      ? true
      : false
    : false
  : false;

/** Each field `KnownFields` excuses that no longer differs, named `kind.field`. */
type ExcusedButAgreeing = {
  [K in keyof KnownFields]: {
    [F in KnownFields[K]["fields"]]: FieldAgrees<K, F> extends true
      ? `${K & string}.${F & string}`
      : never;
  }[KnownFields[K]["fields"]];
}[keyof KnownFields];

/** `EventFrame` but for the event it carries, which `DifferingKinds` judges. */
type FrameRest<T> = T extends { type: "event" } ? Omit<T, "event"> : T;
type FrameAgrees<S extends Side> = Equal<
  FrameRest<Sided<Theirs["EventFrame"], S>>,
  FrameRest<Sided<Ours["EventFrame"], S>>
>;
type FrameDiffers = [FrameAgrees<"output">, FrameAgrees<"input">] extends [true, true]
  ? never
  : "EventFrame";

/**
 * The fields of each kind's payload that the Rust payload takes as null or leaves out where the
 * protocol doesn't, with what owns them. Each is judged with only that taken out, so any other
 * difference in it still fails. The runtime leg's DUAL_KNOWN lists their cases. The list only
 * shrinks: a field listed that no longer differs fails.
 */
interface KnownFields {}

export const parsedTypesDiffer: None<Differing<"output">> = "none";
export const writtenTypesDiffer: None<Differing<"input">> = "none";
export const eventKindsApart: None<Apart<TheirKind, Kind>> = "none";
export const recordedKindsApart: None<Apart<TheirRecordedKind, Kind>> = "none";
export const eventEntriesApart: None<Apart<keyof TheirEvents, Kind>> = "none";
export const eventKindsDiffer: None<DifferingKinds> = "none";
export const eventEntriesDiffer: None<DifferingEntries> = "none";
export const knownFieldsAgree: None<ExcusedButAgreeing> = "none";
export const eventFramesDiffer: None<FrameDiffers> = "none";
export const unexportedAndUnlisted: None<Exclude<Unexported, GeneratedOnly>> = "none";
export const listedButExported: None<Exclude<GeneratedOnly, Unexported>> = "none";
