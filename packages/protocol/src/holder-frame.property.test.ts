// Round trips of holder frames over random frames and random chunkings, rather than hand-picked
// ones: a socket delivers a stream cut wherever the kernel likes.

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { HOLDER_ERROR_CODES, HolderRequestName } from "./holder.ts";
import {
  encodeHolderReply,
  encodeHolderRequest,
  type HolderFrameDecoder,
  type HolderReply,
  type HolderRequest,
  holderReplyDecoder,
  holderRequestDecoder,
} from "./holder-frame.ts";

const id = fc.nat({ max: 0xffff_ffff });
const offset = fc.maxSafeNat();
const payload = fc.uint8Array({ maxLength: 64 });
const dimension = fc.nat({ max: 0xffff });
const pid = fc.integer({ min: 1, max: 2 ** 31 - 1 });
const text = fc.string({ unit: "binary", maxLength: 32 });
const tags = fc.dictionary(fc.string({ minLength: 1, maxLength: 8 }), text);
const exit = fc.oneof(
  fc.record({ type: fc.constant("exited" as const), code: fc.integer({ min: -255, max: 255 }) }),
  fc.record({ type: fc.constant("signalled" as const), signal: fc.constant("SIGTERM") }),
  fc.record({ type: fc.constant("unknown" as const) }),
);

const request: fc.Arbitrary<HolderRequest> = fc.oneof(
  fc.record({
    type: fc.constant("hello" as const),
    id,
    body: fc.record(
      { protocol: fc.constant<string[]>(["1.0"]), writer: fc.boolean() },
      { requiredKeys: ["protocol"] },
    ),
  }),
  fc.record({
    type: fc.constantFrom(
      "snapshot" as const,
      "stats" as const,
      "close" as const,
      "foreground" as const,
    ),
    id,
  }),
  fc.record({
    type: fc.constant("subscribe" as const),
    id,
    body: fc.record({ from: offset, generation: offset }, { requiredKeys: [] }),
  }),
  fc.record({ type: fc.constant("input" as const), id, bytes: payload }),
  fc.record({
    type: fc.constant("resize" as const),
    id,
    body: fc.record({ cols: dimension, rows: dimension }),
  }),
  fc.record({
    type: fc.constant("signal" as const),
    id,
    body: fc.record({ signal: fc.constantFrom("SIGINT" as const, "SIGKILL" as const) }),
  }),
  fc.record({
    type: fc.constant("set-tags" as const),
    id,
    body: fc.record({
      tags,
    }),
  }),
  fc.record({
    type: fc.constant("set-theme" as const),
    id,
    body: fc.record({ theme: fc.constantFrom("light" as const, "dark" as const, null) }),
  }),
  fc.record({
    type: fc.constant("respawn" as const),
    id,
    body: fc.record({
      argv: fc.array(text, { minLength: 1, maxLength: 4 }),
      cwd: fc.constant("/"),
      theme: fc.constantFrom("light" as const, "dark" as const),
      env: fc.dictionary(fc.string(), text),
      generation: offset,
    }),
  }),
);

/** What `ok` and `error` name: any request, one the holder didn't know included. */
const answered = fc.constantFrom(...HolderRequestName.options, "unknown", "from-a-newer-daemon");

const reply: fc.Arbitrary<HolderReply> = fc.oneof(
  fc.record({
    type: fc.constant("hello" as const),
    id,
    body: fc.record({
      version: fc.constant("1.0"),
      protocol: fc.constant<string[]>(["1.0"]),
      terminalId: fc.constant("term_0190a1b2c3d47abc8def0123456789ab"),
      tags,
      generation: offset,
      holderPid: pid,
      holderStart: offset,
      childPid: pid,
      childStart: offset,
      exit: fc.option(exit, { nil: null }),
      size: fc.record({ cols: dimension, rows: dimension }),
      offset,
      title: text,
      alternate: fc.boolean(),
      historyLines: offset,
      writer: fc.boolean(),
    }),
  }),
  fc.record({
    type: fc.constant("foreground" as const),
    id,
    body: fc.record({ childPid: pid, childStart: offset, pgid: pid, pgidStart: offset }),
  }),
  fc.record({
    type: fc.constant("exited" as const),
    body: fc.record({ generation: offset, status: exit }),
  }),
  fc.record({
    type: fc.constant("respawned" as const),
    body: fc.record({ generation: offset, childPid: pid, childStart: offset }),
  }),
  fc.record({ type: fc.constant("data" as const), offset, bytes: payload }),
  fc.record({ type: fc.constant("snapshot" as const), id, offset, bytes: payload }),
  fc.record({ type: fc.constant("gap" as const), body: fc.record({ from: offset, to: offset }) }),
  fc.record({
    type: fc.constant("resized" as const),
    body: fc.record({ offset, cols: dimension, rows: dimension }),
  }),
  fc.record({
    type: fc.constant("title" as const),
    body: fc.record({ offset, text }),
  }),
  fc.record({
    type: fc.constant("alternate" as const),
    body: fc.record({ offset, on: fc.boolean() }),
  }),
  fc.record({
    type: fc.constant("ok" as const),
    id,
    body: fc.record({ request: answered }),
  }),
  fc.record({
    type: fc.constant("error" as const),
    id,
    body: fc.record(
      {
        request: answered,
        code: fc.constantFrom(...HOLDER_ERROR_CODES, "from-a-newer-holder"),
        message: fc.string(),
        protocol: fc.constant<string[]>(["1.0", "a newer peer's 3.x"]),
      },
      { requiredKeys: ["request", "code", "message"] },
    ),
  }),
  fc.record({
    type: fc.constant("stats" as const),
    id,
    body: fc.record({
      engineBytes: offset,
      rss: fc.option(offset, { nil: null }),
      ringBytes: offset,
      historyLines: offset,
    }),
  }),
);

/** The frames, encoded back to back, then cut at `cuts` and fed to a decoder piece by piece. */
function roundTrip<F>(
  frames: readonly F[],
  encode: (frame: F) => Uint8Array,
  decoder: HolderFrameDecoder<object>,
  cuts: readonly number[],
): unknown[] {
  const stream = new Uint8Array(frames.flatMap((frame) => [...encode(frame)]));
  const points = [
    ...new Set([0, ...cuts.map((cut) => cut % (stream.length + 1)), stream.length]),
  ].toSorted((a, b) => a - b);
  return points.slice(1).flatMap((end, i) => decoder.push(stream.subarray(points[i], end)).frames);
}

const cuts = fc.array(fc.nat(), { maxLength: 8 });

const requestsSurvive = (frames: HolderRequest[], at: number[]) => {
  expect(roundTrip(frames, encodeHolderRequest, holderRequestDecoder(), at)).toEqual(frames);
};

const repliesSurvive = (frames: HolderReply[], at: number[]) => {
  expect(roundTrip(frames, encodeHolderReply, holderReplyDecoder(), at)).toEqual(frames);
};

describe("holder frames", () => {
  it("decode to the requests encoded, however the stream is cut", () => {
    expect(() =>
      fc.assert(fc.property(fc.array(request, { maxLength: 8 }), cuts, requestsSurvive)),
    ).not.toThrow();
  });

  it("decode to the replies and events encoded, however the stream is cut", () => {
    expect(() =>
      fc.assert(fc.property(fc.array(reply, { maxLength: 8 }), cuts, repliesSurvive)),
    ).not.toThrow();
  });
});
