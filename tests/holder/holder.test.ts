// The holder's contract, black-box: a real bazhen-holder, started as the daemon would start one,
// driven only through the TypeScript client over its socket.

import { once } from "node:events";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import { dirname, join } from "node:path";
import {
  connectHolder,
  type HolderClient,
  type HolderEvent,
  HolderRequestError,
} from "@bazhen/runtime-holder";
import { afterEach, describe, expect, it } from "vitest";
import { holderSocket, testHome } from "../support/holder-home.ts";
import {
  closeHolder,
  exitedPid,
  processStart,
  type SpawnedHolder,
  spawnHolder,
  START_SKEW_S,
} from "../support/holder-spawn.ts";

const RING_BYTES = 1 << 20;

const running: SpawnedHolder[] = [];
const clients: HolderClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.end();
  await Promise.all(running.splice(0).map((holder) => closeHolder(holder)));
});

async function started(terminalId: string, argv: readonly [string, ...string[]]) {
  const holder = await spawnHolder(terminalId, argv);
  running.push(holder);
  return holder;
}

/** A connection that keeps what it is sent, and says when the child's exit arrives. */
async function listen(holder: SpawnedHolder, writer = false) {
  const events: HolderEvent[] = [];
  const { promise: exit, resolve: exited } = Promise.withResolvers<void>();
  const client = await connectHolder(holder.socket, {
    writer,
    onEvent: (event) => {
      events.push(event);
      if (event.type === "exited") exited();
    },
  });
  clients.push(client);
  return { client, events, exit };
}

/** The output in `events`, joined, after checking its offsets run on from `from`. */
function output(events: readonly HolderEvent[], from = 0): string {
  let at = from;
  const chunks: Buffer[] = [];
  for (const event of events) {
    if (event.type !== "data") continue;
    expect(event.offset).toBe(at);
    at += event.bytes.length;
    chunks.push(Buffer.from(event.bytes));
  }
  return Buffer.concat(chunks).toString("utf8");
}

const until = async (done: () => boolean | Promise<boolean>, what: string, ms = 10_000) => {
  const deadline = Date.now() + ms;
  while (!(await done())) {
    if (Date.now() > deadline) throw new Error(`${what} never happened`);
    await new Promise((wait) => setTimeout(wait, 20));
  }
};

/** The offset just past the last output in `events`, or 0 before any. */
const outputEnd = (events: readonly HolderEvent[]) =>
  events.reduce(
    (end, event) => (event.type === "data" ? event.offset + event.bytes.length : end),
    0,
  );

/** How far `pid`'s start, as `ps` says, lies from `start`. */
async function startSkew(pid: number, start: number): Promise<number> {
  const actual = await processStart(pid);
  if (actual === null) throw new Error(`${pid} has no process`);
  return Math.abs(actual - start);
}

const encode = (text: string) => new TextEncoder().encode(text);

/** What `seq 1 n` prints through a terminal, which turns each newline into `\r\n`. */
const seqOutput = (n: number) => Array.from({ length: n }, (_, i) => `${i + 1}\r\n`).join("");

async function exitedHello(holder: SpawnedHolder) {
  let hello: HolderClient["hello"] | undefined;
  await until(async () => {
    const { client } = await listen(holder);
    hello = client.hello;
    return hello.exit !== null;
  }, "the child's exit");
  return hello!;
}

describe("a holder", () => {
  it("says who it is, its child and its start, and hands the writer slot to one connection", async () => {
    const holder = await started("hello", ["sleep", "30"]);
    const { client } = await listen(holder, true);
    const { hello } = client;
    expect(hello.terminalId).toBe("hello");
    expect(hello.holderPid).toBe(holder.pid);
    expect(hello.generation).toBe(0);
    expect(hello.exit).toBeNull();
    expect(hello.writer).toBe(true);
    expect(await startSkew(hello.holderPid, hello.holderStart)).toBeLessThanOrEqual(START_SKEW_S);
    expect(await startSkew(hello.childPid, hello.childStart)).toBeLessThanOrEqual(START_SKEW_S);
    const second = await listen(holder, true);
    expect(second.client.hello.writer).toBe(false);
  });

  it("streams every byte of its child's output in order, then its exit, from any offset it holds", async () => {
    const holder = await started("seq", ["seq", "1", "20000"]);
    const { client, events, exit } = await listen(holder);
    await client.subscribe({ generation: 0, offset: 0 });
    await exit;
    const expected = seqOutput(20000);
    expect(events.some((event) => event.type === "gap")).toBe(false);
    expect(output(events)).toBe(expected);
    const later = await listen(holder);
    await later.client.subscribe({ generation: 0, offset: 1000 });
    const tail = Buffer.byteLength(expected) - 1000;
    await until(() => Buffer.byteLength(output(later.events, 1000)) === tail, "the tail");
    expect(output(later.events, 1000)).toBe(expected.slice(1000));
  });

  it("tells a subscriber from output it has dropped of the gap, then sends the rest", async () => {
    const flood = 3_000_000;
    const holder = await started("gap", ["head", `-c${flood}`, "/dev/zero"]);
    expect((await exitedHello(holder)).offset).toBe(flood);
    const { client, events } = await listen(holder);
    await client.subscribe({ generation: 0, offset: 0 });
    await until(() => outputEnd(events) === flood, "the end of the output");
    expect(events[0]).toEqual({ type: "gap", body: { from: 0, to: flood - RING_BYTES } });
    expect(output(events.slice(1), flood - RING_BYTES)).toBe("\0".repeat(RING_BYTES));
  });

  it("refuses a subscription from another generation or past its output", async () => {
    const holder = await started("refused", ["sleep", "30"]);
    const { client } = await listen(holder);
    const end = client.hello.offset;
    for (const [from, code] of [
      [{ generation: 1, offset: 0 }, "stale-generation"],
      [{ generation: 0, offset: end + 1 }, "out-of-range"],
    ] as const) {
      const refusal = client.subscribe(from);
      await expect(refusal).rejects.toBeInstanceOf(HolderRequestError);
      await expect(refusal).rejects.toMatchObject({ code });
    }
  });

  it("keeps streaming to one connection when another hangs up mid-stream or sends garbage", async () => {
    const script = "i=0; while [ $i -lt 40 ]; do echo $i; i=$((i+1)); sleep 0.05; done";
    const holder = await started("others", ["sh", "-c", script]);
    const { client, events, exit } = await listen(holder);
    await client.subscribe({ generation: 0, offset: 0 });
    const leaving = await listen(holder);
    await leaving.client.subscribe();
    leaving.client.end();
    const garbage = connect(holder.socket);
    await new Promise<void>((done) => garbage.once("connect", () => done()));
    garbage.end(Buffer.from([0xff, 0xff, 0xff, 0xff]));
    await new Promise<void>((done) => garbage.once("close", () => done()));
    const ended = client.ended.then((end) => {
      throw new Error(`the stream ended (${end.reason}) before the child's exit`);
    });
    await Promise.race([exit, ended]);
    const expected = Array.from({ length: 40 }, (_, i) => `${i}\r\n`).join("");
    expect(output(events)).toBe(expected);
  });

  it("passes its writer's input to the child and refuses another connection's", async () => {
    const script = "stty raw -echo; echo R; exec head -c 5";
    const holder = await started("input", ["sh", "-c", script]);
    const { client, events, exit } = await listen(holder, true);
    await client.subscribe({ generation: 0, offset: 0 });
    await until(() => output(events).includes("R"), "the child's readiness");
    const other = await listen(holder);
    const [refusedId] = other.client.input(encode("nope!"));
    await until(() => other.events.some((event) => event.type === "refused"), "the refusal");
    expect(other.events).toContainEqual(
      expect.objectContaining({
        type: "refused",
        id: refusedId,
        error: expect.objectContaining({ code: "not-writer" }),
      }),
    );
    client.input(encode("hello"));
    await exit;
    expect(output(events)).toBe("R\nhello");
  });

  it("sizes the terminal for its writer only, clamping a zero size", async () => {
    const holder = await started("resize", ["sleep", "30"]);
    const { client } = await listen(holder, true);
    const other = await listen(holder);
    await expect(other.client.resize({ cols: 100, rows: 30 })).rejects.toMatchObject({
      code: "not-writer",
    });
    await client.resize({ cols: 0, rows: 0 });
    expect((await listen(holder)).client.hello.size).toEqual({ cols: 1, rows: 1 });
  });

  it("signals its child's group, and refuses once the child has exited", async () => {
    const holder = await started("signal", ["sleep", "30"]);
    const { client, events, exit } = await listen(holder);
    await client.subscribe();
    await client.signal("SIGTERM");
    await exit;
    expect(events.at(-1)).toEqual({
      type: "exited",
      body: { generation: 0, status: { type: "signalled", signal: "SIGTERM" } },
    });
    await expect(client.signal("SIGKILL")).rejects.toMatchObject({ code: "exited" });
  });

  it("names its foreground group with start times, and echoes the tags it is given", async () => {
    const holder = await started("foreground", ["sleep", "30"]);
    const { client } = await listen(holder);
    const { childPid, childStart } = client.hello;
    expect(await client.foreground()).toEqual({
      childPid,
      childStart,
      pgid: childPid,
      pgidStart: childStart,
    });
    await client.setTags({ agent: "a1" });
    expect((await listen(holder)).client.hello.tags).toEqual({ agent: "a1" });
  });

  it("closes: ok, its exit, a hang-up, its socket gone, and the holder gone", async () => {
    const holder = await spawnHolder("close", ["sleep", "30"]);
    const { client, events } = await listen(holder);
    await client.close();
    expect((await client.ended).reason).toBe("eof");
    expect(events.map((event) => event.type)).toEqual(["exited"]);
    expect(await holder.exited).toBe(0);
    expect(existsSync(holder.socket)).toBe(false);
    expect(await processStart(holder.pid)).toBeNull();
    expect(await closeHolder(holder)).toBe(0);
    expect(existsSync(holder.entry)).toBe(false);
  });
});

describe("closing a holder in a test", () => {
  it("forgets one it saw exit", async () => {
    const holder = await spawnHolder("forgotten", ["sleep", "30"]);
    expect(await closeHolder(holder)).toBe(0);
    expect(existsSync(holder.entry)).toBe(false);
  });

  it("keeps the ledger entry of one that never answers, for the next run's sweep", async () => {
    const socket = holderSocket("hung");
    mkdirSync(dirname(socket), { recursive: true, mode: 0o700 });
    const peers: Socket[] = [];
    const { promise: hungUp, resolve: hangUp } = Promise.withResolvers<void>();
    const server = createServer((peer) => {
      peers.push(peer);
      peer.resume().once("end", hangUp);
    }).listen(socket);
    await once(server, "listening");
    const entry = join(testHome(), "hung-entry");
    writeFileSync(entry, "", { mode: 0o600 });
    const hung: SpawnedHolder = {
      terminalId: "hung",
      socket,
      pid: exitedPid(),
      exited: new Promise(() => {}),
      entry,
    };
    try {
      await expect(closeHolder(hung, 300)).rejects.toThrow("didn't close within 300 ms");
      expect(existsSync(entry)).toBe(true);
      await hungUp;
    } finally {
      for (const peer of peers) peer.destroy();
      server.close();
      rmSync(entry, { force: true });
    }
  });
});
