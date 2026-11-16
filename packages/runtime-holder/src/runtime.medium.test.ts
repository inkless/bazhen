// HolderRuntime against fake holders on real Unix sockets: no process is started, and every pid a
// fake names is above the system's pid limit, so nothing the runtime checks or signals is real.

import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import {
  newId,
  ProcessState,
  StaleIncarnation,
  TerminalUnconfirmed,
  type RuntimeRef,
  type TerminalSpec,
} from "@bazhen/core";
import {
  holderSocket,
  holdersDir,
  PasteRefused,
  type StartHolderOptions,
} from "@bazhen/host-guard";
import type { HolderHelloReply } from "@bazhen/protocol";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { dirname } from "node:path";
import { HOLDER_MAX_UNSENT_BYTES } from "./client.ts";
import { HolderRuntime } from "./runtime.ts";
import { WRITER_RETRY_MS } from "./runtime-stream.ts";
import { encodeTags } from "./tags.ts";
import {
  type FakeHolder,
  type FakeHolderServer,
  type FakeRequest,
  listenFakeHolder,
} from "./testing/fake-holder.ts";

/** Above every system's pid limit, so even a broken guard reaches no process. */
const FAKE_PID = 2 ** 22 + 1;
const FAKE_START = 1_700_000_000;

/** The most a pid can be here: Linux says; macOS's is fixed. */
function pidLimit(): number {
  try {
    return Number(readFileSync("/proc/sys/kernel/pid_max", "utf8").trim());
  } catch {
    return 99_999;
  }
}

beforeAll(() => {
  const limit = pidLimit();
  if (!(Number.isSafeInteger(limit) && FAKE_PID > limit)) {
    throw new Error(`the fake holders' pid ${FAKE_PID} isn't above this system's limit ${limit}`);
  }
});

// Nothing here may reach a real signal: a call that got past every fake throws instead.
beforeEach(() => {
  vi.spyOn(process, "kill").mockImplementation((pid) => {
    throw new Error(`a test reached process.kill(${pid})`);
  });
});

const roots: string[] = [];
const servers: FakeHolderServer[] = [];
const runtimes: HolderRuntime[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((server) => server.close()));
  for (const root of roots.splice(0)) {
    if (existsSync(holdersDir(root))) chmodSync(holdersDir(root), 0o700);
    rmSync(root, { recursive: true, force: true });
  }
  runtimes.length = 0;
});

/** A run root under /tmp, as a socket path holds at most 103 bytes. */
function privateRoot(): string {
  const root = mkdtempSync("/tmp/bz-hr-");
  chmodSync(root, 0o700);
  mkdirSync(holdersDir(root), { mode: 0o700 });
  roots.push(root);
  return root;
}

type Handler = (holder: FakeHolder, request: FakeRequest) => void;

const ok = (holder: FakeHolder, request: FakeRequest) =>
  holder.send({ type: "ok", id: request.id, body: { request: request.type } });

/** Answers `ok` to everything, and `snapshot` with one of nothing at the holder's offset. */
const answerAll =
  (offset = 0): Handler =>
  (holder, request) => {
    if (request.type === "snapshot") {
      const bytes = new Uint8Array();
      holder.send({ type: "snapshot", id: request.id, offset, droppedLines: 0, bytes });
    } else ok(holder, request);
  };

interface FakeTerminal {
  readonly server: FakeHolderServer;
  /** Every connection made to it, in order, each with the requests it was sent past `hello`. */
  readonly connections: { readonly holder: FakeHolder; readonly requests: FakeRequest[] }[];
}

/** A fake holder for `terminalId`, at its socket under `root`, answering with `handle`. */
async function fakeTerminal(
  root: string,
  terminalId: string,
  hello: Partial<HolderHelloReply> = {},
  handle: Handler = answerAll(),
  listen: { readonly halfOpen?: boolean } = {},
): Promise<FakeTerminal> {
  const fields = {
    terminalId,
    holderPid: FAKE_PID,
    holderStart: FAKE_START,
    childPid: FAKE_PID,
    childStart: FAKE_START,
    tags: encodeTags({ kind: "shell" }),
    ...hello,
  };
  if (fields.holderPid <= pidLimit() || fields.childPid <= pidLimit()) {
    throw new Error("a fake holder must name only pids above the system's limit");
  }
  const server = await listenFakeHolder(holderSocket(root, terminalId), {
    hello: fields,
    ...listen,
  });
  servers.push(server);
  const connections: FakeTerminal["connections"][number][] = [];
  void (async () => {
    for (;;) {
      const holder = await server.connection();
      const requests: FakeRequest[] = [];
      connections.push({ holder, requests });
      void (async () => {
        for (;;) {
          const request = await holder.request();
          requests.push(request);
          handle(holder, request);
        }
      })();
    }
  })();
  return { server, connections };
}

function runtimeAt(
  root: string,
  extra: Partial<ConstructorParameters<typeof HolderRuntime>[0]> = {},
) {
  const errors: unknown[] = [];
  const runtime = new HolderRuntime({
    root,
    binary: "/nonexistent/bazhen-holder",
    env: { PATH: "/bin", COLORTERM: "24bit", LANG: "C" },
    helloMs: 500,
    onError: (error) => errors.push(error),
    ...extra,
  });
  runtimes.push(runtime);
  return { runtime, errors };
}

const spec = (overrides: Partial<TerminalSpec> = {}): TerminalSpec => ({
  terminalId: newId("term"),
  tags: { kind: "shell" },
  argv: ["sh"],
  cwd: "/",
  env: { BAZHEN_TERMINAL_ID: "t" },
  size: { cols: 80, rows: 24 },
  generation: 0,
  ...overrides,
});

/** A runtime whose `start` puts a fake holder where the real one would bind. */
function startingFakes(
  root: string,
  hello: Partial<HolderHelloReply> = {},
  handle?: Handler,
  listen: { readonly halfOpen?: boolean } = {},
) {
  const started: StartHolderOptions[] = [];
  const terminals = new Map<string, FakeTerminal>();
  const built = runtimeAt(root, {
    start: async (options) => {
      started.push(options);
      const { terminalId } = options.spec;
      terminals.set(terminalId, await fakeTerminal(root, terminalId, hello, handle, listen));
      return { pid: FAKE_PID, start: FAKE_START, exited: new Promise(() => {}) };
    },
  });
  return { ...built, started, terminals };
}

const refWith = (ref: RuntimeRef, locator: Record<string, string>): RuntimeRef => ({
  ...ref,
  locator: { ...ref.locator, ...locator },
});

describe("HolderRuntime: creating and finding terminals", () => {
  it("starts a holder with an empty env of its own, and the terminal's env in its spec", async () => {
    const root = privateRoot();
    const { runtime, started } = startingFakes(root);
    const s = spec({ env: { BAZHEN_TERMINAL_ID: "t", COLORTERM: "" } });
    const ref = await runtime.create(s);
    const [options] = started;
    expect(options?.env).toEqual({});
    expect(options?.spec).toMatchObject({
      terminalId: s.terminalId,
      socket: holderSocket(root, s.terminalId),
      env: {
        PATH: "/bin",
        LANG: "C",
        BAZHEN_TERMINAL_ID: "t",
        TERM: "xterm-256color",
        COLORTERM: "",
      },
    });
    expect(ref).toEqual({
      terminalId: s.terminalId,
      runtime: "holder",
      locator: {
        socket: holderSocket(root, s.terminalId),
        holderPid: String(FAKE_PID),
        holderStart: String(FAKE_START),
        childPid: String(FAKE_PID),
        childStart: String(FAKE_START),
        generation: "0",
      },
    });
  });

  it("refuses a new terminal with no binary installed, saying why, and starts nothing", async () => {
    const started: StartHolderOptions[] = [];
    const { runtime } = runtimeAt(privateRoot(), {
      binary: null,
      unavailable: "the build failed",
      start: async (options) => {
        started.push(options);
        throw new Error("started");
      },
    });
    await expect(runtime.create(spec())).rejects.toThrow("the build failed");
    expect([started, await runtime.inventory()]).toEqual([[], []]);
  });

  it("defaults COLORTERM over the runtime's own, as every terminal starts truecolor", async () => {
    const { runtime, started } = startingFakes(privateRoot());
    await runtime.create(spec());
    expect(started[0]?.spec).toMatchObject({ env: { COLORTERM: "truecolor" } });
  });

  it("finds its terminals with their tags, leaving out stale sockets and foreign holders", async () => {
    const root = privateRoot();
    const { runtime } = runtimeAt(root);
    const agentId = newId("agent");
    const ours = newId("term");
    await fakeTerminal(root, ours, { tags: encodeTags({ kind: "agent", agentId }) });
    await fakeTerminal(root, newId("term"), { tags: { kind: "pane" } });
    const dead = await fakeTerminal(root, newId("term"));
    // A second name for its socket outlives the listener, as a dead holder's file does.
    linkSync(dead.server.path, holderSocket(root, newId("term")));
    await dead.server.close();
    expect((await runtime.inventory()).map((e) => [e.ref.terminalId, e.tags])).toEqual([
      [ours, { kind: "agent", agentId }],
    ]);
  });

  it("finds nothing before the first terminal, and throws when the holders can't be listed", async () => {
    const root = privateRoot();
    const { runtime } = runtimeAt(root);
    expect([await runtime.inventory(), (await runtime.health()).state]).toEqual([
      [],
      "not-running",
    ]);
    await fakeTerminal(root, newId("term"));
    expect((await runtime.health()).state).toBe("healthy");
    chmodSync(holdersDir(root), 0o000);
    await expect(runtime.inventory()).rejects.toMatchObject({ code: "EACCES" });
    expect((await runtime.health()).state).toBe("unreachable");
  });

  it("is unreachable while a holder's socket can't be read, and never reports it exited", async () => {
    const root = privateRoot();
    const { runtime } = runtimeAt(root, { exitPollMs: 20 });
    const fake = await fakeTerminal(root, newId("term"), { exit: { type: "exited", code: 0 } });
    chmodSync(fake.server.path, 0o000);
    const seen: string[] = [];
    const stop = runtime.onExit((ref) => seen.push(ref.terminalId));
    await new Promise((wait) => setTimeout(wait, 100));
    stop();
    expect([(await runtime.health()).state, seen]).toEqual(["unreachable", []]);
  });

  it("refuses an inventory while any holder can't be read, and still sees the others' exits", async () => {
    const root = privateRoot();
    const { runtime, errors } = runtimeAt(root, { exitPollMs: 20 });
    const ended = newId("term");
    await fakeTerminal(root, ended, { exit: { type: "exited", code: 0 } });
    chmodSync((await fakeTerminal(root, newId("term"))).server.path, 0o000);
    const seen: string[] = [];
    const stop = runtime.onExit((ref) => seen.push(ref.terminalId));
    await expect.poll(() => seen.length).toBeGreaterThan(1);
    stop();
    await expect(runtime.inventory()).rejects.toThrow("can't be read");
    // Reported once, however often exit polling reads it while it stays unreadable.
    expect([seen[0], errors.length]).toEqual([ended, 1]);
  });

  it("reports an exited terminal on every check, under its generation", async () => {
    const root = privateRoot();
    const { runtime } = runtimeAt(root, { exitPollMs: 20 });
    const terminalId = newId("term");
    await fakeTerminal(root, terminalId, {
      generation: 3,
      exit: { type: "signalled", signal: "SIGTERM" },
    });
    const seen: unknown[] = [];
    const stop = runtime.onExit((ref, status) => seen.push([ref.locator.generation, status]));
    await expect.poll(() => seen.length).toBeGreaterThanOrEqual(2);
    stop();
    expect(seen[0]).toEqual(["3", { type: "signalled", signal: "SIGTERM" }]);
  });
});

async function made(hello: Partial<HolderHelloReply> = {}) {
  const root = privateRoot();
  const { runtime, terminals } = startingFakes(root, hello);
  const ref = await runtime.create(spec());
  return { runtime, ref, fake: terminals.get(ref.terminalId)! };
}

describe("HolderRuntime: refusing a ref that isn't the holder's process", () => {
  it("refuses a ref from another holder at the terminal's socket", async () => {
    const { runtime, ref } = await made();
    const forged = refWith(ref, { holderStart: "1" });
    for (const act of [
      () => runtime.signal(forged, "SIGKILL"),
      () => runtime.close(forged),
      () => runtime.attach(forged, null, 0),
      () => runtime.respawn(forged, spec()),
    ]) {
      await expect(act()).rejects.toMatchObject({ reason: "server-replaced" });
    }
  });

  it("refuses a ref to another generation or another child, and one with no generation", async () => {
    const { runtime, ref } = await made();
    const { generation: _, ...unnumbered } = ref.locator;
    const refused = [
      refWith(ref, { generation: "1" }),
      refWith(ref, { childStart: "1" }),
      refWith(ref, { childPid: "77" }),
      { ...ref, locator: unnumbered },
    ];
    const reasons = await Promise.all(
      refused.map((r) => runtime.signal(r, "SIGKILL").catch((e: StaleIncarnation) => e.reason)),
    );
    expect(reasons).toEqual([
      "process-replaced",
      "process-replaced",
      "process-replaced",
      "unnumbered",
    ]);
  });

  it("sends nothing to a holder it refused a ref for", async () => {
    const { runtime, ref, fake } = await made();
    await runtime.signal(refWith(ref, { generation: "1" }), "SIGKILL").catch(() => {});
    await runtime.signal(refWith(ref, { holderPid: "5" }), "SIGKILL").catch(() => {});
    expect(fake.connections.flatMap((c) => c.requests)).toEqual([]);
  });

  it("refuses every paste, after checking its text and ref, and sends the holder nothing", async () => {
    const { runtime, ref, fake } = await made();
    await expect(runtime.paste(ref, "make\r", true)).rejects.toBeInstanceOf(RangeError);
    await expect(
      runtime.paste(refWith(ref, { generation: "1" }), "make", false),
    ).rejects.toMatchObject({
      reason: "process-replaced",
    });
    await expect(runtime.paste(ref, "make", true)).rejects.toBeInstanceOf(PasteRefused);
    expect(fake.connections.flatMap((c) => c.requests)).toEqual([]);
    const exited = await made({ exit: { type: "exited", code: 0 } });
    await expect(exited.runtime.paste(exited.ref, "make", false)).rejects.toBeInstanceOf(
      ProcessState,
    );
  });

  it("signals a running process, and refuses one that has exited", async () => {
    const { runtime, ref, fake } = await made();
    await runtime.signal(ref, "SIGINT");
    expect(fake.connections.flatMap((c) => c.requests)).toEqual([
      expect.objectContaining({ type: "signal", body: { signal: "SIGINT" } }),
    ]);
    const exited = await made({ exit: { type: "exited", code: 1 } });
    await expect(exited.runtime.signal(exited.ref, "SIGINT")).rejects.toBeInstanceOf(ProcessState);
  });
});

describe("HolderRuntime: closing", () => {
  it("closes by protocol and waits for the holder to hang up", async () => {
    const root = privateRoot();
    const { runtime, terminals } = startingFakes(root);
    const ref = await runtime.create(spec());
    const socket = holderSocket(root, ref.terminalId);
    await runtime.close(ref);
    // The fake answers `close` as a real holder does: `ok`, then it hangs up and removes its socket.
    expect([existsSync(socket), terminals.get(ref.terminalId)!.connections.length]).toEqual([
      false,
      2,
    ]);
  });

  it("counts a terminal whose holder is gone as closed, and removes its stale socket", async () => {
    const root = privateRoot();
    const { runtime, terminals } = startingFakes(root);
    const ref = await runtime.create(spec());
    const socket = holderSocket(root, ref.terminalId);
    const kept = `${socket}.kept`;
    linkSync(socket, kept);
    await terminals.get(ref.terminalId)!.server.close();
    linkSync(kept, socket);
    await expect(runtime.close(ref)).resolves.toBeUndefined();
    expect(existsSync(socket)).toBe(false);
  });

  it("calls a terminal whose holder can't be read unconfirmed, not stale", async () => {
    const root = privateRoot();
    const { runtime, terminals } = startingFakes(root);
    const ref = await runtime.create(spec());
    chmodSync(terminals.get(ref.terminalId)!.server.path, 0o000);
    await expect(runtime.close(ref)).rejects.toBeInstanceOf(TerminalUnconfirmed);
  });

  it("calls a terminal gone only when no holder answers and the recorded one isn't running", async () => {
    const root = privateRoot();
    const { runtime } = startingFakes(root);
    const ref = await runtime.create(spec());
    expect(await runtime.gone(ref)).toBe(false);
    await runtime.close(ref);
    expect(await runtime.gone(ref)).toBe(true);
  });
});

/**
 * A terminal whose holder answers an attach with `vt` at `offset`, then sends `after`; each
 * snapshot after the first is `later` bytes on, as output the reader hasn't had yet would be.
 */
async function attachable(
  offset = 5,
  after: (holder: FakeHolder) => void = () => {},
  later = 0,
  options: {
    readonly halfOpen?: boolean;
    readonly hello?: Partial<HolderHelloReply>;
    /** Sent ahead of the attach's snapshot, as events the holder had queued first. */
    readonly beforeSnapshot?: (holder: FakeHolder) => void;
    /** Called as a resize comes in, before it is answered. */
    readonly duringResize?: () => void;
  } = {},
) {
  const root = privateRoot();
  const vt = Uint8Array.of(0x41);
  let snapshots = 0;
  const handle: Handler = (holder, request) => {
    if (request.type === "snapshot") {
      if (snapshots === 0) options.beforeSnapshot?.(holder);
      const at = offset + (snapshots++ === 0 ? 0 : later);
      holder.send({ type: "snapshot", id: request.id, offset: at, droppedLines: 0, bytes: vt });
    } else if (request.type === "subscribe") {
      ok(holder, request);
      after(holder);
    } else if (request.type === "resize") {
      options.duringResize?.();
      ok(holder, request);
    } else if (request.type !== "input") ok(holder, request);
  };
  const { runtime, terminals } = startingFakes(
    root,
    { offset, ...options.hello },
    handle,
    options.halfOpen === true ? { halfOpen: true } : {},
  );
  const ref = await runtime.create(spec());
  return { runtime, ref, fake: terminals.get(ref.terminalId)!, vt };
}

const data = (offset: number, text: string) =>
  ({ type: "data", offset, bytes: Buffer.from(text) }) as const;

describe("HolderRuntime: streams", () => {
  it("attaches on the holder's snapshot, and delivers what follows it to callbacks set after", async () => {
    const { runtime, ref, vt } = await attachable(5, (holder) =>
      holder.send(data(5, "ab"), { type: "alternate", body: { offset: 7, on: true } }),
    );
    const attached = await runtime.attach(ref, null, 0);
    const seen: unknown[] = [];
    attached.stream.onData((bytes) => seen.push(Buffer.from(bytes).toString()));
    attached.stream.onAlternate((on) => seen.push(on));
    await expect.poll(() => seen).toEqual(["ab", true]);
    expect([attached.kind, attached.offset, attached.generation, attached.vt]).toEqual([
      "snapshot",
      5,
      0,
      Buffer.from(vt),
    ]);
    attached.stream.close();
  });

  it("tells a respawn before the next process's bytes, and pushes each switch of screen once", async () => {
    const { runtime, ref } = await attachable(0, (holder) =>
      holder.send(
        { type: "alternate", body: { offset: 0, on: false } },
        data(0, "old"),
        { type: "respawned", body: { generation: 1, childPid: FAKE_PID, childStart: FAKE_START } },
        data(0, "new"),
      ),
    );
    const { stream } = await runtime.attach(ref, null, 0);
    const seen: unknown[] = [];
    stream.onData((bytes) => seen.push(Buffer.from(bytes).toString()));
    stream.onRespawn((generation) => seen.push(generation));
    stream.onAlternate((on) => seen.push(on));
    await expect.poll(() => seen).toEqual(["old", 1, "new"]);
    stream.close();
  });

  it("closes a stream that fell behind, and one whose holder hung up, saying which", async () => {
    const behind = await attachable(0, (holder) =>
      holder.send({ type: "gap", body: { from: 0, to: 9 } }),
    );
    const ended = await attachable(0, (holder) => holder.hangUp());
    const whys: string[] = [];
    for (const { runtime, ref } of [behind, ended]) {
      const { stream } = await runtime.attach(ref, null, 0);
      stream.onClose((why) => whys.push(why));
    }
    await expect.poll(() => whys.toSorted()).toEqual(["behind", "ended"]);
  });

  it("sends every stream's input and resize on one writer connection, apart from its reader", async () => {
    const { runtime, ref, fake } = await attachable();
    const first = await runtime.attach(ref, { cols: 90, rows: 30 }, 0);
    const second = await runtime.attach(ref, null, 0);
    first.stream.write(Buffer.from("a"));
    second.stream.write(Buffer.from("b"));
    const writers = () =>
      fake.connections.filter((c) => c.requests.some((r) => r.type === "input"));
    await expect
      .poll(() => writers().flatMap((c) => c.requests.map((r) => r.type)))
      .toEqual(["resize", "input", "input"]);
    expect(writers()).toHaveLength(1);
    first.stream.close();
    second.stream.close();
  });

  it("opens a new writer connection only once the old one has hung up", async () => {
    const { runtime, ref, fake } = await attachable();
    const writers = () => fake.connections.filter((c) => c.holder.hello?.writer === true);
    const first = await runtime.attach(ref, { cols: 90, rows: 30 }, 0);
    await expect.poll(() => writers()).toHaveLength(1);
    const old = writers()[0]!.holder;
    const order: string[] = [];
    void old.ended.then(() => order.push("old hung up"));
    // A holder that has stopped reading holds the old connection's hang-up behind its input.
    old.stopReading();
    first.stream.write(new Uint8Array(4 * 1024 * 1024));
    await new Promise((wait) => setTimeout(wait, 50));
    first.stream.close();
    const second = runtime.attach(ref, { cols: 91, rows: 30 }, 0);
    await new Promise((wait) => setTimeout(wait, 200));
    expect([writers().length, order]).toEqual([1, []]);
    old.startReading();
    await expect.poll(() => writers()).toHaveLength(2);
    order.push("new writer");
    expect(order).toEqual(["old hung up", "new writer"]);
    (await second).stream.close();
  });

  it("asks again for a writer slot another connection holds, then says so, to streams come later too", async () => {
    const { runtime, ref, fake } = await attachable(5, () => {}, 0, { hello: { writer: false } });
    const { stream } = await runtime.attach(ref, null, 0);
    const told: string[] = [];
    stream.onFailure((failure) => told.push(failure.what));
    stream.write(Buffer.from("a"));
    await expect.poll(() => told, { timeout: 5_000 }).toEqual(["input"]);
    const asked = fake.connections.filter((c) => c.holder.hello?.writer === true);
    expect(asked).toHaveLength(1 + WRITER_RETRY_MS.length);
    await Promise.all(asked.map((c) => c.holder.closed));
    expect(asked.flatMap((c) => c.requests).filter((r) => r.type === "input")).toEqual([]);
    const late = await runtime.attach(ref, null, 0);
    const lateTold: string[] = [];
    late.stream.onFailure((failure) => lateTold.push(failure.what));
    expect(lateTold).toEqual(["input"]);
    stream.close();
    late.stream.close();
  });

  it("takes alternate and a respawn sent before the attach's snapshot as what it shows", async () => {
    const respawned = { generation: 1, childPid: FAKE_PID, childStart: FAKE_START };
    const { runtime, ref } = await attachable(0, (holder) => holder.send(data(0, "new")), 0, {
      beforeSnapshot: (holder) =>
        holder.send(
          { type: "alternate", body: { offset: 0, on: true } },
          { type: "respawned", body: respawned },
        ),
    });
    const attached = await runtime.attach(ref, null, 0);
    const seen: unknown[] = [];
    attached.stream.onData((bytes) => seen.push(Buffer.from(bytes).toString()));
    attached.stream.onRespawn((generation) => seen.push(generation));
    attached.stream.onAlternate((on) => seen.push(on));
    await expect.poll(() => seen).toEqual(["new"]);
    expect([attached.generation, attached.alternate]).toEqual([1, true]);
    attached.stream.close();
  });

  it("keeps a screen switch sent while an attach resizes, over what its hello said", async () => {
    let terminal: FakeTerminal | undefined;
    const readers = () => terminal!.connections.filter((c) => c.holder.hello?.writer === false);
    const { runtime, ref, fake } = await attachable(0, () => {}, 0, {
      duringResize: () =>
        readers()
          .at(-1)!
          .holder.send({ type: "alternate", body: { offset: 0, on: true } }),
    });
    terminal = fake;
    const attached = await runtime.attach(ref, { cols: 90, rows: 30 }, 0);
    const pushed: boolean[] = [];
    attached.stream.onAlternate((on) => pushed.push(on));
    readers()
      .at(-1)!
      .holder.send({ type: "alternate", body: { offset: 0, on: false } });
    await expect.poll(() => pushed).toEqual([false]);
    expect(attached.alternate).toBe(true);
    attached.stream.close();
  });

  it("refuses input past what a terminal holds unsent, and sends none of it", async () => {
    const { runtime, ref, fake } = await attachable();
    const { stream } = await runtime.attach(ref, null, 0);
    const failures: unknown[] = [];
    stream.onFailure((failure) => failures.push(failure));
    stream.write(new Uint8Array(HOLDER_MAX_UNSENT_BYTES + 1));
    expect(failures).toEqual([
      {
        what: "input",
        cause: expect.objectContaining({ message: expect.stringContaining("over the") }),
      },
    ]);
    await new Promise((wait) => setTimeout(wait, 50));
    expect(fake.connections.flatMap((c) => c.requests).filter((r) => r.type === "input")).toEqual(
      [],
    );
    stream.close();
  });

  it("sends a stream's input to no other holder that takes the terminal's socket", async () => {
    const { runtime, ref, fake } = await attachable();
    const { stream } = await runtime.attach(ref, null, 0);
    const failures: string[] = [];
    stream.onFailure((failure) => failures.push(String(failure.cause)));
    // The reader stays on the first; a second holder takes the socket's name.
    rmSync(fake.server.path);
    const other = await fakeTerminal(dirname(dirname(fake.server.path)), ref.terminalId, {
      holderStart: FAKE_START + 9,
    });
    stream.write(Buffer.from("a"));
    await expect.poll(() => failures).toEqual([expect.stringContaining("another holder")]);
    expect(other.connections.flatMap((c) => c.requests)).toEqual([]);
    stream.close();
  });

  it("holds a stream's snapshot until the stream has delivered every byte before it", async () => {
    let reader: FakeHolder | undefined;
    const { runtime, ref } = await attachable(0, (holder) => (reader = holder), 4);
    const { stream } = await runtime.attach(ref, null, 0);
    let taken = false;
    // The control connection's snapshot is at 4, the reader still at 0.
    const snapshot = stream.snapshot().then((s) => ((taken = true), s));
    await new Promise((wait) => setTimeout(wait, 50));
    expect(taken).toBe(false);
    reader!.send(data(0, "abcd"));
    await expect(snapshot).resolves.toMatchObject({ offset: 4, generation: 0 });
    stream.close();
  });

  it("settles a held snapshot once a respawn carries the stream past it", async () => {
    let reader: FakeHolder | undefined;
    const { runtime, ref } = await attachable(0, (holder) => (reader = holder), 4);
    const { stream } = await runtime.attach(ref, null, 0);
    const snapshot = stream.snapshot();
    await new Promise((wait) => setTimeout(wait, 50));
    const respawned = { generation: 1, childPid: FAKE_PID, childStart: FAKE_START };
    reader!.send({ type: "respawned", body: respawned });
    await expect(snapshot).resolves.toMatchObject({ generation: 0, offset: 4 });
    stream.close();
  });

  it("rejects a pending snapshot once the stream has closed, after its close callbacks", async () => {
    let reader: FakeHolder | undefined;
    const { runtime, ref } = await attachable(3, (holder) => (reader = holder), 10);
    const { stream } = await runtime.attach(ref, null, 0);
    const order: string[] = [];
    stream.onClose(() => order.push("closed"));
    const pending = stream.snapshot().catch(() => order.push("rejected"));
    await new Promise((wait) => setTimeout(wait, 50));
    reader!.hangUp();
    await pending;
    expect(order).toEqual(["closed", "rejected"]);
    await expect(stream.snapshot()).rejects.toThrow("closed");
  });
});
