import { z } from "zod";
import {
  HOLDER_ERROR_CODES,
  HOLDER_MAX_COLS,
  HOLDER_MAX_HISTORY_LINES,
  HOLDER_MAX_REPLY_BYTES,
  HOLDER_MAX_REQUEST_BYTES,
  HOLDER_MAX_ROWS,
  HOLDER_PROTOCOL_VERSION,
  HOLDER_REPLY_CODES,
  HOLDER_REQUEST_CODES,
  HOLDER_RESERVED_ENV_NAMES,
  HOLDER_RESERVED_TAG_NAMES,
  HOLDER_TAG_NAME_MAX_BYTES,
  HOLDER_TAG_VALUE_MAX_BYTES,
  HOLDER_VERSION_MAX_BYTES,
  HolderSpawnSpec,
  HolderVersions,
  hasLoneSurrogate,
  negotiateHolder,
} from "./holder.ts";
import {
  encodeHolderReply,
  encodeHolderRequest,
  type HolderDecoded,
  type HolderReply,
  holderReplyDecoder,
  type HolderRequest,
  holderRequestDecoder,
  type UnknownHolderReply,
  type UnknownHolderRequest,
} from "./holder-frame.ts";
import { parseJson } from "./json.ts";

/*
 * Frames and spawn specs that pin `holder/1` for every other speaker, written by
 * `pnpm schema` to `fixtures/holder/<version>/`. Each outcome is what this codec makes of the
 * input, so another speaker that agrees with every fixture agrees with this codec. Only the
 * current version's directory is written: an older one is what that version's peers really sent,
 * and every later build must still read it.
 */

export const Direction = z.enum(["request", "reply"]);
export type Direction = z.infer<typeof Direction>;

/**
 * A frame as a peer re-encodes it after decoding: the type byte and the binary fields before the
 * body (id, offset, dropped lines) exactly, then the body as a JSON value or as raw bytes. A JSON
 * body is compared as a value: JavaScript writes integer-like keys first, so key order is no part
 * of the contract.
 */
const Canonical = z.object({
  head: z.string(),
  json: z.unknown().optional(),
  bytes: z.string().optional(),
});
export type Canonical = z.infer<typeof Canonical>;

const FrameOutcome = z.union([
  z.object({ canonical: Canonical }),
  z.object({ unknown: z.object({ code: z.int(), id: z.int().optional() }) }),
  z.object({ malformed: z.string() }),
]);
export type FrameOutcome = z.infer<typeof FrameOutcome>;

export const FrameFixtures = z.array(
  z.object({ name: z.string(), direction: Direction, hex: z.string(), outcome: FrameOutcome }),
);
export type FrameFixture = z.infer<typeof FrameFixtures>[number];

const SpawnSpecOutcome = z.union([
  z.object({ canonical: z.unknown() }),
  z.object({ noSharedVersion: z.literal(true) }),
  z.object({ invalid: z.string() }),
]);
export type SpawnSpecOutcome = z.infer<typeof SpawnSpecOutcome>;

export const SpawnSpecFixtures = z.array(
  z.object({ name: z.string(), json: z.string(), outcome: SpawnSpecOutcome }),
);
export type SpawnSpecFixture = z.infer<typeof SpawnSpecFixtures>[number];

export interface NegotiationFixture {
  readonly ours: readonly string[];
  readonly theirs: readonly string[];
  readonly agreed: string | null;
}

export type Intent = "valid" | "unknown" | "malformed";

interface FrameSource {
  readonly name: string;
  readonly direction: Direction;
  readonly bytes: Uint8Array;
  readonly intent: Intent;
}

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const utf8 = (text: string) => new TextEncoder().encode(text);

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

const u32 = (n: number) => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n);
  return out;
};

const u64 = (n: bigint) => {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, n);
  return out;
};

/** A frame whose header claims `length`, whatever follows. */
const header = (length: number, code: number, payload: Uint8Array = new Uint8Array(0)) =>
  concat(u32(length), Uint8Array.of(code), payload);

/** A frame as a peer could send it, valid or not: the header for `payload`, then `payload`. */
const raw = (code: number, payload: Uint8Array) => header(payload.length + 1, code, payload);

/** A request of `code` with id `id` and `body` as its JSON text, which may be anything. */
const rawRequest = (code: number, id: number, body: string) =>
  raw(code, concat(u32(id), utf8(body)));

const rawAnswer = rawRequest;
const rawEvent = (code: number, body: string) => raw(code, utf8(body));

const req = HOLDER_REQUEST_CODES;
const rep = HOLDER_REPLY_CODES;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const U32_MAX = 0xffff_ffff;

const request = (name: string, frame: HolderRequest): FrameSource => ({
  name,
  direction: "request",
  bytes: encodeHolderRequest(frame),
  intent: "valid",
});

const reply = (name: string, frame: HolderReply): FrameSource => ({
  name,
  direction: "reply",
  bytes: encodeHolderReply(frame),
  intent: "valid",
});

const inbound = (name: string, intent: Intent, bytes: Uint8Array): FrameSource => ({
  name,
  direction: "request",
  bytes,
  intent,
});

const outbound = (name: string, intent: Intent, bytes: Uint8Array): FrameSource => ({
  name,
  direction: "reply",
  bytes,
  intent,
});

const TERMINAL = "term_0190a1b2c3d47abc8def0123456789ab";
/** At the byte limit in two-byte characters, so a peer counting characters reads half the bytes. */
const tagName = "é".repeat(HOLDER_TAG_NAME_MAX_BYTES / 2);
const tagValue = "é".repeat(HOLDER_TAG_VALUE_MAX_BYTES / 2);
const longVersion = `1.${"0".repeat(HOLDER_VERSION_MAX_BYTES - 2)}`;
const processSpec = {
  argv: ["claude", "--resume", "日本語"],
  cwd: "/home/u/src",
  env: { TERM: "xterm-256color", "1": "integer-like keys sort first in JavaScript" },
  generation: 4,
};
const helloReply = {
  version: "1.0",
  protocol: ["1.0"],
  terminalId: TERMINAL,
  tags: { kind: "agent", "0": "zero" },
  generation: 2,
  holderPid: 41,
  holderStart: 1_763_000_000,
  childPid: 42,
  childStart: 1_763_000_001,
  exit: null,
  size: { cols: 80, rows: 24 },
  offset: 1234,
  title: "✳ claude",
  alternate: true,
  historyLines: 10_000,
  writer: false,
};

const REQUEST_SOURCES: readonly FrameSource[] = [
  request("hello", { type: "hello", id: 0, body: { protocol: ["1.0"] } }),
  request("hello as writer, two majors", {
    type: "hello",
    id: 1,
    body: { protocol: ["1.0", "2.3"], writer: true },
  }),
  request("hello, sixteen versions at the byte limit", {
    type: "hello",
    id: 2,
    body: { protocol: Array.from({ length: 16 }, (_, i) => (i === 0 ? "1.0" : longVersion)) },
  }),
  request("snapshot, the largest id", { type: "snapshot", id: U32_MAX }),
  request("stats", { type: "stats", id: 3 }),
  request("foreground", { type: "foreground", id: 4 }),
  request("close", { type: "close", id: 5 }),
  request("subscribe from now", { type: "subscribe", id: 6, body: {} }),
  request("subscribe from the largest safe offset", {
    type: "subscribe",
    id: 7,
    body: { from: { generation: 1, offset: MAX_SAFE } },
  }),
  request("input of any bytes", { type: "input", id: 8, bytes: Uint8Array.of(3, 0, 0xff, 0x1b) }),
  request("input of nothing", { type: "input", id: 9, bytes: new Uint8Array(0) }),
  request("resize at the bound", {
    type: "resize",
    id: 10,
    body: { cols: HOLDER_MAX_COLS, rows: HOLDER_MAX_ROWS },
  }),
  request("resize to zero", { type: "resize", id: 11, body: { cols: 0, rows: 0 } }),
  ...(["SIGINT", "SIGTERM", "SIGHUP", "SIGKILL"] as const).map((signal, i) =>
    request(`signal ${signal}`, { type: "signal", id: 12 + i, body: { signal } }),
  ),
  request("respawn", { type: "respawn", id: 16, body: { ...processSpec, theme: "light" } }),
  request("respawn with no theme", { type: "respawn", id: 17, body: processSpec }),
  request("set-tags at the byte limits", {
    type: "set-tags",
    id: 18,
    body: { tags: { [tagName]: tagValue, b: "", "7": "x" } },
  }),
  request("set-tags to none", { type: "set-tags", id: 19, body: { tags: {} } }),
  request("set-theme dark", { type: "set-theme", id: 20, body: { theme: "dark" } }),
  request("set-theme none", { type: "set-theme", id: 21, body: { theme: null } }),

  inbound("unknown request with a reply of its own", "unknown", rawRequest(0x05, 22, "{}")),
  inbound("unknown request without one", "unknown", rawRequest(0x7f, 23, "")),
  inbound(
    "hello with fields from a later minor",
    "valid",
    rawRequest(req.hello, 24, '{"protocol":["1.0"],"later":{"x":1},"writer":false}'),
  ),
  inbound(
    "subscribe with a nested field from a later minor",
    "valid",
    rawRequest(req.subscribe, 25, '{"from":{"generation":0,"offset":5,"later":true}}'),
  ),
  inbound(
    "snapshot with arguments from a later minor",
    "valid",
    rawRequest(req.snapshot, 26, "xy"),
  ),
  inbound(
    "hello sharing no major, the rest unread",
    "valid",
    rawRequest(req.hello, 27, '{"protocol":["2.0"],"writer":"in a schema this build lacks"}'),
  ),
  inbound(
    "hello whose only 1.x minor is past 2^53, so shares no major",
    "valid",
    rawRequest(req.hello, 28, '{"protocol":["1.9007199254740992"],"writer":"unread"}'),
  ),
  inbound(
    "hello listing a version this build can't parse",
    "valid",
    rawRequest(req.hello, 29, '{"protocol":["x","1.0"],"writer":true}'),
  ),

  inbound("a frame of length 0", "malformed", header(0, req.hello)),
  inbound("a frame over the cap", "malformed", header(HOLDER_MAX_REQUEST_BYTES + 1, req.input)),
  inbound("type 0x00", "malformed", rawRequest(0x00, 30, "{}")),
  inbound("type 0x80, a reply's range", "malformed", rawRequest(0x80, 31, "{}")),
  inbound("type 0xc0, an event's", "malformed", rawRequest(0xc0, 32, "{}")),
  inbound("a request with no id", "malformed", raw(req.snapshot, Uint8Array.of(0, 0, 1))),
  inbound("hello not UTF-8", "malformed", raw(req.hello, concat(u32(33), Uint8Array.of(0xff)))),
  inbound("hello not JSON", "malformed", rawRequest(req.hello, 34, "{protocol")),
  inbound("hello with no protocol", "malformed", rawRequest(req.hello, 35, "{}")),
  inbound("hello with no versions", "malformed", rawRequest(req.hello, 36, '{"protocol":[]}')),
  inbound(
    "hello with seventeen versions",
    "malformed",
    rawRequest(req.hello, 37, JSON.stringify({ protocol: Array(17).fill("1.0") })),
  ),
  inbound(
    "hello with a version over the byte limit",
    "malformed",
    rawRequest(req.hello, 38, JSON.stringify({ protocol: [`${longVersion}0`] })),
  ),
  inbound(
    "hello writer null, as optional is never null",
    "malformed",
    rawRequest(req.hello, 39, '{"protocol":["1.0"],"writer":null}'),
  ),
  inbound(
    "hello writer not a boolean",
    "malformed",
    rawRequest(req.hello, 40, '{"protocol":["1.0"],"writer":1}'),
  ),
  inbound(
    "subscribe from past 2^53 - 1",
    "malformed",
    rawRequest(req.subscribe, 41, '{"from":{"generation":0,"offset":9007199254740992}}'),
  ),
  inbound(
    "subscribe from a negative offset",
    "malformed",
    rawRequest(req.subscribe, 42, '{"from":{"generation":0,"offset":-1}}'),
  ),
  inbound(
    "subscribe from a fractional offset",
    "malformed",
    rawRequest(req.subscribe, 43, '{"from":{"generation":0,"offset":1.5}}'),
  ),
  inbound("subscribe from null", "malformed", rawRequest(req.subscribe, 44, '{"from":null}')),
  inbound(
    "subscribe from no generation",
    "malformed",
    rawRequest(req.subscribe, 45, '{"from":{"offset":0}}'),
  ),
  inbound(
    "resize past the bound",
    "malformed",
    rawRequest(req.resize, 46, `{"cols":${HOLDER_MAX_COLS + 1},"rows":1}`),
  ),
  inbound("resize negative", "malformed", rawRequest(req.resize, 47, '{"cols":1,"rows":-1}')),
  inbound("resize with no cols", "malformed", rawRequest(req.resize, 48, '{"rows":1}')),
  inbound("resize body an array", "malformed", rawRequest(req.resize, 49, "[80,24]")),
  inbound(
    "signal not in holder/1",
    "malformed",
    rawRequest(req.signal, 50, '{"signal":"SIGUSR1"}'),
  ),
  inbound(
    "respawn with no argv",
    "malformed",
    rawRequest(req.respawn, 51, JSON.stringify({ ...processSpec, argv: [] })),
  ),
  inbound(
    "respawn with an empty cwd",
    "malformed",
    rawRequest(req.respawn, 52, JSON.stringify({ ...processSpec, cwd: "" })),
  ),
  inbound(
    "respawn with an env value not a string",
    "malformed",
    rawRequest(req.respawn, 53, JSON.stringify({ ...processSpec, env: { A: 1 } })),
  ),
  inbound(
    "respawn with an environment variable named __proto__",
    "malformed",
    rawRequest(req.respawn, 69, `{"argv":["sh"],"cwd":"/","env":{"__proto__":"x"},"generation":0}`),
  ),
  inbound(
    "respawn with an environment variable named constructor",
    "valid",
    rawRequest(
      req.respawn,
      70,
      `{"argv":["sh"],"cwd":"/","env":{"constructor":"x"},"generation":0}`,
    ),
  ),
  inbound(
    "respawn with a negative generation",
    "malformed",
    rawRequest(req.respawn, 54, JSON.stringify({ ...processSpec, generation: -1 })),
  ),
  inbound(
    "respawn theme null, as optional is never null",
    "malformed",
    rawRequest(req.respawn, 55, JSON.stringify({ ...processSpec, theme: null })),
  ),
  inbound(
    "respawn with a lone surrogate in argv",
    "malformed",
    rawRequest(req.respawn, 56, JSON.stringify({ ...processSpec, argv: ["a\ud800"] })),
  ),
  inbound(
    "set-tags with an empty name",
    "malformed",
    rawRequest(req["set-tags"], 57, '{"tags":{"":"x"}}'),
  ),
  inbound(
    "set-tags with a name over the byte limit",
    "malformed",
    rawRequest(req["set-tags"], 58, JSON.stringify({ tags: { [`${tagName}a`]: "" } })),
  ),
  inbound(
    "set-tags with a value over the byte limit",
    "malformed",
    rawRequest(req["set-tags"], 59, JSON.stringify({ tags: { a: `${tagValue}a` } })),
  ),
  ...HOLDER_RESERVED_TAG_NAMES.map((name, i) =>
    inbound(
      `set-tags naming ${name}`,
      "malformed",
      rawRequest(req["set-tags"], 60 + i, `{"tags":{"${name}":"x"}}`),
    ),
  ),
  inbound(
    "set-tags with a value not a string",
    "malformed",
    rawRequest(req["set-tags"], 63, '{"tags":{"a":1}}'),
  ),
  inbound(
    "set-tags with a lone surrogate",
    "malformed",
    rawRequest(req["set-tags"], 64, '{"tags":{"a":"\\udc00"}}'),
  ),
  inbound(
    "hello with a lone surrogate in a field from a later minor",
    "malformed",
    rawRequest(req.hello, 66, '{"protocol":["1.0"],"later":"\\ud800"}'),
  ),
  inbound(
    "hello with a lone surrogate in a key from a later minor",
    "malformed",
    rawRequest(req.hello, 67, '{"protocol":["1.0"],"later":{"\\udbff":1}}'),
  ),
  inbound(
    "hello sharing no major, a lone surrogate in what goes unread",
    "malformed",
    rawRequest(req.hello, 68, '{"protocol":["2.0"],"writer":["\\ud800"]}'),
  ),
  inbound(
    "signal as a one-key object, which zod refuses and serde would read",
    "malformed",
    rawRequest(req.signal, 71, '{"signal":{"SIGINT":null}}'),
  ),
  inbound(
    "set-theme as a one-key object",
    "malformed",
    rawRequest(req["set-theme"], 72, '{"theme":{"dark":null}}'),
  ),
  inbound(
    "respawn with its theme as a one-key object",
    "malformed",
    rawRequest(req.respawn, 73, JSON.stringify({ ...processSpec, theme: { light: null } })),
  ),
  inbound(
    "set-theme with no theme, as nullable is never missing",
    "malformed",
    rawRequest(req["set-theme"], 65, "{}"),
  ),
];

const REPLY_SOURCES: readonly FrameSource[] = [
  reply("hello", { type: "hello", id: 0, body: helloReply }),
  reply("hello of an exited child", {
    type: "hello",
    id: 1,
    body: { ...helloReply, exit: { type: "exited", code: -1 }, writer: true },
  }),
  reply("snapshot at the largest offset", {
    type: "snapshot",
    id: 2,
    offset: MAX_SAFE,
    droppedLines: U32_MAX,
    bytes: utf8("\u001b[H\u001b[2Jhi"),
  }),
  reply("data", { type: "data", offset: 7, bytes: Uint8Array.of(0, 0xff, 0x0a) }),
  reply("data of nothing", { type: "data", offset: 0, bytes: new Uint8Array(0) }),
  reply("gap", { type: "gap", body: { from: 0, to: MAX_SAFE } }),
  reply("resized", { type: "resized", body: { offset: 9, cols: 120, rows: 40 } }),
  reply("title", { type: "title", body: { offset: 10, text: "日本語 \u0007" } }),
  reply("alternate", { type: "alternate", body: { offset: 11, on: false } }),
  reply("exited with a code", {
    type: "exited",
    body: { generation: 0, status: { type: "exited", code: 0 } },
  }),
  reply("exited by a signal", {
    type: "exited",
    body: { generation: 1, status: { type: "signalled", signal: "SIGSEGV" } },
  }),
  reply("exited in a way not known", {
    type: "exited",
    body: { generation: 2, status: { type: "unknown" } },
  }),
  reply("respawned", {
    type: "respawned",
    body: { generation: 3, childPid: 50, childStart: 1_763_000_002 },
  }),
  reply("stats", {
    type: "stats",
    id: 3,
    body: { engineBytes: 1, rss: 2, ringBytes: 3, historyLines: 4 },
  }),
  reply("stats with no rss", {
    type: "stats",
    id: 4,
    body: { engineBytes: 0, rss: null, ringBytes: 0, historyLines: 0 },
  }),
  reply("foreground", {
    type: "foreground",
    id: 5,
    body: { childPid: 42, childStart: 1, pgid: 43, pgidStart: 2 },
  }),
  reply("ok", { type: "ok", id: 6, body: { request: "resize" } }),
  ...HOLDER_ERROR_CODES.map((code, i) =>
    reply(`error ${code}`, {
      type: "error",
      id: 7 + i,
      body: { request: "subscribe", code, message: `refused: ${code}` },
    }),
  ),
  reply("error no-shared-version with the holder's versions", {
    type: "error",
    id: U32_MAX,
    body: { request: "hello", code: "no-shared-version", message: "", protocol: ["2.0"] },
  }),

  outbound(
    "error of a code from a later minor",
    "valid",
    rawAnswer(rep.error, 20, errorBody("later")),
  ),
  outbound("unknown reply to a request", "unknown", rawAnswer(0x85, 21, "{}")),
  outbound("unknown event", "unknown", rawEvent(0xc7, "{}")),
  outbound("unknown event with no payload", "unknown", raw(0xef, new Uint8Array(0))),
  outbound("unknown answer to any request", "unknown", rawAnswer(0xf2, 22, "")),
  outbound(
    "hello with a field from a later minor",
    "valid",
    rawAnswer(rep.hello, 23, JSON.stringify({ ...helloReply, later: [1] })),
  ),

  outbound("a frame of length 0", "malformed", header(0, rep.data)),
  outbound("a frame over the cap", "malformed", header(HOLDER_MAX_REPLY_BYTES + 1, rep.data)),
  outbound("type 0x00", "malformed", rawEvent(0x00, "{}")),
  outbound("type 0x80, below the replies", "malformed", rawAnswer(0x80, 24, "{}")),
  outbound("unknown reply with no id", "malformed", raw(0x85, Uint8Array.of(0, 1))),
  outbound("unknown answer to any with no id", "malformed", raw(0xf2, new Uint8Array(0))),
  outbound("ok with no id", "malformed", raw(rep.ok, Uint8Array.of(0))),
  outbound("data too short for its offset", "malformed", raw(rep.data, new Uint8Array(7))),
  outbound("data past 2^53 - 1", "malformed", raw(rep.data, u64(BigInt(MAX_SAFE) + 1n))),
  outbound(
    "snapshot too short for its dropped lines",
    "malformed",
    raw(rep.snapshot, concat(u32(25), u64(0n), Uint8Array.of(0, 0, 0))),
  ),
  outbound(
    "hello agreeing on a major this build doesn't speak",
    "malformed",
    rawAnswer(rep.hello, 26, JSON.stringify({ ...helloReply, version: "2.0" })),
  ),
  outbound(
    "hello agreeing on no version",
    "malformed",
    rawAnswer(rep.hello, 27, JSON.stringify({ ...helloReply, version: "1" })),
  ),
  outbound(
    "hello with no child pid",
    "malformed",
    rawAnswer(rep.hello, 28, JSON.stringify({ ...helloReply, childPid: undefined })),
  ),
  outbound(
    "hello with pid 0",
    "malformed",
    rawAnswer(rep.hello, 29, JSON.stringify({ ...helloReply, holderPid: 0 })),
  ),
  outbound(
    "hello with no exit, as nullable is never missing",
    "malformed",
    rawAnswer(rep.hello, 30, JSON.stringify({ ...helloReply, exit: undefined })),
  ),
  outbound(
    "hello with a terminal id that isn't a file name",
    "malformed",
    rawAnswer(rep.hello, 31, JSON.stringify({ ...helloReply, terminalId: "../x" })),
  ),
  outbound(
    "stats missing rss, as nullable is never missing",
    "malformed",
    rawAnswer(rep.stats, 32, '{"engineBytes":0,"ringBytes":0,"historyLines":0}'),
  ),
  outbound(
    "exited of a status not in holder/1",
    "malformed",
    rawEvent(rep.exited, '{"generation":0,"status":{"type":"crashed"}}'),
  ),
  outbound("gap from a negative offset", "malformed", rawEvent(rep.gap, '{"from":-1,"to":0}')),
  outbound("error with a code not a string", "malformed", rawAnswer(rep.error, 33, errorBody(1))),
  outbound(
    "an unknown event, its payload unread though it has a lone surrogate",
    "unknown",
    rawEvent(0xc7, '["\\udc00"]'),
  ),
  outbound(
    "exited with a lone surrogate in a field from a later minor",
    "malformed",
    rawEvent(rep.exited, '{"generation":0,"status":{"type":"unknown","later":"\\ud800"}}'),
  ),
  outbound(
    "title with a lone surrogate",
    "malformed",
    rawEvent(rep.title, '{"offset":0,"text":"\\ud800"}'),
  ),
];

function errorBody(code: unknown) {
  return JSON.stringify({ request: "input", code, message: "m" });
}

/** Where each type's body starts, after the type byte, and whether it is JSON. */
const BODY: Record<Direction, Record<string, { at: number; json: boolean }>> = {
  request: {
    hello: { at: 4, json: true },
    snapshot: { at: 4, json: false },
    stats: { at: 4, json: false },
    foreground: { at: 4, json: false },
    close: { at: 4, json: false },
    input: { at: 4, json: false },
    subscribe: { at: 4, json: true },
    resize: { at: 4, json: true },
    signal: { at: 4, json: true },
    respawn: { at: 4, json: true },
    "set-tags": { at: 4, json: true },
    "set-theme": { at: 4, json: true },
  },
  reply: {
    hello: { at: 4, json: true },
    stats: { at: 4, json: true },
    foreground: { at: 4, json: true },
    ok: { at: 4, json: true },
    error: { at: 4, json: true },
    snapshot: { at: 12, json: false },
    data: { at: 8, json: false },
    gap: { at: 0, json: true },
    resized: { at: 0, json: true },
    title: { at: 0, json: true },
    alternate: { at: 0, json: true },
    exited: { at: 0, json: true },
    respawned: { at: 0, json: true },
  },
};

/** A frame's bytes past its length, split as `Canonical` describes. */
function canonical(direction: Direction, type: string, frame: Uint8Array): Canonical {
  const body = BODY[direction][type];
  if (body === undefined) throw new Error(`no body layout for ${direction} ${type}`);
  const rest = frame.subarray(4);
  const head = hex(rest.subarray(0, 1 + body.at));
  const tail = rest.subarray(1 + body.at);
  return body.json
    ? { head, json: parseJson(new TextDecoder().decode(tail)) }
    : { head, bytes: hex(tail) };
}

type Issue = { readonly path?: readonly PropertyKey[]; readonly message?: string };

/** Schema issues as a reviewer checks them against a fixture's name: each path and message. */
const listIssues = (issues: readonly Issue[]) =>
  issues
    .map((issue) => [issue.path?.join("."), issue.message].filter(Boolean).join(": "))
    .join("; ");

/** A decoder's refusal, its schema issues, if any, described without the rest of zod's report. */
function brief(reason: string): string {
  const at = reason.indexOf(": [");
  const issues: unknown = at === -1 ? undefined : parseJson(reason.slice(at + 2));
  return Array.isArray(issues) ? `${reason.slice(0, at)}: ${listIssues(issues)}` : reason;
}

/** The one frame `bytes` hold, or why they were refused. */
function single<F>(name: string, { frames, malformed }: HolderDecoded<F>) {
  if (malformed !== null) return { malformed };
  const [frame, ...more] = frames;
  if (frame === undefined || more.length > 0) {
    throw new Error(`fixture ${name} is ${frames.length} frames, not one`);
  }
  return { frame };
}

interface Judged {
  readonly outcome: FrameOutcome;
  readonly intent: Intent;
}

const refused = (reason: string): Judged => ({
  outcome: { malformed: brief(reason) },
  intent: "malformed",
});

const skipped = ({ code, id }: UnknownHolderRequest | UnknownHolderReply): Judged => ({
  outcome: { unknown: id === undefined ? { code } : { code, id } },
  intent: "unknown",
});

const read = (direction: Direction, type: string, bytes: Uint8Array): Judged => ({
  outcome: { canonical: canonical(direction, type, bytes) },
  intent: "valid",
});

/** What this codec makes of one frame's bytes, read by the decoder for `direction`. */
export function frameOutcome(name: string, direction: Direction, bytes: Uint8Array): Judged {
  if (direction === "request") {
    const decoded = single(name, holderRequestDecoder().push(bytes));
    if ("malformed" in decoded) return refused(decoded.malformed);
    const { frame } = decoded;
    return frame.type === "unknown"
      ? skipped(frame)
      : read(direction, frame.type, encodeHolderRequest(frame));
  }
  const decoded = single(name, holderReplyDecoder().push(bytes));
  if ("malformed" in decoded) return refused(decoded.malformed);
  const { frame } = decoded;
  return frame.type === "unknown"
    ? skipped(frame)
    : read(direction, frame.type, encodeHolderReply(frame));
}

export function frameFixtures(): FrameFixture[] {
  const names = new Set<string>();
  return [...REQUEST_SOURCES, ...REPLY_SOURCES].map((source) => {
    const key = `${source.direction} ${source.name}`;
    if (names.has(key)) throw new Error(`two fixtures are named ${key}`);
    names.add(key);
    const { outcome, intent } = frameOutcome(source.name, source.direction, source.bytes);
    if (intent !== source.intent) {
      throw new Error(
        `fixture ${source.direction} "${source.name}" is ${intent}, not ${source.intent}`,
      );
    }
    return { name: source.name, direction: source.direction, hex: hex(source.bytes), outcome };
  });
}

/**
 * How a holder reads the spec on its stdin: `protocol` first, which is frozen, so a spec from a
 * daemon sharing no major is told apart from an invalid one, and the rest of it left unread.
 */
export function readSpawnSpec(json: string): SpawnSpecOutcome {
  const value = parseJson(json);
  if (hasLoneSurrogate(value)) return { invalid: "a lone surrogate" };
  const frozen = HolderSpawnSpec.pick({ protocol: true }).safeParse(value);
  if (!frozen.success) return { invalid: listIssues(frozen.error.issues) };
  if (negotiateHolder([HOLDER_PROTOCOL_VERSION], frozen.data.protocol) === null) {
    return { noSharedVersion: true };
  }
  const spec = HolderSpawnSpec.safeParse(value);
  return spec.success ? { canonical: spec.data } : { invalid: listIssues(spec.error.issues) };
}

const spawnSpec = {
  protocol: ["1.0"],
  terminalId: TERMINAL,
  socket: "/run/user/1000/bazhen/holders/t.sock",
  tags: { kind: "agent" },
  size: { cols: 80, rows: 24 },
  ...processSpec,
  theme: "dark",
  historyLines: 5000,
};

type SpawnSpecIntent = "canonical" | "noSharedVersion" | "invalid";

const spec = (name: string, value: unknown, intent: SpawnSpecIntent) => ({
  name,
  json: JSON.stringify(value),
  intent,
});

const SPAWN_SPEC_SOURCES = [
  spec("every field", spawnSpec, "canonical"),
  spec(
    "no theme or history, which defaults",
    { ...spawnSpec, theme: undefined, historyLines: undefined },
    "canonical",
  ),
  spec(
    "history at the bound, two majors",
    { ...spawnSpec, protocol: ["0.3", "1.0"], historyLines: HOLDER_MAX_HISTORY_LINES },
    "canonical",
  ),
  spec("a field from a later minor", { ...spawnSpec, later: 1 }, "canonical"),
  spec(
    "sharing no major, the rest unread",
    { ...spawnSpec, protocol: ["2.0"], argv: [] },
    "noSharedVersion",
  ),
  spec("no protocol", { ...spawnSpec, protocol: undefined }, "invalid"),
  spec("not an object", [spawnSpec], "invalid"),
  { name: "not JSON", json: "{", intent: "invalid" as const },
  spec(
    "history past the bound",
    { ...spawnSpec, historyLines: HOLDER_MAX_HISTORY_LINES + 1 },
    "invalid",
  ),
  spec("a terminal id with a slash", { ...spawnSpec, terminalId: "a/b" }, "invalid"),
  spec("a terminal id of 65 characters", { ...spawnSpec, terminalId: "a".repeat(65) }, "invalid"),
  spec("an empty socket", { ...spawnSpec, socket: "" }, "invalid"),
  spec(
    "a size past the bound",
    { ...spawnSpec, size: { cols: 80, rows: HOLDER_MAX_ROWS + 1 } },
    "invalid",
  ),
  spec("a reserved tag", { ...spawnSpec, tags: { prototype: "" } }, "invalid"),
  spec("theme null", { ...spawnSpec, theme: null }, "invalid"),
  spec("theme as a one-key object", { ...spawnSpec, theme: { dark: null } }, "invalid"),
  spec("a lone surrogate in env", { ...spawnSpec, env: { A: "\udfff" } }, "invalid"),
  spec(
    "a lone surrogate in a field from a later minor",
    { ...spawnSpec, later: "\ud800" },
    "invalid",
  ),
  spec(
    "a lone surrogate in a key from a later minor",
    { ...spawnSpec, later: { "\udbff": 1 } },
    "invalid",
  ),
  spec(
    "sharing no major, a lone surrogate in what goes unread",
    { ...spawnSpec, protocol: ["2.0"], later: "\ud800" },
    "invalid",
  ),
];

export function spawnSpecFixtures(): SpawnSpecFixture[] {
  return SPAWN_SPEC_SOURCES.map(({ name, json, intent }) => {
    const outcome = readSpawnSpec(json);
    if (!(intent in outcome)) throw new Error(`spawn spec fixture "${name}" is not ${intent}`);
    return { name, json, outcome };
  });
}

const NEGOTIATIONS: readonly (readonly [readonly string[], readonly string[]])[] = [
  [["1.4"], ["1.2"]],
  [["1.2"], ["1.4"]],
  [
    ["1.0", "2.3"],
    ["2.1", "3.0"],
  ],
  [["1.0", "1.5"], ["1.9"]],
  [["1.0"], ["2.0"]],
  [["1.0"], ["x", "1", "1.0.0", "-1.0", "1.0"]],
  [["1.0"], ["01.07"]],
  [["1.0"], ["1.9007199254740992"]],
  [["9007199254740992.0"], ["9007199254740992.0"]],
  [["1.10"], ["1.9"]],
];

export function negotiationFixtures(): NegotiationFixture[] {
  return NEGOTIATIONS.map(([ours, theirs]) => {
    for (const versions of [ours, theirs]) HolderVersions.parse(versions);
    return { ours, theirs, agreed: negotiateHolder(ours, theirs) };
  });
}

/** Every limit and code a peer must share, under the names a reader of `holder.ts` knows. */
export function holderConstants() {
  return {
    HOLDER_PROTOCOL_VERSION,
    HOLDER_VERSION_MAX_BYTES,
    HOLDER_TAG_NAME_MAX_BYTES,
    HOLDER_TAG_VALUE_MAX_BYTES,
    HOLDER_RESERVED_TAG_NAMES,
    HOLDER_RESERVED_ENV_NAMES,
    HOLDER_MAX_COLS,
    HOLDER_MAX_ROWS,
    HOLDER_MAX_HISTORY_LINES,
    HOLDER_DEFAULT_HISTORY_LINES: HolderSpawnSpec.shape.historyLines.parse(undefined),
    HOLDER_MAX_REQUEST_BYTES,
    HOLDER_MAX_REPLY_BYTES,
    HOLDER_REQUEST_CODES,
    HOLDER_REPLY_CODES,
    HOLDER_ERROR_CODES,
  };
}

const file = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** The current version's fixture files, keyed by file name. */
export function holderFixtures(): Record<string, string> {
  return {
    "constants.json": file(holderConstants()),
    "frames.json": file(frameFixtures()),
    "negotiation.json": file(negotiationFixtures()),
    "spawn-specs.json": file(spawnSpecFixtures()),
  };
}
