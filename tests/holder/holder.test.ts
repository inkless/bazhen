// The holder's contract, black-box: a real bazhen-holder, started as the daemon would start one,
// driven only through the TypeScript client over its socket.

import { once } from "node:events";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { oscColour, TERMINAL_COLOURS, type TuiTheme } from "@bazhen/protocol";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import headless from "@xterm/headless";
import {
  connectHolder,
  type HolderClient,
  type HolderEvent,
  HolderRequestError,
} from "@bazhen/runtime-holder";
import { afterEach, describe, expect, it } from "vitest";
import { agentStream } from "../support/agent-stream.ts";
import { holderProcessSpec, holderSocket, testHome, userDir } from "../support/holder-home.ts";
import {
  closeHolder,
  exitedPid,
  processStart,
  replayEngine,
  type SpawnedHolder,
  spawnHolder,
  START_SKEW_S,
} from "../support/holder-spawn.ts";

const RING_BYTES = 1 << 20;
// A holder reads its resident set from /proc, so where there's none, as on macOS, it says null.
const SAYS_RSS = existsSync("/proc/self/statm");
const RSS = SAYS_RSS ? expect.any(Number) : null;
/** Whether a holder's resident set is above `bytes`, or rightly unknown where the OS won't say. */
const residentAbove = (rss: number | null, bytes: number) =>
  rss === null ? !SAYS_RSS : rss > bytes;

const running: SpawnedHolder[] = [];
const clients: HolderClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.end();
  await Promise.all(running.splice(0).map((holder) => closeHolder(holder)));
});

async function started(
  terminalId: string,
  argv: readonly [string, ...string[]],
  options?: Parameters<typeof spawnHolder>[2],
) {
  const holder = await spawnHolder(terminalId, argv, options);
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

/** What `seq 1 n` prints through a terminal with `-onlcr`, which passes each newline on as is. */
const seqOutput = (n: number) => Array.from({ length: n }, (_, i) => `${i + 1}\n`).join("");

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
    // It waits to be told, once its terminal no longer echoes, so it can't exit before the
    // subscription. With `-onlcr` the terminal passes each newline on as it is: a BSD one whose
    // output queue fills between the carriage return it adds and the newline writes the carriage
    // return again.
    const script = "stty -onlcr -echo; echo R; read _; exec seq 1 20000";
    const holder = await started("seq", ["sh", "-c", script]);
    const { client, events, exit } = await listen(holder, true);
    await client.subscribe({ generation: 0, offset: 0 });
    await until(() => output(events).includes("R\n"), "the child ready");
    client.input(encode("\n"));
    await exit;
    const expected = `R\n${seqOutput(20000)}`;
    expect(events.some((event) => event.type === "gap")).toBe(false);
    expect(
      output(
        events.slice(
          0,
          events.findIndex((event) => event.type === "exited"),
        ),
      ),
    ).toBe(expected);
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

  it("types a paste only into a program that would read it as text, marked when asked", async () => {
    const raw = await started("paste", [
      "sh",
      "-c",
      "stty -icanon -echo; printf R; exec head -c 18",
    ]);
    const reader = await listen(raw);
    await reader.client.subscribe({ generation: 0, offset: 0 });
    await until(() => output(reader.events).includes("R"), "the child's readiness");
    await reader.client.paste({ generation: 0, text: "ls -la", brackets: true });
    await reader.exit;
    expect(output(reader.events)).toBe("R\x1b[200~ls -la\x1b[201~");

    const lines = await started("paste-lines", ["sh", "-c", "stty -echo; printf R; read _"]);
    const writer = await listen(lines, true);
    await writer.client.subscribe({ generation: 0, offset: 0 });
    await until(() => output(writer.events).includes("R"), "the child's readiness");
    const refused = writer.client.paste({ generation: 0, text: "ls -la", brackets: true });
    await expect(refused).rejects.toBeInstanceOf(HolderRequestError);
    await expect(refused).rejects.toMatchObject({ code: "not-ready" });
    await expect(refused).rejects.not.toHaveProperty("message", expect.stringContaining("ls -la"));
    writer.client.input(encode("\n"));
    await writer.exit;
    expect(output(writer.events)).toBe("R");
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

  it("respawns only an exited child, as its next generation counting from 0", async () => {
    const holder = await started("respawn", ["sh", "-c", "read _; printf old"]);
    const { client, events } = await listen(holder, true);
    await client.subscribe({ generation: 0, offset: 0 });
    const next = { ...holderProcessSpec(["printf", "new"]), generation: 1 };
    await expect(client.respawn(next)).rejects.toMatchObject({ code: "running" });
    client.input(encode("\n"));
    await until(() => events.some((event) => event.type === "exited"), "the old child's exit");
    await client.respawn(next);
    await until(() => events.filter((event) => event.type === "exited").length === 2, "the exit");
    const respawnAt = events.findIndex((event) => event.type === "respawned");
    expect(events[respawnAt]).toMatchObject({ type: "respawned", body: { generation: 1 } });
    expect(output(events.slice(0, respawnAt))).toBe("\r\nold");
    expect(output(events.slice(respawnAt + 1))).toBe("new");
    expect((await listen(holder)).client.hello).toMatchObject({ generation: 1, offset: 3 });
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

/**
 * A program that asks its terminal each query of a phase in turn, raw, and prints how long each
 * answer took as `RESULT {…}`. Each phase after the first waits for `go` on its input.
 */
const QUERIES = `
process.stdin.setRawMode(true);
let read = "";
const waiting = [];
process.stdin.on("data", (chunk) => {
  read += chunk.toString("latin1");
  for (const wait of [...waiting]) {
    const found = new RegExp(wait.pattern).exec(read);
    if (found === null) continue;
    read = read.slice(found.index + found[0].length);
    waiting.splice(waiting.indexOf(wait), 1);
    wait.done(found[0]);
  }
});
const ask = (query, pattern) =>
  new Promise((done) => {
    const at = performance.now();
    waiting.push({ pattern, done: (reply) => done({ reply, ms: performance.now() - at }) });
    process.stdout.write(query);
  });
(async () => {
  for (const [i, phase] of JSON.parse(process.argv[1]).entries()) {
    if (i > 0) await ask("", "go");
    const answers = {};
    for (const [name, query, pattern] of phase) answers[name] = await ask(query, pattern);
    process.stdout.write("\\r\\nRESULT " + JSON.stringify(answers) + "\\r\\n");
  }
  setInterval(() => {}, 1 << 30);
})();
`;

type Answers = Record<string, { reply: string; ms: number }>;

function isAnswers(parsed: unknown): parsed is Answers {
  return (
    typeof parsed === "object" &&
    parsed !== null &&
    Object.values(parsed).every(
      (answer: unknown) =>
        typeof answer === "object" &&
        answer !== null &&
        "reply" in answer &&
        typeof answer.reply === "string" &&
        "ms" in answer &&
        typeof answer.ms === "number",
    )
  );
}

function readAnswers(json: string): Answers {
  const parsed: unknown = JSON.parse(json);
  if (!isAnswers(parsed)) throw new Error(`not a phase's answers: ${json}`);
  return parsed;
}

/** Where in its input the program found the answer to its query, once it has read it all. */
const answeredAt = (events: readonly HolderEvent[]): number | null => {
  const found = /ANSWERED AT (\d+)/.exec(output(events));
  return found === null ? null : Number(found[1]);
};

/** The output in `events`, as bytes. */
const outputBytes = (events: readonly HolderEvent[]) =>
  Buffer.concat(events.flatMap((event) => (event.type === "data" ? [event.bytes] : [])));

/** The answers each phase of `QUERIES` printed, read from the holder's output from 0. */
async function answers(holder: SpawnedHolder, phases: number, generation = 0): Promise<Answers[]> {
  const { client, events } = await listen(holder);
  await client.subscribe({ generation, offset: 0 });
  const printed = () =>
    [...output(events).matchAll(/RESULT (\{.*?\})\r+\n/g)].map(([, json]) => readAnswers(json!));
  await until(() => printed().length === phases, "every phase's answers");
  return printed();
}

const ESC = "\x1b";
const colourQueries = [
  ["text", `${ESC}]10;?\x07`, `${ESC}\\]10;[^\x07]*\x07`],
  ["background", `${ESC}]11;?\x07`, `${ESC}\\]11;[^\x07]*\x07`],
];
const colourAnswers = (theme: TuiTheme) => ({
  text: `${ESC}]10;${oscColour(TERMINAL_COLOURS[theme].text)}\x07`,
  background: `${ESC}]11;${oscColour(TERMINAL_COLOURS[theme].background)}\x07`,
});

/** A viewer as the web client is one: xterm's parser, with the width table the client loads. */
function viewer() {
  const term = new headless.Terminal({
    cols: 80,
    rows: 24,
    scrollback: 20_000,
    allowProposedApi: true,
  });
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = "11";
  return term;
}

/** What `bytes` draw in a viewer: every row of its history and screen, as text. */
async function drawn(bytes: readonly Uint8Array[]): Promise<string[]> {
  const term = viewer();
  for (const chunk of bytes) await new Promise<void>((done) => term.write(chunk, done));
  const buffer = term.buffer.active;
  return Array.from({ length: buffer.length }, (_, i) =>
    buffer.getLine(i)!.translateToString(true),
  );
}

const dataOf = (events: readonly HolderEvent[]) =>
  events.flatMap((event) => (event.type === "data" ? [event.bytes] : []));

/** A child that, once its terminal no longer echoes, prints R and waits for a line, then runs `then`. */
const gated = (then: string) => ["sh", "-c", `stty -echo; echo R; read _; ${then}`] as const;

/** A writer subscribed from 0 to a `gated` child, and the child let go. */
async function letGo(holder: SpawnedHolder) {
  const writer = await listen(holder, true);
  await writer.client.subscribe({ generation: 0, offset: 0 });
  await until(() => output(writer.events).includes("R\r\n"), "the child ready");
  writer.client.input(encode("\n"));
  return writer;
}

/** The attach's snapshot, which comes first, and the events after it. */
function attachedTo(events: readonly HolderEvent[]) {
  const [snapshot, ...after] = events;
  if (snapshot?.type !== "snapshot") throw new Error(`the attach began with ${snapshot?.type}`);
  return { snapshot, after };
}

/** The title and alternate-screen reports in `events`. */
const reportsIn = (events: readonly HolderEvent[]) =>
  events.flatMap((event) =>
    event.type === "title" || event.type === "alternate" ? [event.body] : [],
  );

/** The events before the first of `type`, and that one. */
function upTo(events: readonly HolderEvent[], type: HolderEvent["type"]) {
  const at = events.findIndex((event) => event.type === type);
  return { before: events.slice(0, at), event: events[at] };
}

describe("a holder's terminal engine", () => {
  it("attaches mid-stream to a snapshot that, with the output after it, draws what all of it does", async () => {
    const lines = "i=0; while [ $i -lt 4000 ]; do i=$((i+1)); echo line $i; done";
    const holder = await started("attach", gated(lines));
    const live = await letGo(holder);
    await until(() => outputEnd(live.events) > 4000, "some of the output");
    const attached = await listen(holder);
    await attached.client.attach();
    await live.exit;
    await attached.exit;
    const { snapshot, after } = attachedTo(attached.events);
    expect(snapshot.offset).toBeGreaterThan(4000);
    const data = after.filter((event) => event.type === "data");
    expect(output(data, snapshot.offset)).toBe(output(live.events).slice(snapshot.offset));
    const restored = await drawn([snapshot.bytes, ...dataOf(data)]);
    expect(restored).toEqual(await drawn(dataOf(live.events)));
  });

  it("ends a subscription to an exited child with its exit, after the last of its output", async () => {
    const holder = await started("ended", ["printf", "abc"]);
    await exitedHello(holder);
    const { client, events } = await listen(holder);
    await client.subscribe({ generation: 0, offset: 0 });
    await until(() => events.some((event) => event.type === "exited"), "the exit after its output");
    expect(events.map((event) => event.type)).toEqual(["data", "exited"]);
    expect(output(events)).toBe("abc");
  });

  it("reports the title and the alternate screen as of the output they came in, once each", async () => {
    const script = "printf 'ab\\033]2;one\\007\\033]2;the title\\007cd\\033[?1049h'; exec sleep 30";
    const holder = await started("reports", gated(script));
    const writer = await letGo(holder);
    await until(
      () => writer.events.some((event) => event.type === "alternate"),
      "the alternate screen",
    );
    for (const type of ["title", "alternate"] as const) {
      const { before, event } = upTo(writer.events, type);
      expect(event).toMatchObject({ body: { offset: outputEnd(before) } });
      expect(outputEnd(before)).toBeGreaterThanOrEqual(
        output(writer.events).lastIndexOf("\x1b[?1049h"),
      );
    }
    expect(reportsIn(writer.events)).toEqual([
      { offset: expect.any(Number), text: "the title" },
      { offset: expect.any(Number), on: true },
    ]);
  });

  it("starts a respawned child on a reset screen: no title, the main screen", async () => {
    const holder = await started("respawn-reset", ["printf", "\\033]2;old\\007\\033[?1049h"]);
    const { client } = await listen(holder, true);
    await until(async () => (await listen(holder)).client.hello.exit !== null, "the exit");
    expect((await listen(holder)).client.hello).toMatchObject({ title: "old", alternate: true });
    await client.respawn({ ...holderProcessSpec(["sleep", "30"]), generation: 1 });
    const { hello } = (await listen(holder)).client;
    expect(hello).toMatchObject({ generation: 1, title: "", alternate: false });
  });

  it("reports a resize as of the output read when it was applied", async () => {
    const holder = await started("resize-report", gated("exec sleep 30"));
    const writer = await letGo(holder);
    await writer.client.resize({ cols: 100, rows: 30 });
    await until(() => writer.events.some((event) => event.type === "resized"), "the resize");
    const { before, event } = upTo(writer.events, "resized");
    expect(event).toMatchObject({ body: { offset: outputEnd(before), cols: 100, rows: 30 } });
  });

  it("answers every query with no connection subscribed, at once, in its theme", async () => {
    const queries = [
      ["cpr", `${ESC}[3;5H${ESC}[6n`, `${ESC}\\[\\d+;\\d+R`],
      ["da1", `${ESC}[c`, `${ESC}\\[\\?[\\d;]*c`],
      ["xtversion", `${ESC}[>0q`, `${ESC}P>\\|[^${ESC}]*${ESC}\\\\`],
      ...colourQueries,
    ];
    const holder = await started(
      "queries",
      [process.execPath, "-e", QUERIES, JSON.stringify([queries, colourQueries])],
      { theme: "light" },
    );
    const writer = await listen(holder, true);
    const [first] = await answers(holder, 1);
    expect(Object.fromEntries(Object.entries(first!).map(([k, v]) => [k, v.reply]))).toEqual({
      cpr: `${ESC}[3;5R`,
      da1: expect.stringMatching(new RegExp(`^${ESC}\\[\\?[\\d;]+c$`)),
      xtversion: `${ESC}P>|bazhen${ESC}\\`,
      ...colourAnswers("light"),
    });
    // Wide, for a debug holder on a busy host.
    for (const { ms } of Object.values(first!)) expect(ms).toBeLessThan(250);
    await writer.client.setTheme(null);
    writer.client.input(encode("go"));
    const [, second] = await answers(holder, 2);
    expect(second!.text!.reply).toBe(colourAnswers("dark").text);
    expect(second!.background!.reply).toBe(colourAnswers("dark").background);
  });

  it("answers at the size its writer set", async () => {
    const corner = [["cpr", `${ESC}[999;999H${ESC}[6n`, `${ESC}\\[\\d+;\\d+R`]];
    const phases = JSON.stringify([[], corner]);
    const holder = await started("resized", [process.execPath, "-e", QUERIES, phases]);
    const writer = await listen(holder, true);
    await answers(holder, 1);
    await writer.client.resize({ cols: 100, rows: 30 });
    writer.client.input(encode("go"));
    const [, second] = await answers(holder, 2);
    expect(second!.cpr!.reply).toBe(`${ESC}[30;100R`);
  });

  it("tells a respawned program the colours of the theme it was respawned in", async () => {
    const holder = await started("respawn-theme", ["true"]);
    const { client } = await listen(holder, true);
    await until(async () => (await listen(holder)).client.hello.exit !== null, "the exit");
    const program = [process.execPath, "-e", QUERIES, JSON.stringify([colourQueries])] as const;
    await client.respawn({ ...holderProcessSpec(program), generation: 1, theme: "light" });
    const [first] = await answers(holder, 1, 1);
    expect(first!.text!.reply).toBe(colourAnswers("light").text);
    expect(first!.background!.reply).toBe(colourAnswers("light").background);
  });

  it("says in hello the title its program set and whether the alternate screen is up", async () => {
    const script = "printf '\\033]2;the title\\007\\033[?1049h'; exec sleep 30";
    const holder = await started("hello-engine", ["sh", "-c", script]);
    const hello = async () => {
      const { title, alternate } = (await listen(holder)).client.hello;
      return { title, alternate };
    };
    let said = await hello();
    await until(async () => {
      said = await hello();
      return said.alternate;
    }, "the alternate screen in hello");
    expect(said).toEqual({ title: "the title", alternate: true });
  });

  it("tells a program with no theme it is drawn on dark", async () => {
    const holder = await started("no-theme", [
      process.execPath,
      "-e",
      QUERIES,
      JSON.stringify([colourQueries]),
    ]);
    const [first] = await answers(holder, 1);
    expect(first!.text!.reply).toBe(colourAnswers("dark").text);
    expect(first!.background!.reply).toBe(colourAnswers("dark").background);
  });

  it("puts an answer between its writer's input frames, never inside one", async () => {
    const frames = 200;
    const size = 1000;
    const program = `
      process.stdin.setRawMode(true);
      process.stdout.write("READY\\r\\n");
      let read = "";
      process.stdin.on("data", (chunk) => {
        if (read === "") {
          // Stops reading, so the input piles up in the holder, and asks only then.
          process.stdin.pause();
          setTimeout(() => {
            process.stdout.write("\\x1b[6n");
            setTimeout(() => process.stdin.resume(), 300);
          }, 300);
        }
        read += chunk.toString("latin1");
        const at = read.indexOf("\\x1b");
        const letters = read.replace(/\\x1b\\[\\d+;\\d+R/, "");
        if (at >= 0 && letters.length === ${frames * size}) {
          process.stdout.write("\\r\\nANSWERED AT " + at + "\\r\\n");
        }
      });
    `;
    const holder = await started("between", [process.execPath, "-e", program]);
    const { client, events } = await listen(holder, true);
    await client.subscribe({ generation: 0, offset: 0 });
    await until(() => output(events).includes("READY"), "the program reading raw");
    for (let i = 0; i < frames; i++) {
      client.input(encode(String.fromCharCode(97 + (i % 26)).repeat(size)));
    }
    await until(() => answeredAt(events) !== null, "the answer, and every frame");
    expect(answeredAt(events)! % size).toBe(0);
  });

  it("reports in stats what an engine of its own makes of a recorded agent stream", async () => {
    const recording = join(userDir(testHome()), "agent-stream.txt");
    writeFileSync(recording, agentStream(3000));
    const holder = await started("stats", ["cat", recording]);
    const { client, events } = await listen(holder);
    const { offset } = await exitedHello(holder);
    await client.subscribe({ generation: 0, offset: 0 });
    await until(() => outputEnd(events) === offset, "the whole stream");
    const read = outputBytes(events);
    const replayed = join(userDir(testHome()), "agent-stream.read");
    writeFileSync(replayed, read);
    const report = replayEngine(replayed, { cols: 80, rows: 24 }, client.hello.historyLines);
    const stats = await client.stats();
    expect(report.historyRows).toBeGreaterThan(1000);
    expect(stats).toEqual({
      engineBytes: report.engineBytes + report.historyBytes,
      rss: RSS,
      ringBytes: read.length,
      historyLines: report.historyRows,
      engineResets: 0,
    });
    expect(residentAbove(stats.rss, stats.engineBytes)).toBe(true);
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
      start: 0,
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
