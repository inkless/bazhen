import { z } from "zod";
import { ProtocolVersion } from "./version.ts";

/**
 * `holder/1`: what the daemon and a `bazhen-holder` say over the holder's Unix socket. Versioned
 * apart from the daemon's protocol, under the same rule: within a major, changes are additive
 * only, and the minor is bumped in the same commit as any addition. It defines its own enums
 * rather than the daemon protocol's, so that one's minor can't change this one's.
 *
 * A connection opens with `hello`: until it is answered the client sends nothing else, and the
 * holder sends only its answer. A first frame that isn't `hello`, or a second `hello`, is answered
 * `invalid`. Neither peer then sends anything newer than the version they agreed on: no new
 * frame, field or enum value. A peer ignores fields it doesn't know and skips replies and events
 * it doesn't know; the holder answers a request type in its range that it doesn't know with
 * `error` coded `unknown-request`, whose `request` is the type byte, as `0x2a`. A request whose
 * body isn't UTF-8 JSON that passes its schema is answered `error` coded `invalid`, and its
 * connection closed; any other frame that fails, a type byte outside the requests' range
 * included, closes it at once. String limits count UTF-8 bytes.
 *
 * Frozen in every major, because it is how two peers find out what they share:
 * - the frame layout, the u32 request id and the type-byte ranges;
 * - the rule that nothing but `hello` and its answer passes before `hello` is answered;
 * - the `hello` request's `protocol`, the hello reply's `version` and `protocol`, and the spawn
 *   spec's `protocol`. Each side reads these first; the rest of a `hello` is read in the schema
 *   of the agreed version's major. A client can't know which of its majors the holder will
 *   agree on, so the rest of its `hello` must satisfy the schema of every major it lists;
 * - `error`, and its codes `no-shared-version` and `invalid`.
 */
export const HOLDER_PROTOCOL_VERSION = "1.0";

/** Byte limits, in UTF-8 bytes, that both peers enforce on strings. */
export const HOLDER_VERSION_MAX_BYTES = 32;
export const HOLDER_TAG_NAME_MAX_BYTES = 64;
export const HOLDER_TAG_VALUE_MAX_BYTES = 1024;

/** Bounds that keep a terminal's snapshot within the reply cap in all but the worst cases. */
export const HOLDER_MAX_COLS = 1000;
export const HOLDER_MAX_ROWS = 1000;
export const HOLDER_MAX_HISTORY_LINES = 100_000;

/**
 * The highest version a peer speaks in each major it supports. Within a major every minor speaks
 * everything older, so one version per major says it all. Frozen, so read leniently: an entry
 * this build can't parse is skipped by `negotiateHolder`, not refused with the frame.
 */
export const HolderVersions = z.array(utf8(HOLDER_VERSION_MAX_BYTES)).min(1).max(16);
export type HolderVersions = z.infer<typeof HolderVersions>;

/**
 * In a `u` regex a surrogate pair is one code point, so only a half on its own matches. Not
 * `isWellFormed()`: the web bundle targets browsers that predate it.
 */
const LONE_SURROGATE = /\p{Cs}/u;

/**
 * Any string a peer in another language can hold: one with a lone surrogate, which JSON can carry
 * and UTF-8 can't, is refused, the same by every peer.
 */
function wellFormed() {
  return z.string().refine((value) => !LONE_SURROGATE.test(value), "a lone surrogate");
}

/**
 * A string of at most `max` UTF-8 bytes, as a Rust peer measures it. JSON Schema can only count
 * characters, so the published schema states the limit in its description instead of a
 * `maxLength` a peer would read as characters.
 */
function utf8(max: number, min = 0) {
  const encoder = new TextEncoder();
  return wellFormed()
    .min(min)
    .refine((text) => encoder.encode(text).length <= max, `at most ${max} UTF-8 bytes`)
    .describe(`At most ${max} UTF-8 bytes.`);
}

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
/** Up to the maximum; the holder clamps a size too small to use, a zero included. */
const Cols = z.int().min(0).max(HOLDER_MAX_COLS);
const Rows = z.int().min(0).max(HOLDER_MAX_ROWS);

export const HolderSize = z.object({ cols: Cols, rows: Rows });
export type HolderSize = z.infer<typeof HolderSize>;

export const HOLDER_RESERVED_TAG_NAMES = ["__proto__", "constructor", "prototype"] as const;

/**
 * Whatever the daemon writes beside a terminal so it can rebuild the terminal's links from the
 * holder alone. The holder stores and echoes them and reads none: their meaning is the daemon's.
 */
export const HolderTags = z
  .preprocess(
    (tags, ctx) => {
      // Dropped without a word by a JavaScript record, and a trap for any peer that reads tags
      // into a plain object: refused instead, the same by every peer.
      for (const name of HOLDER_RESERVED_TAG_NAMES) {
        if (typeof tags === "object" && tags !== null && Object.hasOwn(tags, name)) {
          ctx.addIssue({ code: "custom", message: `tag name ${name} is reserved` });
        }
      }
      return tags;
    },
    z.record(utf8(HOLDER_TAG_NAME_MAX_BYTES, 1), utf8(HOLDER_TAG_VALUE_MAX_BYTES)),
  )
  .describe(`Tag names ${HOLDER_RESERVED_TAG_NAMES.join(", ")} are refused.`);
export type HolderTags = z.infer<typeof HolderTags>;

export const HolderSignal = z.enum(["SIGINT", "SIGTERM", "SIGHUP", "SIGKILL"]);
export type HolderSignal = z.infer<typeof HolderSignal>;

/** The background a program is told it is drawn on, when it asks. */
export const HolderTheme = z.enum(["light", "dark"]);
export type HolderTheme = z.infer<typeof HolderTheme>;

/** How a child ended: with a code, by a signal named as in `SIGTERM`, or in a way not known. */
export const HolderExitStatus = z.discriminatedUnion("type", [
  z.object({ type: z.literal("exited"), code: z.int() }),
  z.object({ type: z.literal("signalled"), signal: wellFormed() }),
  z.object({ type: z.literal("unknown") }),
]);
export type HolderExitStatus = z.infer<typeof HolderExitStatus>;

/** Names the holder's socket file, so it stays a plain file name. */
const TerminalId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

/**
 * What a terminal runs. `respawn` replaces it, keeping the terminal, its tags and its size; its
 * `generation` must be above the current one, or the respawn is refused `stale-generation`.
 */
export const HolderProcessSpec = z.object({
  argv: z.array(wellFormed()).min(1),
  cwd: wellFormed().min(1),
  env: z.record(wellFormed(), wellFormed()),
  generation: Count,
  theme: HolderTheme.optional(),
});
export type HolderProcessSpec = z.infer<typeof HolderProcessSpec>;

/**
 * What a holder reads from its stdin when the daemon starts it: never argv, which `ps` shows. A
 * holder that shares no major with `protocol`, the daemon's versions, exits without starting.
 */
export const HolderSpawnSpec = HolderProcessSpec.extend({
  protocol: HolderVersions,
  terminalId: TerminalId,
  socket: wellFormed().min(1),
  tags: HolderTags,
  size: HolderSize,
  historyLines: Count.max(HOLDER_MAX_HISTORY_LINES).default(10_000),
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

/** What every major reads of a `hello` request, before it knows which major the rest is in. */
export const HolderHelloFrozen = HolderHelloRequest.pick({ protocol: true });
export type HolderHelloRequest = z.infer<typeof HolderHelloRequest>;

/**
 * Output from `from` on. Without it, from the holder's offset as it reads the request, which is
 * the offset of a `snapshot` sent just before it in the same write. An offset means something
 * only in its generation, so `from` names both: one that crossed a respawn is refused
 * `stale-generation` rather than resuming at that offset of the new child's output. A `from` the
 * ring no longer holds is answered `ok`, then `gap` up to what it holds, then output; one past
 * the holder's offset is refused `out-of-range`. A connection has one subscription: subscribing
 * again moves it.
 */
export const HolderSubscribeRequest = z.object({
  from: z.object({ generation: Count, offset: Offset }).optional(),
});
export type HolderSubscribeRequest = z.infer<typeof HolderSubscribeRequest>;

/** Sent to the child's process group, which the child leads, not to the PTY's foreground group. */
export const HolderSignalRequest = z.object({ signal: HolderSignal });
export type HolderSignalRequest = z.infer<typeof HolderSignalRequest>;

export const HolderSetTagsRequest = z.object({ tags: HolderTags });
export type HolderSetTagsRequest = z.infer<typeof HolderSetTagsRequest>;

/** Null tells a program that asks nothing of the holder's own. */
export const HolderSetThemeRequest = z.object({ theme: HolderTheme.nullable() });
export type HolderSetThemeRequest = z.infer<typeof HolderSetThemeRequest>;

export const HolderHelloReply = z.object({
  /** The version agreed on, in which both sides speak from here on. */
  version: ProtocolVersion,
  /** Every version the holder speaks, as `bazhen doctor` shows it. */
  protocol: HolderVersions,
  terminalId: TerminalId,
  tags: HolderTags,
  generation: Count,
  holderPid: Pid,
  holderStart: StartTime,
  childPid: Pid,
  childStart: StartTime,
  /** How the child ended; null while it runs. */
  exit: HolderExitStatus.nullable(),
  size: HolderSize,
  offset: Offset,
  title: wellFormed(),
  alternate: z.boolean(),
  historyLines: Count,
  writer: z.boolean(),
});
export type HolderHelloReply = z.infer<typeof HolderHelloReply>;

/** What every major reads of a hello reply first, to know which major's schema the rest is in. */
export const HolderHelloReplyFrozen = HolderHelloReply.pick({ version: true, protocol: true });

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

export const HolderResized = z.object({ offset: Offset, cols: Cols, rows: Rows });
export type HolderResized = z.infer<typeof HolderResized>;

export const HolderTitle = z.object({ offset: Offset, text: wellFormed() });
export type HolderTitle = z.infer<typeof HolderTitle>;

export const HolderAlternate = z.object({ offset: Offset, on: z.boolean() });
export type HolderAlternate = z.infer<typeof HolderAlternate>;

/** The child of `generation` ended. */
export const HolderExited = z.object({ generation: Count, status: HolderExitStatus });
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
 * byte stays below the events; a request without one is `0x40`–`0x7f`.
 *
 * Every request gets one answer under its id, except `input`, which gets one only when refused:
 * - `hello`, `snapshot`, `stats`, `foreground`: their own reply, or `error`;
 * - `subscribe`, `resize`, `signal`, `respawn`, `set-tags`, `set-theme`: `ok`, or `error`;
 * - `input`: nothing, or `error` (`not-writer`, `input-full`);
 * - `close`: `ok`; then the holder hangs up the child's process group, kills it if it outlives a
 *   grace period, removes its socket and exits, ending every connection.
 */
export const HOLDER_REQUEST_CODES = {
  hello: 0x01,
  snapshot: 0x02,
  stats: 0x03,
  foreground: 0x04,
  subscribe: 0x40,
  input: 0x41,
  resize: 0x42,
  close: 0x43,
  signal: 0x44,
  respawn: 0x45,
  "set-tags": 0x46,
  "set-theme": 0x47,
} as const satisfies Record<HolderRequestName, number>;

/** The `request` of `ok` and `error` names the request answered, for logs: its id says which. */
export const HolderOk = z.object({ request: wellFormed() });
export type HolderOk = z.infer<typeof HolderOk>;

/**
 * The codes `error` carries in this version. A peer meets codes newer than it knows, so `code` is
 * read as a string and an unknown one treated as `failed`.
 */
export const HOLDER_ERROR_CODES = [
  /** The holder doesn't know the request's type. */
  "unknown-request",
  /**
   * A generation that isn't current: a `subscribe` that crossed a respawn, or a `respawn` not
   * above the current one.
   */
  "stale-generation",
  /** `subscribe` from past the holder's offset. */
  "out-of-range",
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
  /** A snapshot over the reply cap even with all its history left out. */
  "snapshot-too-large",
  /** The holder tried and the system refused, as a respawn that can't start its program. */
  "failed",
] as const;

export const HolderError = z.object({
  request: wellFormed(),
  code: wellFormed(),
  message: wellFormed(),
  /** The holder's versions, with `no-shared-version`, for `bazhen doctor` to show. */
  protocol: HolderVersions.optional(),
});
export type HolderError = z.infer<typeof HolderError>;

/**
 * Each reply's and event's type byte, under the same rule. `data` and `gap` go to the connection
 * subscribed; the other events to every connection past `hello`. The ranges say whether a frame carries
 * a request's id, so a peer can tell even of a type it doesn't know: a request's own reply is its
 * type byte with the top bit set (`0x81`–`0xbf`); events, which carry none, are `0xc0`–`0xef`;
 * `ok` and `error`, which answer any request, are `0xf0`–`0xff`.
 */
export const HOLDER_REPLY_CODES = {
  hello: 0x81,
  snapshot: 0x82,
  stats: 0x83,
  foreground: 0x84,
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

/**
 * The most a frame from a holder may hold. A snapshot that would be larger drops its oldest
 * history lines until it fits, and says how many it dropped; one too large with no history at
 * all is answered `error` coded `snapshot-too-large`.
 */
export const HOLDER_MAX_REPLY_BYTES = 64 << 20;
