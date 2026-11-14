import { z } from "zod";
import { ExitStatus, Signal } from "./agents.ts";
import { Id } from "./ids.ts";
import { HISTORY_LINES } from "./stream.ts";
import { TuiTheme } from "./theme.ts";
import { ProtocolVersion } from "./version.ts";

/**
 * `holder/1`: what the daemon and a `bazhen-holder` say over the holder's Unix socket. Versioned
 * apart from the daemon's protocol, under the same rule: within a major, changes are additive
 * only, and the minor is bumped in the same commit as any addition. A peer ignores fields it
 * doesn't know, skips replies and events it doesn't know, and answers a request it doesn't know
 * with `error`; a client sends nothing newer than the version both sides agreed on.
 */
export const HOLDER_PROTOCOL_VERSION = "1.0";

/**
 * The highest version a peer speaks in each major it supports. Within a major every minor speaks
 * everything older, so one version per major says it all.
 */
export const HolderVersions = z.array(ProtocolVersion).min(1).max(16);
export type HolderVersions = z.infer<typeof HolderVersions>;

const parse = (version: string) => {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return { major, minor };
};

const topMinors = (versions: readonly string[]) => {
  const tops = new Map<number, number>();
  for (const version of versions) {
    if (!ProtocolVersion.safeParse(version).success) continue;
    const { major, minor } = parse(version);
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

/** What a holder reads from its stdin when the daemon starts it: never argv, which `ps` shows. */
export const HolderSpawnSpec = HolderProcessSpec.extend({
  protocol: ProtocolVersion,
  terminalId: Id("term"),
  socket: z.string().min(1),
  tags: HolderTags,
  size: HolderSize,
  historyLines: Count.default(HISTORY_LINES),
});
export type HolderSpawnSpec = z.infer<typeof HolderSpawnSpec>;

/**
 * Opens every connection. `writer` asks for the one slot whose `input` the holder takes; the
 * reply says whether this connection got it.
 */
export const HolderHelloRequest = z.object({
  protocol: HolderVersions,
  writer: z.boolean().optional(),
});
export type HolderHelloRequest = z.infer<typeof HolderHelloRequest>;

/**
 * Output from `from` on. Without it, from the holder's offset as it reads the request, which is
 * the offset of a `snapshot` sent just before it in the same write.
 */
export const HolderSubscribeRequest = z.object({ from: Offset.optional() });
export type HolderSubscribeRequest = z.infer<typeof HolderSubscribeRequest>;

export const HolderSignalRequest = z.object({ signal: Signal });
export type HolderSignalRequest = z.infer<typeof HolderSignalRequest>;

export const HolderSetTagsRequest = z.object({ tags: HolderTags });
export type HolderSetTagsRequest = z.infer<typeof HolderSetTagsRequest>;

/** Null tells a program that asks nothing of the holder's own. */
export const HolderSetThemeRequest = z.object({ theme: TuiTheme.nullable() });
export type HolderSetThemeRequest = z.infer<typeof HolderSetThemeRequest>;

export const HolderHelloReply = z.object({
  protocol: HolderVersions,
  terminalId: Id("term"),
  tags: HolderTags,
  generation: Count,
  holderPid: Pid,
  holderStart: StartTime,
  childPid: Pid,
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

export const HolderExited = z.object({ status: ExitStatus });
export type HolderExited = z.infer<typeof HolderExited>;

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
 * the same in every version.
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

/** What `ok` and `error` answer: a request by name, or one the holder doesn't know. */
const Answered = z.union([HolderRequestName, z.literal("unknown")]);

export const HolderOk = z.object({ request: Answered });
export type HolderOk = z.infer<typeof HolderOk>;

export const HolderError = z.object({ request: Answered, message: z.string() });
export type HolderError = z.infer<typeof HolderError>;

/**
 * Each reply's and event's type byte, under the same rule. A request's own reply is its type
 * byte with the top bit set.
 */
export const HOLDER_REPLY_CODES = {
  hello: 0x81,
  snapshot: 0x82,
  data: 0x83,
  gap: 0x84,
  resized: 0x85,
  stats: 0x86,
  foreground: 0x89,
  title: 0x8a,
  alternate: 0x8b,
  exited: 0x8c,
  ok: 0xf0,
  error: 0xf1,
} as const;
export type HolderReplyName = keyof typeof HOLDER_REPLY_CODES;

/** The most a frame to a holder may hold, its type byte included. */
export const HOLDER_MAX_REQUEST_BYTES = 1 << 20;

/** The most a frame from a holder may hold: room for a full snapshot of colourful history. */
export const HOLDER_MAX_REPLY_BYTES = 64 << 20;
