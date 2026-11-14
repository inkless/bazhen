import { duplexPair } from "node:stream";
import {
  encodeHolderReply,
  HOLDER_MAX_REQUEST_BYTES,
  type HolderReply,
  type HolderStats,
} from "@bazhen/protocol";
import { describe, expect, it } from "vitest";
import {
  HolderClient,
  HolderDisconnected,
  type HolderClientOptions,
  type HolderEvent,
} from "./client.ts";
import {
  FakeHolder,
  fakeHello,
  type FakeHolderOptions,
  type FakeRequest,
} from "./testing/fake-holder.ts";

const stats: HolderStats = { engineBytes: 1, rss: null, ringBytes: 2, historyLines: 3 };
const foreground = { childPid: 10, childStart: 1, pgid: 11, pgidStart: 2 };

function pair(fake: FakeHolderOptions = {}, options: Partial<HolderClientOptions> = {}) {
  const [near, far] = duplexPair();
  const holder = new FakeHolder(far, fake);
  const events: HolderEvent[] = [];
  const opening = HolderClient.open(near, { onEvent: (event) => events.push(event), ...options });
  return { near, holder, events, opening };
}

async function connected(options: Partial<HolderClientOptions> = {}) {
  const { near, holder, events, opening } = pair({}, options);
  return { client: await opening, near, holder, events };
}

const inputBytes = (frame: FakeRequest) => ("bytes" in frame ? frame.bytes : new Uint8Array());

/** A frame of a type byte this build doesn't know, with a payload. */
function unknownFrame(code: number, payload: number[]) {
  return Uint8Array.from([0, 0, 0, payload.length + 1, code, ...payload]);
}

const spec = { argv: ["sh"], cwd: "/", env: {}, generation: 1 };

/** Each verb answered `ok`: what it sends, and how. */
const OK_VERBS: [string, (client: HolderClient) => Promise<void>, object][] = [
  [
    "subscribe",
    (c) => c.subscribe({ generation: 0, offset: 5 }),
    { body: { from: { generation: 0, offset: 5 } } },
  ],
  ["resize", (c) => c.resize({ cols: 90, rows: 20 }), { body: { cols: 90, rows: 20 } }],
  ["signal", (c) => c.signal("SIGINT"), { body: { signal: "SIGINT" } }],
  ["respawn", (c) => c.respawn(spec), { body: spec }],
  ["set-tags", (c) => c.setTags({ agent: "a1" }), { body: { tags: { agent: "a1" } } }],
  ["set-theme", (c) => c.setTheme(null), { body: { theme: null } }],
  ["close", (c) => c.close(), {}],
];

describe("HolderClient", () => {
  it.each(OK_VERBS)(
    "sends %s as its own request and resolves on ok",
    async (type, verb, fields) => {
      const { client, holder } = await connected();
      const answer = verb(client);
      const request = await holder.request();
      expect(request).toMatchObject({ type, ...fields });
      holder.send({ type: "ok", id: request.id, body: { request: type } });
      await expect(answer).resolves.toBeUndefined();
    },
  );

  it("asks to be a reader unless told to ask for the writer slot", async () => {
    const { holder } = pair({ hello: false });
    await expect(holder.request()).resolves.toMatchObject({ body: { writer: false } });
  });

  it("says hello first, with its version and the writer flag it was given", async () => {
    const { holder, opening } = pair({ hello: false }, { writer: true });
    const hello = await holder.request();
    expect(hello).toMatchObject({ type: "hello", body: { protocol: ["1.0"], writer: true } });
    expect(holder.chunks).toHaveLength(1);
    holder.send({ type: "hello", id: hello.id, body: fakeHello({ writer: true }) });
    await expect(opening).resolves.toMatchObject({ hello: { writer: true } });
  });

  it("rejects the handshake with the holder's versions when they share no major", async () => {
    const { near, holder, opening } = pair({ hello: false });
    const hello = await holder.request();
    holder.send({
      type: "error",
      id: hello.id,
      body: { request: "hello", code: "no-shared-version", message: "2 only", protocol: ["2.0"] },
    });
    await expect(opening).rejects.toMatchObject({ code: "no-shared-version", protocol: ["2.0"] });
    expect(near.destroyed).toBe(true);
  });

  it("gives each answer to the request with its id when the holder answers out of order", async () => {
    const { client, holder } = await connected();
    const statsAnswer = client.stats();
    const foregroundAnswer = client.foreground();
    const first = await holder.request();
    const second = await holder.request();
    holder.send(
      { type: "foreground", id: second.id, body: foreground },
      { type: "stats", id: first.id, body: stats },
    );
    await expect(statsAnswer).resolves.toEqual(stats);
    await expect(foregroundAnswer).resolves.toEqual(foreground);
  });

  it("reads an error code newer than this build as failed, keeping the code sent", async () => {
    const { client, holder } = await connected();
    const answer = client.resize({ cols: 100, rows: 30 });
    const request = await holder.request();
    holder.send({
      type: "error",
      id: request.id,
      body: { request: "resize", code: "melted", message: "" },
    });
    await expect(answer).rejects.toMatchObject({ code: "failed", rawCode: "melted" });
  });

  it("drops the answer to an aborted request instead of giving it to the next one", async () => {
    const { client, holder, events } = await connected();
    const abort = new AbortController();
    const abandoned = client.stats({ signal: abort.signal });
    const late = await holder.request();
    abort.abort(new Error("deadline"));
    await expect(abandoned).rejects.toThrow("deadline");
    const next = client.stats();
    const request = await holder.request();
    holder.send(
      { type: "stats", id: late.id, body: { ...stats, ringBytes: 999 } },
      { type: "stats", id: request.id, body: stats },
    );
    await expect(next).resolves.toEqual(stats);
    expect({ open: client.open, events }).toEqual({ open: true, events: [] });
  });

  it("drops an error answering an aborted request rather than reporting refused input", async () => {
    const { client, holder, events } = await connected();
    const abort = new AbortController();
    const abandoned = client.resize({ cols: 90, rows: 20 }, { signal: abort.signal });
    const late = await holder.request();
    abort.abort(new Error("deadline"));
    await expect(abandoned).rejects.toThrow("deadline");
    const next = client.stats();
    const request = await holder.request();
    holder.send(
      { type: "error", id: late.id, body: { request: "resize", code: "invalid", message: "" } },
      { type: "stats", id: request.id, body: stats },
    );
    await next;
    expect(events).toEqual([]);
  });

  it("cuts input over the request cap into frames that rejoin to the same bytes", async () => {
    const { client, holder } = await connected();
    const bytes = Uint8Array.from({ length: 2 * HOLDER_MAX_REQUEST_BYTES + 1 }, (_, i) => i % 251);
    const ids = client.input(bytes);
    const frames = [await holder.request(), await holder.request(), await holder.request()];
    const full = HOLDER_MAX_REQUEST_BYTES - 1 - 4;
    expect(frames.map((frame) => frame.id)).toEqual(ids);
    expect(frames.map((frame) => inputBytes(frame).length)).toEqual([
      full,
      full,
      bytes.length - 2 * full,
    ]);
    expect(Buffer.concat(frames.map(inputBytes)).equals(bytes)).toBe(true);
  });

  it("delivers a refused input as an event carrying its id", async () => {
    const { client, holder, events } = await connected();
    const [id = -1] = client.input(Uint8Array.of(0x61));
    holder.send({ type: "error", id, body: { request: "input", code: "not-writer", message: "" } });
    await expect
      .poll(() => events)
      .toMatchObject([{ type: "refused", id, error: { code: "not-writer" } }]);
  });

  it("asks for the snapshot and the subscription in one write", async () => {
    const { client, holder } = await connected();
    void client.attach();
    const requests = [await holder.request(), await holder.request()];
    expect(requests.map((request) => request.type)).toEqual(["snapshot", "subscribe"]);
    expect(holder.chunks).toHaveLength(2);
  });

  it("gives an attach's snapshot to onEvent before output that arrives in the same chunk", async () => {
    const { client, holder, events } = await connected();
    const attached = client.attach();
    const snapshot = await holder.request();
    const subscribe = await holder.request();
    const vt = Uint8Array.of(0x1b, 0x63);
    holder.send(
      { type: "snapshot", id: snapshot.id, offset: 7, droppedLines: 0, bytes: vt },
      { type: "ok", id: subscribe.id, body: { request: "subscribe" } },
      { type: "data", offset: 7, bytes: Uint8Array.of(0x78) },
    );
    await attached;
    expect(events.map((event) => event.type)).toEqual(["snapshot", "data"]);
    expect(events[0]).toMatchObject({ offset: 7, bytes: Buffer.from(vt) });
  });

  it("skips replies and events of types it doesn't know", async () => {
    const { client, holder, events } = await connected();
    holder.sendRaw(
      Buffer.concat([
        unknownFrame(0xd0, [1]),
        unknownFrame(0xbe, [0, 0, 0, 9]),
        encodeHolderReply({ type: "title", body: { offset: 0, text: "vim" } }),
      ]),
    );
    await expect.poll(() => events).toEqual([{ type: "title", body: { offset: 0, text: "vim" } }]);
    expect(client.open).toBe(true);
  });

  it("ends the connection when a request is answered by another request's kind of reply", async () => {
    const { client, near, holder } = await connected();
    const statsAnswer = client.stats();
    const other = client.snapshot();
    const request = await holder.request();
    holder.send({ type: "ok", id: request.id, body: { request: "stats" } } satisfies HolderReply);
    await expect(statsAnswer).rejects.toBeInstanceOf(HolderDisconnected);
    await expect(other).rejects.toMatchObject({ end: { reason: "malformed" } });
    await expect(client.ended).resolves.toMatchObject({ reason: "malformed" });
    expect(near.destroyed).toBe(true);
  });

  it("ends the connection on a malformed frame, rejecting every request waiting", async () => {
    const { client, near, holder } = await connected();
    const waiting = [client.stats(), client.foreground()];
    holder.sendRaw(Uint8Array.of(0, 0, 0, 0));
    const results = await Promise.allSettled(waiting);
    expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    await expect(client.ended).resolves.toMatchObject({ reason: "malformed" });
    expect(near.destroyed).toBe(true);
  });

  it("ends the connection when an attach is aborted once sent, so no output comes unsnapshotted", async () => {
    const { client, holder } = await connected();
    const abort = new AbortController();
    const attached = client.attach({ signal: abort.signal });
    await holder.request();
    abort.abort(new Error("deadline"));
    await expect(attached).rejects.toThrow("deadline");
    await expect(client.ended).resolves.toMatchObject({ reason: "error" });
  });

  it("ends the connection when a subscribe is aborted once sent", async () => {
    const { client, holder } = await connected();
    const abort = new AbortController();
    const subscribed = client.subscribe(undefined, { signal: abort.signal });
    await holder.request();
    abort.abort(new Error("deadline"));
    await expect(subscribed).rejects.toThrow("deadline");
    await expect(client.ended).resolves.toMatchObject({ reason: "error" });
  });

  it("keeps the connection when an aborted request has nothing running on the holder", async () => {
    const { client, holder } = await connected();
    const abort = new AbortController();
    const answer = client.stats({ signal: abort.signal });
    await holder.request();
    abort.abort(new Error("deadline"));
    await expect(answer).rejects.toThrow("deadline");
    expect(client.open).toBe(true);
  });

  it("ends the connection with the error when onEvent throws, rejecting what waits", async () => {
    const thrown = new Error("consumer broke");
    const { client, near, holder } = await connected({
      onEvent: () => {
        throw thrown;
      },
    });
    const answer = client.stats();
    await holder.request();
    holder.send({ type: "title", body: { offset: 0, text: "vim" } });
    await expect(answer).rejects.toMatchObject({ end: { reason: "error", error: thrown } });
    expect(near.destroyed).toBe(true);
  });

  it("hangs up when asked, ending its side so the holder sees end of file", async () => {
    const { client, near } = await connected();
    client.end();
    expect(client.open).toBe(false);
    await expect(client.ended).resolves.toEqual({ reason: "eof" });
    await expect.poll(() => near.writableFinished).toBe(true);
  });

  it("ends with the socket's error when the stream fails", async () => {
    const { client, near } = await connected();
    near.destroy(new Error("EPIPE"));
    await expect(client.ended).resolves.toMatchObject({
      reason: "error",
      error: { message: "EPIPE" },
    });
  });

  it("rejects an attach on a connection already ended", async () => {
    const { client, holder } = await connected();
    holder.hangUp();
    await client.ended;
    await expect(client.attach()).rejects.toBeInstanceOf(HolderDisconnected);
  });

  it("rejects every request waiting when the holder hangs up", async () => {
    const { client, holder } = await connected();
    const answer = client.stats();
    holder.hangUp();
    await expect(answer).rejects.toMatchObject({ end: { reason: "eof" } });
    expect(() => client.input(Uint8Array.of(1))).toThrow(HolderDisconnected);
  });
});
