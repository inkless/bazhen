import type { z } from "zod";
import {
  HOLDER_MAX_REPLY_BYTES,
  HOLDER_PROTOCOL_VERSION,
  HOLDER_MAX_REQUEST_BYTES,
  HOLDER_REPLY_CODES,
  HOLDER_REQUEST_CODES,
  HolderAlternate,
  HolderError,
  HolderExited,
  HolderForeground,
  HolderGap,
  HolderHelloFrozen,
  HolderHelloReply,
  HolderHelloReplyFrozen,
  HolderHelloRequest,
  HolderOk,
  HolderProcessSpec,
  type HolderReplyName,
  type HolderRequestName,
  HolderResized,
  HolderRespawned,
  HolderSetTagsRequest,
  HolderSetThemeRequest,
  HolderSignalRequest,
  HolderSize,
  HolderStats,
  HolderSubscribeRequest,
  HolderTitle,
  hasLoneSurrogate,
  negotiateHolder,
} from "./holder.ts";
import { parseJson } from "./json.ts";

/*
 * A frame is a u32 big-endian length, then a type byte, then the payload; the length counts the
 * type byte and the payload. A request's payload, and a reply's to a request, starts with the
 * request's u32 id. The layout holds in every major (see `HOLDER_PROTOCOL_VERSION`).
 */

type NoFields = object;
interface Bytes {
  readonly bytes: Uint8Array;
}
interface AtOffset {
  readonly offset: number;
  readonly bytes: Uint8Array;
}
interface Body<T> {
  readonly body: T;
}
interface Answer {
  readonly id: number;
}

interface RequestFields {
  hello: Body<HolderHelloRequest>;
  snapshot: NoFields;
  subscribe: Body<HolderSubscribeRequest>;
  input: Bytes;
  resize: Body<HolderSize>;
  stats: NoFields;
  close: NoFields;
  signal: Body<HolderSignalRequest>;
  foreground: NoFields;
  respawn: Body<HolderProcessSpec>;
  "set-tags": Body<HolderSetTagsRequest>;
  "set-theme": Body<HolderSetThemeRequest>;
}

interface ReplyFields {
  hello: Answer & Body<HolderHelloReply>;
  snapshot: Answer & Snapshot;
  data: AtOffset;
  gap: Body<HolderGap>;
  resized: Body<HolderResized>;
  stats: Answer & Body<HolderStats>;
  foreground: Answer & Body<HolderForeground>;
  title: Body<HolderTitle>;
  alternate: Body<HolderAlternate>;
  exited: Body<HolderExited>;
  respawned: Body<HolderRespawned>;
  ok: Answer & Body<HolderOk>;
  error: Answer & Body<HolderError>;
}

type RequestOf<K extends HolderRequestName> = {
  [P in K]: { readonly type: P; readonly id: number } & RequestFields[P];
}[K];
type ReplyOf<K extends HolderReplyName> = {
  [P in K]: { readonly type: P } & ReplyFields[P];
}[K];

export type HolderRequest = RequestOf<HolderRequestName>;
export type HolderReply = ReplyOf<HolderReplyName>;

/** A request of a type this build doesn't know. The holder answers it with `error`, by its id. */
export interface UnknownHolderRequest {
  readonly type: "unknown";
  readonly code: number;
  readonly id: number;
}

/**
 * A reply or event of a type this build doesn't know, from a newer peer: skip it. Its type byte
 * says whether it answers a request, and so whether it has an id.
 */
export interface UnknownHolderReply {
  readonly type: "unknown";
  readonly code: number;
  readonly id?: number;
}

/** A frame that can't be encoded as given: its fields fail their schema, or it is over the cap. */
export class InvalidHolderFrame extends Error {
  readonly type: string;

  constructor(type: string, message: string, options?: ErrorOptions) {
    super(`holder frame ${type}: ${message}`, options);
    this.type = type;
  }
}

/** Why a frame was refused. The decoder that met it decodes nothing more. */
class Malformed {
  readonly malformed: string;

  constructor(reason: string) {
    this.malformed = reason;
  }
}

const malformed = (reason: string) => new Malformed(reason);

/** By class, not shape: a peer's JSON may well carry a field named `malformed`. */
function isMalformed(value: unknown): value is Malformed {
  return value instanceof Malformed;
}

const HEADER = 4;
const ID = 4;
const OFFSET = 8;
const DROPPED = 4;
const U32_MAX = 0xffff_ffff;
const LAST_REQUEST = 0x7f;
const FIRST_REPLY = 0x81;
const FIRST_EVENT = 0xc0;
const FIRST_ANSWER_TO_ANY = 0xf0;

/** How one type's fields become a payload and back. Encoding throws; decoding reports. */
interface Codec<F> {
  readonly encode: (type: string, fields: F) => Uint8Array;
  readonly decode: (type: string, payload: Uint8Array) => F | Malformed;
}

const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

const concat = (head: Uint8Array, tail: Uint8Array) => {
  const out = new Uint8Array(head.length + tail.length);
  out.set(head);
  out.set(tail, head.length);
  return out;
};

const empty: Codec<NoFields> = {
  encode: () => new Uint8Array(0),
  // Trailing bytes are ignored, so a later minor may give a bodiless frame arguments.
  decode: () => ({}),
};

const raw: Codec<Bytes> = {
  encode: (_, { bytes }) => bytes,
  decode: (_, bytes) => ({ bytes }),
};

const atOffset: Codec<AtOffset> = {
  encode: (type, { offset, bytes }) => {
    if (!(Number.isSafeInteger(offset) && offset >= 0)) {
      throw new InvalidHolderFrame(type, `offset ${offset} is not a safe nonnegative integer`);
    }
    const head = new Uint8Array(OFFSET);
    view(head).setBigUint64(0, BigInt(offset));
    return concat(head, bytes);
  },
  decode: (type, payload) => {
    if (payload.length < OFFSET) return malformed(`${type} is too short for its offset`);
    const offset = view(payload).getBigUint64(0);
    if (offset > BigInt(Number.MAX_SAFE_INTEGER)) {
      return malformed(`${type} offset ${offset} is past 2^53 - 1`);
    }
    return { offset: Number(offset), bytes: payload.subarray(OFFSET) };
  },
};

/** A snapshot: its offset, how many of the oldest history lines it left out to fit the cap. */
interface Snapshot extends AtOffset {
  readonly droppedLines: number;
}

const snapshot: Codec<Snapshot> = {
  encode: (type, { offset, droppedLines, bytes }) => {
    const dropped = checkU32(type, "droppedLines", droppedLines);
    return concat(atOffset.encode(type, { offset, bytes: dropped }), bytes);
  },
  decode: (type, payload) => {
    const at = atOffset.decode(type, payload);
    if (isMalformed(at)) return at;
    if (at.bytes.length < DROPPED) return malformed(`${type} is too short for its dropped lines`);
    const droppedLines = view(at.bytes).getUint32(0);
    return { offset: at.offset, droppedLines, bytes: at.bytes.subarray(DROPPED) };
  },
};

function readJson(type: string, payload: Uint8Array): unknown {
  let value: unknown;
  try {
    value = parseJson(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(payload));
  } catch {
    return malformed(`${type} is not UTF-8`);
  }
  return hasLoneSurrogate(value) ? malformed(`${type} has a lone surrogate`) : value;
}

function parseBody<T>(type: string, schema: z.ZodType<T>, value: unknown): Body<T> | Malformed {
  const parsed = schema.safeParse(value);
  return parsed.success ? { body: parsed.data } : malformed(`${type}: ${parsed.error.message}`);
}

const json = <T>(schema: z.ZodType<T>): Codec<Body<T>> => ({
  encode: (type, { body }) => {
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new InvalidHolderFrame(type, parsed.error.message, { cause: parsed.error });
    }
    return new TextEncoder().encode(JSON.stringify(parsed.data));
  },
  decode: (type, payload) => {
    const value = readJson(type, payload);
    return isMalformed(value) ? value : parseBody(type, schema, value);
  },
});

/** The versions this build speaks. */
const SPOKEN = [HOLDER_PROTOCOL_VERSION];

/**
 * A `hello` request read as every major reads it: the frozen `protocol` first. A client this
 * build shares no major with gets `no-shared-version`, so the rest of its hello, in a schema
 * this build doesn't know, is left unread rather than refused.
 */
const helloRequest: Codec<Body<HolderHelloRequest>> = {
  encode: json(HolderHelloRequest).encode,
  decode: (type, payload) => {
    const value = readJson(type, payload);
    if (isMalformed(value)) return value;
    const frozen = parseBody(type, HolderHelloFrozen, value);
    if (isMalformed(frozen) || negotiateHolder(SPOKEN, frozen.body.protocol) === null)
      return frozen;
    return parseBody(type, HolderHelloRequest, value);
  },
};

/** A hello reply: its frozen `version` first, which says which major's schema the rest is in. */
const helloReply: Codec<Body<HolderHelloReply>> = {
  encode: json(HolderHelloReply).encode,
  decode: (type, payload) => {
    const value = readJson(type, payload);
    if (isMalformed(value)) return value;
    const frozen = parseBody(type, HolderHelloReplyFrozen, value);
    if (isMalformed(frozen)) return frozen;
    if (negotiateHolder(SPOKEN, [frozen.body.version]) === null) {
      return malformed(
        `${type} agrees on ${frozen.body.version}, a major this build doesn't speak`,
      );
    }
    return parseBody(type, HolderHelloReply, value);
  },
};

const u32 = (n: number) => {
  const out = new Uint8Array(ID);
  view(out).setUint32(0, n);
  return out;
};

function checkU32(type: string, name: string, n: number) {
  if (!(Number.isInteger(n) && n >= 0 && n <= U32_MAX)) {
    throw new InvalidHolderFrame(type, `${name} ${n} is not a u32`);
  }
  return u32(n);
}

const checkId = (type: string, id: number) => checkU32(type, "id", id);

/** A reply to a request: the request's id, then the reply's own fields. */
const answering = <F>(codec: Codec<F>): Codec<Answer & F> => ({
  encode: (type, fields) => concat(checkId(type, fields.id), codec.encode(type, fields)),
  decode: (type, payload) => {
    if (payload.length < ID) return malformed(`${type} has no id`);
    const fields = codec.decode(type, payload.subarray(ID));
    return isMalformed(fields) ? fields : { ...fields, id: view(payload).getUint32(0) };
  },
});

const REQUESTS: { readonly [K in HolderRequestName]: Codec<RequestFields[K]> } = {
  hello: helloRequest,
  snapshot: empty,
  subscribe: json(HolderSubscribeRequest),
  input: raw,
  resize: json(HolderSize),
  stats: empty,
  close: empty,
  signal: json(HolderSignalRequest),
  foreground: empty,
  respawn: json(HolderProcessSpec),
  "set-tags": json(HolderSetTagsRequest),
  "set-theme": json(HolderSetThemeRequest),
};

const REPLIES: { readonly [K in HolderReplyName]: Codec<ReplyFields[K]> } = {
  hello: answering(helloReply),
  snapshot: answering(snapshot),
  data: atOffset,
  gap: json(HolderGap),
  resized: json(HolderResized),
  stats: answering(json(HolderStats)),
  foreground: answering(json(HolderForeground)),
  title: json(HolderTitle),
  alternate: json(HolderAlternate),
  exited: json(HolderExited),
  respawned: json(HolderRespawned),
  ok: answering(json(HolderOk)),
  error: answering(json(HolderError)),
};

function frame(type: string, code: number, payload: Uint8Array, max: number): Uint8Array {
  const length = 1 + payload.length;
  if (length > max) throw new InvalidHolderFrame(type, `${length} bytes is over the ${max} cap`);
  const out = new Uint8Array(HEADER + length);
  view(out).setUint32(0, length);
  out[HEADER] = code;
  out.set(payload, HEADER + 1);
  return out;
}

function requestPayload<K extends HolderRequestName>(type: K, fields: RequestFields[K]) {
  return REQUESTS[type].encode(type, fields);
}

function replyPayload<K extends HolderReplyName>(type: K, fields: ReplyFields[K]) {
  return REPLIES[type].encode(type, fields);
}

export function encodeHolderRequest(request: HolderRequest): Uint8Array {
  const payload = concat(checkId(request.type, request.id), requestPayload(request.type, request));
  return frame(request.type, HOLDER_REQUEST_CODES[request.type], payload, HOLDER_MAX_REQUEST_BYTES);
}

export function encodeHolderReply(reply: HolderReply): Uint8Array {
  const payload = replyPayload(reply.type, reply);
  return frame(reply.type, HOLDER_REPLY_CODES[reply.type], payload, HOLDER_MAX_REPLY_BYTES);
}

function decodeRequest<K extends HolderRequestName>(
  type: K,
  id: number,
  body: Uint8Array,
): RequestOf<K> | Malformed {
  const fields = REQUESTS[type].decode(type, body);
  return isMalformed(fields) ? fields : { ...fields, type, id };
}

function decodeReply<K extends HolderReplyName>(
  type: K,
  payload: Uint8Array,
): ReplyOf<K> | Malformed {
  const fields = REPLIES[type].decode(type, payload);
  return isMalformed(fields) ? fields : { ...fields, type };
}

const byCode = <K extends string>(codes: Readonly<Record<K, number>>) =>
  new Map(Object.entries<number>(codes).map(([type, code]) => [code, type]));

export interface HolderDecoded<F> {
  /** The frames completed by this chunk and those before it, in order. */
  readonly frames: readonly F[];
  /**
   * Set once a frame is malformed: its connection can't be trusted to be in step any more, so
   * the caller closes it.
   */
  readonly malformed: string | null;
}

/** Turns one connection's bytes, in whatever chunks they arrive, back into frames. */
export class HolderFrameDecoder<F> {
  private readonly chunks: Uint8Array[] = [];
  private buffered = 0;
  private refused: string | null = null;
  private readonly max: number;
  private readonly decodeFrame: (code: number, payload: Uint8Array) => F | Malformed;

  constructor(max: number, decodeFrame: (code: number, payload: Uint8Array) => F | Malformed) {
    this.max = max;
    this.decodeFrame = decodeFrame;
  }

  /**
   * The bytes of a decoded frame may be a view into `chunk` rather than a copy: a caller that
   * reuses its read buffer copies them first.
   */
  push(chunk: Uint8Array): HolderDecoded<F> {
    const frames: F[] = [];
    if (this.refused !== null) return { frames, malformed: this.refused };
    this.chunks.push(chunk);
    this.buffered += chunk.length;
    while (this.buffered >= HEADER) {
      const length = view(this.take(HEADER, false)).getUint32(0);
      if (length === 0) return this.refuse(frames, "a frame of length 0");
      // Refused from the header alone, so a peer can't make this side buffer what it will refuse.
      if (length > this.max) {
        return this.refuse(frames, `a frame of ${length} bytes, over the ${this.max} cap`);
      }
      if (this.buffered < HEADER + length) break;
      const bytes = this.take(HEADER + length, true);
      const decoded = this.decodeFrame(bytes[HEADER] ?? 0, bytes.subarray(HEADER + 1));
      if (isMalformed(decoded)) return this.refuse(frames, decoded.malformed);
      frames.push(decoded);
    }
    return { frames, malformed: null };
  }

  private refuse(frames: F[], reason: string): HolderDecoded<F> {
    this.refused = reason;
    this.chunks.length = 0;
    this.buffered = 0;
    return { frames, malformed: reason };
  }

  /** The first `n` buffered bytes, which `consume` removes from the buffer. */
  private take(n: number, consume: boolean): Uint8Array {
    const first = this.chunks[0];
    const out = first !== undefined && first.length >= n ? first.subarray(0, n) : this.join(n);
    if (consume) this.drop(n);
    return out;
  }

  private join(n: number): Uint8Array {
    const out = new Uint8Array(n);
    let at = 0;
    for (const chunk of this.chunks) {
      if (at === n) break;
      const part = chunk.subarray(0, n - at);
      out.set(part, at);
      at += part.length;
    }
    return out;
  }

  private drop(n: number): void {
    this.buffered -= n;
    let left = n;
    for (let chunk = this.chunks.shift(); chunk !== undefined; chunk = this.chunks.shift()) {
      if (chunk.length > left) this.chunks.unshift(chunk.subarray(left));
      left -= Math.min(left, chunk.length);
      if (left === 0) break;
    }
  }
}

const REQUEST_TYPES = byCode<HolderRequestName>(HOLDER_REQUEST_CODES);
const REPLY_TYPES = byCode<HolderReplyName>(HOLDER_REPLY_CODES);

const isRequestName = (type: string | undefined): type is HolderRequestName =>
  type !== undefined && type in HOLDER_REQUEST_CODES;
const isReplyName = (type: string | undefined): type is HolderReplyName =>
  type !== undefined && type in HOLDER_REPLY_CODES;

/** Decodes what a holder reads: requests. */
export function holderRequestDecoder(
  max: number = HOLDER_MAX_REQUEST_BYTES,
): HolderFrameDecoder<HolderRequest | UnknownHolderRequest> {
  return new HolderFrameDecoder(max, (code, payload) => {
    if (code === 0 || code > LAST_REQUEST) {
      return malformed(`0x${code.toString(16)} is no request's type`);
    }
    if (payload.length < ID) return malformed(`request 0x${code.toString(16)} has no id`);
    const id = view(payload).getUint32(0);
    const type = REQUEST_TYPES.get(code);
    if (!isRequestName(type)) return { type: "unknown", code, id };
    return decodeRequest(type, id, payload.subarray(ID));
  });
}

/** Decodes what a holder's client reads: replies and events. */
export function holderReplyDecoder(
  max: number = HOLDER_MAX_REPLY_BYTES,
): HolderFrameDecoder<HolderReply | UnknownHolderReply> {
  return new HolderFrameDecoder(max, (code, payload) => {
    const type = REPLY_TYPES.get(code);
    if (isReplyName(type)) return decodeReply(type, payload);
    if (code < FIRST_REPLY) return malformed(`0x${code.toString(16)} is no reply's type`);
    if (code >= FIRST_EVENT && code < FIRST_ANSWER_TO_ANY) return { type: "unknown", code };
    if (payload.length < ID) return malformed(`reply 0x${code.toString(16)} has no id`);
    return { type: "unknown", code, id: view(payload).getUint32(0) };
  });
}
