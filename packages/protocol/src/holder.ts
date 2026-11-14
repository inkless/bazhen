import { z } from "zod";
import { ExitStatus, Signal } from "./agents.ts";
import { Id } from "./ids.ts";
import { HISTORY_LINES } from "./stream.ts";
import { TuiTheme } from "./theme.ts";
import { ProtocolVersion } from "./version.ts";

/**
 * `holder/1`: what the daemon and a `bazhen-holder` say over the holder's Unix socket. Versioned
 * apart from the daemon's protocol, under the same rule: within a major, changes are additive
 * only, and the minor is bumped in the same commit as any addition.
 *
 * A connection opens with `hello`: until it is answered the client sends nothing else, and the
 * holder sends only its answer. Neither peer then sends anything newer than the version they
 * agreed on: no new frame, field or enum value. A peer ignores fields it doesn't know and skips
 * replies and events it doesn't know; the holder answers a request it doesn't know with `error`
 * coded `unknown-request`. A request whose body fails its schema is answered `error` coded
 * `invalid`, and its connection closed; any other frame that fails closes it at once.
 *
 * Frozen in every major, because it is how two peers find out what they share: the frame layout,
 * the request id, the type-byte ranges, the `hello` request, the hello reply's `version` and
 * `protocol`, which a client reads before the rest to know which major's schema the rest is in,
 * and `error`.
 */
export const HOLDER_PROTOCOL_VERSION = "1.0";

/**
 * The highest version a peer speaks in each major it supports. Within a major every minor speaks
 * everything older, so one version per major says it all. Frozen, so read leniently: an entry
 * this build can't parse is skipped by `negotiateHolder`, not refused with the frame.
 */
export const HolderVersions = z.array(z.string().max(32)).min(1).max(16);
export type HolderVersions = z.infer<typeof HolderVersions>;

const topMinors = (versions: readonly string[]) => {
  const tops = new Map<number, number>();
  for (const version of versions) {
    if (!ProtocolVersion.safeParse(version).success) continue;
    const [major = -1, minor = -1] = version.split(".").map(Number);
    // A part too long for a safe integer would read as another number, or print as an exponent.
    if (!(Number.isSafeInteger(major) && Number.isSafeInteger(minor))) continue;
    tops.set(major, Math.max(minor, tops.get(major) ?? minor));
  }
  return tops;
};

/**
 * The version two peers both speak: the highest major they share, at the lower of their two
 * minors in it. Null when they share no major, as with a holder older than any major the daemon
 * still serves.
 */
export function negotiateHolder(ours: readonly string[], theirs: readonly string[]): string | null {
  const mine = topMinors(ours);
  const peer = topMinors(theirs);
  const shared = [...mine.keys()].filter((major) => peer.has(major));
  if (shared.length === 0) return null;
  const major = Math.max(...shared);
  return `${major}.${Math.min(mine.get(major) ?? 0, peer.get(major) ?? 0)}`;
}

/**
 * A byte offset in the terminal's output since its generation began. Safe integers only, the
 * same as a binary frame's u64 offset is held to when decoded.
 */
const Offset = z.int().nonnegative();
const Count = z.int().nonnegative();
const Pid = z.int().positive();
/** Epoch seconds, as `ps -o lstart` gives a process's start, so a pid can be checked for reuse. */
const StartTime = z.int().nonnegative();
/** The holder clamps a size it can't use, a zero included, rather than refusing it. */
const Dimension = z.int().min(0).max(0xffff);

export const HolderSize = z.object({ cols: Dimension, rows: Dimension });
export type HolderSize = z.infer<typeof HolderSize>;

/**
 * Whatever the daemon writes beside a terminal so it can rebuild the terminal's links from the
 * holder alone. The holder stores and echoes them and reads none: their meaning is the daemon's.
 */
export const HolderTags = z.record(z.string().min(1).max(64), z.string().max(1024));
export type HolderTags = z.infer<typeof HolderTags>;

/** What a terminal runs. `respawn` replaces it, keeping the terminal, its tags and its size. */
export const HolderProcessSpec = z.object({
  argv: z.array(z.string()).min(1),
  cwd: z.string().min(1),
  env: z.record(z.string(), z.string()),
  generation: Count,
  theme: TuiTheme.optional(),
});
export type HolderProcessSpec = z.infer<typeof HolderProcessSpec>;

/**
 * What a holder reads from its stdin when the daemon starts it: never argv, which `ps` shows. A
 * holder that shares no major with `protocol`, the daemon's versions, exits without starting.
 */
export const HolderSpawnSpec = HolderProcessSpec.extend({
  protocol: HolderVersions,
  terminalId: Id("term"),
  socket: z.string().min(1),
  tags: HolderTags,
  size: HolderSize,
  historyLines: Count.default(HISTORY_LINES),
});
export type HolderSpawnSpec = z.infer<typeof HolderSpawnSpec>;

/**
 * Opens every connection, with the versions the client speaks. The holder answers with the
 * version they agree on, or with `error` coded `no-shared-version` and then closes. `writer` asks
 * for the one slot whose `input` the holder takes; the reply says whether this connection got it.
 */
export const HolderHelloRequest = z.object({
  protocol: HolderVersions,
  writer: z.boolean().optional(),
});
export type HolderHelloRequest = z.infer<typeof HolderHelloRequest>;

/**
 * Output from `from` on. Without it, from the holder's offset as it reads the request, which is
 * the offset of a `snapshot` sent just before it in the same write. An offset belongs to one
 * generation: with `generation`, a subscribe that crossed a respawn is refused `stale-generation`
 * instead of resuming at the same offset of the new child's output.
 */
export const HolderSubscribeRequest = z.object({
  from: Offset.optional(),
  generation: Count.optional(),
});
export type HolderSubscribeRequest = z.infer<typeof HolderSubscribeRequest>;

export const HolderSignalRequest = z.object({ signal: Signal });
export type HolderSignalRequest = z.infer<typeof HolderSignalRequest>;

export const HolderSetTagsRequest = z.object({ tags: HolderTags });
export type HolderSetTagsRequest = z.infer<typeof HolderSetTagsRequest>;

/** Null tells a program that asks nothing of the holder's own. */
export const HolderSetThemeRequest = z.object({ theme: TuiTheme.nullable() });
export type HolderSetThemeRequest = z.infer<typeof HolderSetThemeRequest>;

export const HolderHelloReply = z.object({
  /** The version agreed on, in which both sides speak from here on. */
  version: ProtocolVersion,
  /** Every version the holder speaks, as `bazhen doctor` shows it. */
  protocol: HolderVersions,
  terminalId: Id("term"),
  tags: HolderTags,
  generation: Count,
  holderPid: Pid,
  holderStart: StartTime,
  childPid: Pid,
  childStart: StartTime,
  /** How the child ended; null while it runs. */
  exit: ExitStatus.nullable(),
  size: HolderSize,
  offset: Offset,
  title: z.string(),
  alternate: z.boolean(),
  historyLines: Count,
  writer: z.boolean(),
});
export type HolderHelloReply = z.infer<typeof HolderHelloReply>;

/** Memory per terminal, as `bazhen doctor` shows it. `rss` is null where the OS won't say. */
export const HolderStats = z.object({
  engineBytes: Count,
  rss: Count.nullable(),
  ringBytes: Count,
  historyLines: Count,
});
export type HolderStats = z.infer<typeof HolderStats>;

/**
 * The PTY's foreground group, from its master, with start times. The daemon reads each one's
 * command and cwd itself, after checking the start time against a reused pid.
 */
export const HolderForeground = z.object({
  childPid: Pid,
  childStart: StartTime,
  pgid: Pid,
  pgidStart: StartTime,
});
export type HolderForeground = z.infer<typeof HolderForeground>;

/** The ring no longer holds `[from, to)`: a subscriber that fell that far behind resnapshots. */
export const HolderGap = z.object({ from: Offset, to: Offset });
export type HolderGap = z.infer<typeof HolderGap>;

export const HolderResized = z.object({ offset: Offset, cols: Dimension, rows: Dimension });
export type HolderResized = z.infer<typeof HolderResized>;

export const HolderTitle = z.object({ offset: Offset, text: z.string() });
export type HolderTitle = z.infer<typeof HolderTitle>;

export const HolderAlternate = z.object({ offset: Offset, on: z.boolean() });
export type HolderAlternate = z.infer<typeof HolderAlternate>;

/** The child of `generation` ended. */
export const HolderExited = z.object({ generation: Count, status: ExitStatus });
export type HolderExited = z.infer<typeof HolderExited>;

/**
 * A new child runs on the same PTY. In order, on every connection past `hello`: the rest of the
 * old child's output, its `exited` if it ran until replaced, then this, then the new child's
 * output from offset 0, where a subscription goes on. A reply sent after this one, the
 * respawn's `ok` included, is of the new generation.
 */
export const HolderRespawned = z.object({
  generation: Count,
  childPid: Pid,
  childStart: StartTime,
});
export type HolderRespawned = z.infer<typeof HolderRespawned>;

export const HolderRequestName = z.enum([
  "hello",
  "snapshot",
  "subscribe",
  "input",
  "resize",
  "stats",
  "close",
  "signal",
  "foreground",
  "respawn",
  "set-tags",
  "set-theme",
]);
export type HolderRequestName = z.infer<typeof HolderRequestName>;

/**
 * Each request's type byte. Never renumber one or give it to another request: a type byte means
 * the same in every version. A request with a reply of its own is `0x01`–`0x3f`, so that reply's
 * byte stays below the events; `0x40`–`0x7f` are for requests answered only by `ok` or `error`.
 */
export const HOLDER_REQUEST_CODES = {
  hello: 0x01,
  snapshot: 0x02,
  subscribe: 0x03,
  input: 0x04,
  resize: 0x05,
  stats: 0x06,
  close: 0x07,
  signal: 0x08,
  foreground: 0x09,
  respawn: 0x0a,
  "set-tags": 0x0b,
  "set-theme": 0x0c,
} as const satisfies Record<HolderRequestName, number>;

/** The `request` of `ok` and `error` names the request answered, for logs: its id says which. */
export const HolderOk = z.object({ request: z.string() });
export type HolderOk = z.infer<typeof HolderOk>;

/**
 * The codes `error` carries in this version. A peer meets codes newer than it knows, so `code` is
 * read as a string and an unknown one treated as `failed`.
 */
export const HOLDER_ERROR_CODES = [
  /** The holder doesn't know the request's type. */
  "unknown-request",
  /** `subscribe` named a generation a respawn has since replaced. */
  "stale-generation",
  /** The request's body failed its schema. */
  "invalid",
  /** `hello` found no major both sides speak. */
  "no-shared-version",
  /** `input` from a connection without the writer slot. */
  "not-writer",
  /** `input` past what the holder queues for a program that isn't reading. */
  "input-full",
  /** The request needs a child, and it has exited. */
  "exited",
  /** The holder tried and the system refused, as a respawn that can't start its program. */
  "failed",
] as const;

export const HolderError = z.object({
  request: z.string(),
  code: z.string(),
  message: z.string(),
  /** The holder's versions, with `no-shared-version`, for `bazhen doctor` to show. */
  protocol: HolderVersions.optional(),
});
export type HolderError = z.infer<typeof HolderError>;

/**
 * Each reply's and event's type byte, under the same rule. The ranges say whether a frame carries
 * a request's id, so a peer can tell even of a type it doesn't know: a request's own reply is its
 * type byte with the top bit set (`0x81`–`0xbf`); events, which carry none, are `0xc0`–`0xef`;
 * `ok` and `error`, which answer any request, are `0xf0`–`0xff`.
 */
export const HOLDER_REPLY_CODES = {
  hello: 0x81,
  snapshot: 0x82,
  stats: 0x86,
  foreground: 0x89,
  data: 0xc0,
  gap: 0xc1,
  resized: 0xc2,
  title: 0xc3,
  alternate: 0xc4,
  exited: 0xc5,
  respawned: 0xc6,
  ok: 0xf0,
  error: 0xf1,
} as const;
export type HolderReplyName = keyof typeof HOLDER_REPLY_CODES;

/** The most a frame to a holder may hold, its type byte included. */
export const HOLDER_MAX_REQUEST_BYTES = 1 << 20;

/** The most a frame from a holder may hold: room for a full snapshot of colourful history. */
export const HOLDER_MAX_REPLY_BYTES = 64 << 20;
