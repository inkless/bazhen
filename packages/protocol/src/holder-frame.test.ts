import { describe, expect, it } from "vitest";
import { HOLDER_MAX_REQUEST_BYTES, HOLDER_REPLY_CODES, HOLDER_REQUEST_CODES } from "./holder.ts";
import {
  encodeHolderReply,
  encodeHolderRequest,
  type HolderReply,
  holderReplyDecoder,
  holderRequestDecoder,
  InvalidHolderFrame,
} from "./holder-frame.ts";

const bytes = (...values: number[]) => Uint8Array.from(values);
const text = (s: string) => new TextEncoder().encode(s);
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  parts.reduce((at, p) => (out.set(p, at), at + p.length), 0);
  return out;
};
/** A frame as raw bytes: the header for `payload`, then `payload`. */
const raw = (code: number, payload: Uint8Array) => {
  const head = new Uint8Array(5);
  new DataView(head.buffer).setUint32(0, payload.length + 1);
  head[4] = code;
  return concat(head, payload);
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

const decodeReplies = (...chunks: Uint8Array[]) => {
  const decoder = holderReplyDecoder();
  return chunks.map((chunk) => decoder.push(chunk));
};

describe("encoding a holder frame", () => {
  it("writes a bodiless request as length, type and id, big-endian", () => {
    expect(encodeHolderRequest({ type: "snapshot", id: 7 })).toEqual(
      bytes(0, 0, 0, 5, 0x02, 0, 0, 0, 7),
    );
  });

  it("writes a JSON request after its id", () => {
    const json = '{"cols":80,"rows":24}';
    expect(encodeHolderRequest({ type: "resize", id: 1, body: { cols: 80, rows: 24 } })).toEqual(
      concat(bytes(0, 0, 0, 1 + 4 + json.length, 0x42, 0, 0, 0, 1), text(json)),
    );
  });

  it("writes input as raw bytes after its id", () => {
    expect(encodeHolderRequest({ type: "input", id: 2, bytes: bytes(3) })).toEqual(
      bytes(0, 0, 0, 6, 0x41, 0, 0, 0, 2, 3),
    );
  });

  it("writes an event's u64 offset before its bytes, with no id", () => {
    expect(encodeHolderReply({ type: "data", offset: 0x01_0203_0405, bytes: text("a") })).toEqual(
      bytes(0, 0, 0, 10, 0xc0, 0, 0, 0, 1, 2, 3, 4, 5, 0x61),
    );
  });

  it("writes a snapshot's id, its offset, the history lines it left out, then its bytes", () => {
    expect(
      encodeHolderReply({ type: "snapshot", id: 3, offset: 9, droppedLines: 2, bytes: text("x") }),
    ).toEqual(bytes(0, 0, 0, 18, 0x82, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 9, 0, 0, 0, 2, 0x78));
  });

  it.each([
    [
      "a body its schema refuses",
      () => encodeHolderRequest({ type: "resize", id: 1, body: { cols: 70_000, rows: 1 } }),
    ],
    ["an id past u32", () => encodeHolderRequest({ type: "stats", id: 2 ** 32 })],
    ["a negative id", () => encodeHolderRequest({ type: "stats", id: -1 })],
    ["a fractional id", () => encodeHolderRequest({ type: "stats", id: 1.5 })],
    ["a negative offset", () => encodeHolderReply({ type: "data", offset: -1, bytes: bytes() })],
    [
      "an offset past 2^53 - 1",
      () => encodeHolderReply({ type: "data", offset: 2 ** 53, bytes: bytes() }),
    ],
    [
      "input over the cap",
      () =>
        encodeHolderRequest({
          type: "input",
          id: 1,
          bytes: new Uint8Array(HOLDER_MAX_REQUEST_BYTES - 4),
        }),
    ],
  ])("refuses %s", (_, encode) => {
    expect(encode).toThrow(InvalidHolderFrame);
  });

  it("writes a request of exactly the cap: type, id and input", () => {
    const input = new Uint8Array(HOLDER_MAX_REQUEST_BYTES - 5);
    expect(encodeHolderRequest({ type: "input", id: 1, bytes: input }).length).toBe(
      4 + HOLDER_MAX_REQUEST_BYTES,
    );
  });

  it("writes a snapshot past the request cap, which only requests are held to", () => {
    const vt = new Uint8Array(2 * HOLDER_MAX_REQUEST_BYTES);
    expect(
      encodeHolderReply({ type: "snapshot", id: 1, offset: 0, droppedLines: 0, bytes: vt }).length,
    ).toBe(4 + 1 + 4 + 8 + 4 + vt.length);
  });
});

const OWN_REPLIES = ["hello", "snapshot", "stats", "foreground"] as const;
const isOwnReply = (name: string) => OWN_REPLIES.some((own) => own === name);
const withoutOwnReply = (code: number) => code >= 0x40 && code <= 0x7f;

describe("holder type bytes", () => {
  it("give a request's own reply the request's byte with the top bit set, below the events", () => {
    expect(
      OWN_REPLIES.map((name) => [HOLDER_REPLY_CODES[name], HOLDER_REQUEST_CODES[name] < 0x40]),
    ).toEqual(OWN_REPLIES.map((name) => [HOLDER_REQUEST_CODES[name] | 0x80, true]));
  });

  it("put every request without a reply of its own at 0x40 and above", () => {
    const others = Object.entries(HOLDER_REQUEST_CODES).filter(([name]) => !isOwnReply(name));
    expect(others.map(([, code]) => withoutOwnReply(code))).toEqual(others.map(() => true));
  });

  it("keep the numbers every version of either peer reads them by", () => {
    expect([HOLDER_REQUEST_CODES, HOLDER_REPLY_CODES]).toEqual([
      {
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
      },
      {
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
      },
    ]);
  });
});

const stats: HolderReply = {
  type: "stats",
  id: 4,
  body: { engineBytes: 1, rss: 2, ringBytes: 3, historyLines: 4 },
};
const data: HolderReply = { type: "data", offset: 5, bytes: text("hello") };
const statsFrame = encodeHolderReply(stats);

/** What the first `cut` bytes of a frame decode to, then what the rest adds. */
const decodeSplit = (cut: number) =>
  decodeReplies(statsFrame.subarray(0, cut), statsFrame.subarray(cut)).map((d) => d.frames);

describe("decoding holder frames", () => {
  it("gives back nothing for any truncation of a frame, then the frame once the rest arrives", () => {
    const cuts = Array.from({ length: statsFrame.length }, (_, i) => i);
    expect(cuts.map(decodeSplit)).toEqual(cuts.map(() => [[], [stats]]));
  });

  it("refuses a frame over the cap from its header alone, and waits for one at the cap", () => {
    expect([
      holderRequestDecoder().push(u32(HOLDER_MAX_REQUEST_BYTES + 1)),
      holderRequestDecoder().push(u32(HOLDER_MAX_REQUEST_BYTES)),
    ]).toEqual([
      { frames: [], malformed: expect.stringMatching(/over the .* cap/) },
      { frames: [], malformed: null },
    ]);
  });

  it("waits for a reply past the request cap, as a snapshot is", () => {
    expect(holderReplyDecoder().push(u32(HOLDER_MAX_REQUEST_BYTES + 1))).toEqual({
      frames: [],
      malformed: null,
    });
  });

  it.each([
    ["a frame of length 0", u32(0), /length 0/],
    ["a request with no id", raw(0x02, bytes(0, 0)), /has no id/],
    ["JSON that doesn't parse", raw(0x42, concat(u32(1), text("{"))), /^resize: /],
    [
      "JSON its schema refuses",
      raw(0x42, concat(u32(1), text('{"cols":-1,"rows":1}'))),
      /^resize: .*cols/s,
    ],
    [
      "JSON after a byte-order mark",
      raw(0x42, concat(u32(1), text('\ufeff{"cols":1,"rows":1}'))),
      /^resize: /,
    ],
    ["a body that isn't UTF-8", raw(0x42, concat(u32(1), bytes(0xff))), /not UTF-8/],
    ["a type byte 0", raw(0x00, u32(1)), /no request's type/],
    ["a reply's type byte", raw(0x80, u32(1)), /no request's type/],
    ["an event's type byte", raw(0xff, u32(1)), /no request's type/],
    [
      "a hello this build could answer, with a field it can't read",
      raw(0x01, concat(u32(1), text('{"protocol":["1.0"],"writer":"yes"}'))),
      /^hello: /,
    ],
  ])("calls %s malformed", (_, frame, reason) => {
    expect(holderRequestDecoder().push(frame)).toMatchObject({
      malformed: expect.stringMatching(reason),
    });
  });

  it.each([
    ["an offset too short", raw(0xc0, bytes(0, 0, 0)), /too short/],
    ["an offset past 2^53 - 1", raw(0xc0, u64(2n ** 53n)), /past 2\^53/],
    ["a reply with no id", raw(0x83, bytes(0)), /has no id/],
    [
      "a snapshot too short for its dropped lines",
      raw(0x82, concat(u32(1), u64(0n), bytes(0))),
      /dropped lines/,
    ],
    [
      "a hello agreeing on a major this build doesn't speak",
      raw(0x81, concat(u32(1), text('{"version":"2.0","protocol":["2.0"]}'))),
      /doesn't speak/,
    ],
    ["a reply of an unknown type with no id", raw(0xbf, bytes(0)), /has no id/],
    ["a request's type byte", raw(0x05, u32(1)), /no reply's type/],
  ])("calls a reply with %s malformed", (_, frame, reason) => {
    expect(holderReplyDecoder().push(frame)).toMatchObject({
      malformed: expect.stringMatching(reason),
    });
  });

  it("returns the frames before a malformed one, and nothing after it", () => {
    const [first, second] = decodeReplies(
      concat(encodeHolderReply(data), u32(0)),
      encodeHolderReply(data),
    );
    expect([first, second]).toEqual([
      { frames: [data], malformed: "a frame of length 0" },
      { frames: [], malformed: "a frame of length 0" },
    ]);
  });

  it("skips past an event type it doesn't know to the frames after it", () => {
    const [decoded] = decodeReplies(concat(raw(0xe0, text("later")), encodeHolderReply(data)));
    expect(decoded?.frames).toEqual([{ type: "unknown", code: 0xe0 }, data]);
  });

  it("reads no id into an event type it doesn't know, at either end of the event range", () => {
    expect(decodeReplies(raw(0xc7, u32(9)), raw(0xef, u32(9))).flatMap((d) => d.frames)).toEqual([
      { type: "unknown", code: 0xc7 },
      { type: "unknown", code: 0xef },
    ]);
  });

  it("reads the id of a reply type it doesn't know, so the request it answers can end", () => {
    expect(
      decodeReplies(raw(0xbf, concat(u32(6), text("{}"))), raw(0xf7, u32(7))).flatMap(
        (d) => d.frames,
      ),
    ).toEqual([
      { type: "unknown", code: 0xbf, id: 6 },
      { type: "unknown", code: 0xf7, id: 7 },
    ]);
  });

  it("surfaces a request type it doesn't know with its id, so it can be answered", () => {
    expect(holderRequestDecoder().push(raw(0x7e, concat(u32(9), text("{}")))).frames).toEqual([
      { type: "unknown", code: 0x7e, id: 9 },
    ]);
  });

  it("reads a frame carrying a field it doesn't know", () => {
    const json = '{"engineBytes":1,"rss":2,"ringBytes":3,"historyLines":4,"compressed":true}';
    expect(decodeReplies(raw(0x83, concat(u32(4), text(json))))[0]?.frames).toEqual([stats]);
  });

  it("reads only the frozen part of a hello from a client it shares no major with", () => {
    const hello = raw(0x01, concat(u32(1), text('{"protocol":["2.0"],"writer":"yes"}')));
    expect(holderRequestDecoder().push(hello)).toEqual({
      frames: [{ type: "hello", id: 1, body: { protocol: ["2.0"] } }],
      malformed: null,
    });
  });

  it("reads a body whose fields happen to include one named malformed", () => {
    const json = '{"engineBytes":1,"rss":2,"ringBytes":3,"historyLines":4,"malformed":"no"}';
    expect(decodeReplies(raw(0x83, concat(u32(4), text(json))))[0]).toEqual({
      frames: [stats],
      malformed: null,
    });
  });

  it("reads a bodiless request that carries a body, as a later minor may send", () => {
    expect(holderRequestDecoder().push(raw(0x02, concat(u32(1), text("{}")))).frames).toEqual([
      { type: "snapshot", id: 1 },
    ]);
  });
});
