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
  ScreenUnreadable,
  StaleIncarnation,
  TerminalPredates,
  TerminalUnconfirmed,
  TerminalUnservable,
  type RuntimeRef,
  type TerminalId,
  type TerminalSpec,
} from "@bazhen/core";
import {
  type Containment,
  HolderStartFailed,
  holderSocket,
  holdersDir,
  PasteRefused,
  START_SKEW_S,
  type StartHolderOptions,
} from "@bazhen/host-guard";
import { type HolderHelloReply, type HolderReply, HolderSpawnSpec } from "@bazhen/protocol";
import { afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { dirname } from "node:path";
import { HOLDER_MAX_UNSENT_BYTES } from "./client.ts";
import { HolderRuntime, type HolderRuntimeOptions } from "./runtime.ts";
import { HolderStream, WRITER_RETRY_MS } from "./runtime-stream.ts";
import { encodeTags } from "./tags.ts";
import {
  type FakeHolder,
  type FakeHolderServer,
  fakeHello,
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

/** What every fake holder says of its memory. */
const FAKE_STATS = { engineBytes: 2048, rss: 8192, ringBytes: 1024, historyLines: 7 };

/** Answers `ok` to everything but `stats`, which it leaves unanswered. */
const silentOnStats: Handler = (holder, request) => {
  if (request.type !== "stats") ok(holder, request);
};

/**
 * Answers `ok` to everything, `snapshot` with one of nothing at the holder's offset, and `stats`
 * with FAKE_STATS.
 */
const answerAll =
  (offset = 0): Handler =>
  (holder, request) => {
    if (request.type === "snapshot") {
      const bytes = new Uint8Array();
      holder.send({ type: "snapshot", id: request.id, offset, droppedLines: 0, bytes });
    } else if (request.type === "stats") {
      holder.send({ type: "stats", id: request.id, body: FAKE_STATS });
    } else ok(holder, request);
  };

/** Refuses each paste with the code its text names, and answers `ok` to everything else. */
const refusingPastes: Handler = (holder, request) => {
  if (request.type !== "paste") return ok(holder, request);
  const code = request.body.text;
  const message = `the gate said ${code}`;
  holder.send({ type: "error", id: request.id, body: { request: "paste", code, message } });
};

/** The fake holders' ends of connections whose sockets have closed. */
const hungUp = new WeakSet<FakeHolder>();

/** The connections to `fake` still open. */
const openTo = (fake: FakeTerminal) => fake.connections.filter((c) => !hungUp.has(c.holder));

/** The connections to `fake` that stay open for 100 ms, unlike a `hello` that hangs up at once. */
async function lasting(fake: FakeTerminal) {
  const before = new Set(openTo(fake));
  await new Promise((wait) => setTimeout(wait, 100));
  return openTo(fake).filter((c) => before.has(c));
}

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
      void holder.closed.then(() => hungUp.add(holder));
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
  historyLines: 10_000,
  ...overrides,
});

/** A runtime whose `start` puts a fake holder where the real one would bind. */
function startingFakes(
  root: string,
  hello: Partial<HolderHelloReply> = {},
  handle?: Handler,
  listen: { readonly halfOpen?: boolean } = {},
  extra: Partial<HolderRuntimeOptions> = {},
) {
  const started: StartHolderOptions[] = [];
  const terminals = new Map<string, FakeTerminal>();
  const built = runtimeAt(root, {
    ...extra,
    start: async (options) => {
      started.push(options);
      const { terminalId } = options.spec;
      const { tags } = HolderSpawnSpec.parse(options.spec);
      const fake = await fakeTerminal(root, terminalId, { tags, ...hello }, handle, listen);
      terminals.set(terminalId, fake);
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

  it("starts a holder that keeps the terminal's history depth", async () => {
    const { runtime, started } = startingFakes(privateRoot());
    await runtime.create(spec({ historyLines: 1234 }));
    expect(started[0]?.spec).toMatchObject({ historyLines: 1234 });
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

/** A holder at `terminalId`'s socket that shares no protocol major with this build. */
async function outdatedHolder(root: string, terminalId: TerminalId): Promise<RuntimeRef> {
  const server = await listenFakeHolder(holderSocket(root, terminalId), { hello: false });
  servers.push(server);
  void (async () => {
    for (;;) {
      const holder = await server.connection();
      const hello = await holder.request();
      holder.send({
        type: "error",
        id: hello.id,
        body: { request: "hello", code: "no-shared-version", message: "", protocol: ["2.0"] },
      });
    }
  })();
  return {
    terminalId,
    runtime: "holder",
    locator: {
      socket: holderSocket(root, terminalId),
      holderPid: String(FAKE_PID),
      holderStart: String(FAKE_START),
      childPid: String(FAKE_PID),
      childStart: String(FAKE_START),
      generation: "0",
    },
  };
}

/** A runtime option deciding `containment` for every holder it starts. */
const decided = (containment: Containment) => ({ containment: async () => containment });

describe("HolderRuntime: containing each terminal", () => {
  const scoped: Containment = {
    kind: "scoped",
    systemd: 255,
    oomPolicy: true,
    caps: { terminal: "50%", total: "80%", swap: "0" },
    enforced: { terminal: 1 << 30, total: 2 << 30, swap: 0 },
    systemdRun: "/usr/bin/systemd-run",
    runtimeDir: "/run/user/1000",
  };

  it("starts each holder in a scope of its own, the bus in the holder's env alone", async () => {
    const { runtime, started } = startingFakes(privateRoot(), {}, undefined, {}, decided(scoped));
    const s = spec();
    await runtime.create(s);
    const [options] = started;
    expect(options?.scope?.argv).toEqual(
      expect.arrayContaining([
        "/usr/bin/systemd-run",
        expect.stringMatching(
          new RegExp(`^--unit=bazhen-terminal-${s.terminalId}-[0-9a-f]+\\.scope$`),
        ),
        "MemoryMax=50%",
        "MemorySwapMax=0",
      ]),
    );
    expect(options?.scope?.env).toEqual({ XDG_RUNTIME_DIR: "/run/user/1000" });
    expect(options?.env).toEqual({});
    expect(options?.spec).toMatchObject({ env: { PATH: "/bin" } });
    expect(options?.spec).not.toHaveProperty(["env", "XDG_RUNTIME_DIR"]);
  });

  it("gives each holder a scope no other launch has, a respawn's included", async () => {
    const { runtime, started } = startingFakes(privateRoot(), {}, undefined, {}, decided(scoped));
    await runtime.create(spec());
    await runtime.create(spec());
    const units = started.map((o) => o.scope?.argv.find((a) => a.startsWith("--unit=")));
    expect(new Set(units).size).toBe(2);
  });

  it("starts a holder in a scope only when terminals can be contained", async () => {
    const uncontained: Containment = { kind: "uncontained", why: "darwin has no cgroups" };
    const scopedAt = await Promise.all(
      [scoped, uncontained].map(async (containment) => {
        const built = startingFakes(privateRoot(), {}, undefined, {}, decided(containment));
        await built.runtime.create(spec());
        return built.started.map((options) => options.scope !== undefined);
      }),
    );
    expect(scopedAt).toEqual([[true], [false]]);
  });

  it("fails a create whose scoped start fails, and never retries it unscoped", async () => {
    const started: StartHolderOptions[] = [];
    const { runtime } = runtimeAt(privateRoot(), {
      ...decided(scoped),
      start: async (options) => {
        started.push(options);
        throw new HolderStartFailed({ code: 1 }, "Failed to start transient scope unit");
      },
    });
    await expect(runtime.create(spec())).rejects.toThrow("Failed to start transient scope unit");
    expect(started.map((options) => options.scope !== undefined)).toEqual([true]);
  });

  it("asks for the decision only when it starts a holder", async () => {
    let asked = 0;
    const containment = async () => (asked++, scoped);
    const { runtime } = startingFakes(privateRoot(), {}, undefined, {}, { containment });
    await runtime.inventory();
    expect(asked).toBe(0);
    await runtime.create(spec());
    expect(asked).toBe(1);
  });

  it("says of each answering holder whether its pid runs in a terminal's scope", async () => {
    const asked: number[] = [];
    const { runtime } = startingFakes(
      privateRoot(),
      {},
      undefined,
      {},
      {
        inScope: (pid) => (asked.push(pid), true),
      },
    );
    const s = spec();
    await runtime.create(s);
    expect(await runtime.builds()).toEqual([
      expect.objectContaining({ terminalId: s.terminalId, contained: true }),
    ]);
    expect(asked).toEqual([FAKE_PID]);
  });
});

describe("HolderRuntime: what doctor lists of holders", () => {
  it("lists each holder with its socket, pid and memory", async () => {
    const root = privateRoot();
    const { runtime } = runtimeAt(root);
    const terminalId = newId("term");
    await fakeTerminal(root, terminalId);
    expect(await runtime.builds()).toEqual([
      expect.objectContaining({
        terminalId,
        socket: holderSocket(root, terminalId),
        holderPid: FAKE_PID,
        stats: FAKE_STATS,
      }),
    ]);
  });

  it("lists a holder that won't give its memory, without it, in good time", async () => {
    const root = privateRoot();
    const { runtime } = runtimeAt(root);
    const terminalId = newId("term");
    await fakeTerminal(root, terminalId, {}, silentOnStats);
    const started = Date.now();
    const listed = await runtime.builds();
    expect([listed.map((h) => [h.terminalId, h.stats]), Date.now() - started < 2_000]).toEqual([
      [[terminalId, null]],
      true,
    ]);
  });

  it("lists a holder this build can't speak to by its socket, with the versions it speaks", async () => {
    const root = privateRoot();
    const { runtime } = runtimeAt(root);
    const ref = await outdatedHolder(root, newId("term"));
    expect(await runtime.builds()).toEqual([
      {
        terminalId: ref.terminalId,
        build: null,
        protocol: ["2.0"],
        contained: null,
        socket: holderSocket(root, ref.terminalId),
        holderPid: null,
        stats: null,
      },
    ]);
  });
});

describe("HolderRuntime: a holder this build can't speak to", () => {
  it("counts it as running, leaves it out of the inventory, and names it outdated", async () => {
    const root = privateRoot();
    const { runtime } = runtimeAt(root);
    const ref = await outdatedHolder(root, newId("term"));
    const current = newId("term");
    await fakeTerminal(root, current);
    const { outdated, served } = await runtime.compatibility();
    expect([
      (await runtime.health([ref])).state,
      (await runtime.inventory()).map((e) => e.ref.terminalId),
      [...outdated],
      [...served],
    ]).toEqual(["healthy", [current], [[ref.terminalId, ["2.0"]]], [current]]);
  });

  it("never calls it gone, and refuses to close it, naming its holder", async () => {
    const root = privateRoot();
    const { runtime } = runtimeAt(root);
    const ref = await outdatedHolder(root, newId("term"));
    expect(await runtime.gone(ref)).toBe(false);
    await expect(runtime.close(ref)).rejects.toMatchObject({
      constructor: TerminalUnservable,
      protocol: ["2.0"],
      holderPid: FAKE_PID,
    });
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
      () => runtime.attach(forged, null),
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
    /** Called as a resize comes in: the resize is answered once what it returns settles. */
    readonly duringResize?: () => void | Promise<void>;
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
      void Promise.resolve(options.duringResize?.()).then(() => ok(holder, request));
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

const agentSpec = (): TerminalSpec => spec({ tags: { kind: "agent", agentId: newId("agent") } });
const sleep = (ms: number) => new Promise((wait) => setTimeout(wait, ms));
/** Answers `ok` to everything, and announces a respawn's new process as a holder does. */
const respawning: Handler = (holder, request) => {
  if (request.type === "respawn") {
    const body = {
      generation: request.body.generation,
      childPid: FAKE_PID,
      childStart: FAKE_START,
    };
    holder.send({ type: "respawned", body });
  }
  ok(holder, request);
};

/**
 * Fake holders, and a runtime listing them every 20 ms, whose title reports go to `told` by
 * terminal, and to `reports` whole.
 */
function watched(root: string, handle?: Handler, hello: Partial<HolderHelloReply> = {}) {
  const fakes = startingFakes(root, hello, handle, {}, { titleSyncMs: 20 });
  const told: string[] = [];
  const reports: unknown[][] = [];
  const stop = fakes.runtime.onTitle((...report) => {
    told.push(report[0]);
    reports.push(report);
  });
  onTestFinished(stop);
  return { ...fakes, told, reports, stop };
}

/** Waits for the runtime to list the holders `n` more times, by the `hello`s `fake` answered. */
async function listings(fake: FakeTerminal, n: number) {
  const before = fake.connections.length;
  await expect.poll(() => fake.connections.length).toBeGreaterThanOrEqual(before + n);
}

const titleFrame = (text: string) => ({ type: "title", body: { offset: 0, text } }) as const;

/**
 * A fake holder of an agent's terminal, under `root`, whose `hello`s the test answers: the nth
 * connection's, as the holder it names, or with `other` fields in its place.
 */
async function handAnswered(root: string) {
  const terminalId = newId("term");
  const server = await listenFakeHolder(holderSocket(root, terminalId), { hello: false });
  servers.push(server);
  const opened: FakeHolder[] = [];
  void (async () => {
    for (;;) {
      const holder = await server.connection();
      void holder.closed.then(() => hungUp.add(holder));
      opened.push(holder);
    }
  })();
  const fields = {
    terminalId,
    holderPid: FAKE_PID,
    holderStart: FAKE_START,
    childPid: FAKE_PID,
    childStart: FAKE_START,
    tags: encodeTags({ kind: "agent", agentId: newId("agent") }),
  };
  /** Answers the nth `hello`, with `after` in the same write. */
  const answer = async (
    n: number,
    other: Partial<HolderHelloReply> = {},
    ...after: HolderReply[]
  ) => {
    await expect.poll(() => opened.length).toBeGreaterThan(n);
    const holder = opened[n]!;
    const request = await holder.request();
    const body = fakeHello({ ...fields, ...other });
    holder.send({ type: "hello", id: request.id, body }, ...after);
  };
  return { opened, answer };
}

describe("HolderRuntime: pasting through the holder's gate", () => {
  it("pastes through the holder's gate, in the generation it greeted with", async () => {
    const { runtime, ref, fake } = await made();
    await runtime.paste(ref, "make 你好", true);
    expect(fake.connections.flatMap((c) => c.requests)).toEqual([
      expect.objectContaining({
        type: "paste",
        body: { generation: 0, text: "make 你好", brackets: true },
      }),
    ]);
  });

  it("refuses as the gate did: not ready or unknown as PasteRefused, stale or exited as for any verb", async () => {
    const { runtime, terminals } = startingFakes(privateRoot(), {}, refusingPastes);
    const ref = await runtime.create(spec());
    const outcomes = await Promise.all(
      ["not-ready", "unavailable", "stale-generation", "exited"].map((code) =>
        runtime.paste(ref, code, false).catch((error: unknown) => error),
      ),
    );
    expect(outcomes).toEqual([
      expect.objectContaining({ name: "PasteRefused", message: "the gate said not-ready" }),
      expect.objectContaining({ name: "PasteRefused", message: "the gate said unavailable" }),
      expect.objectContaining({ reason: "process-replaced" }),
      expect.any(ProcessState),
    ]);
    expect(outcomes[0]).toBeInstanceOf(PasteRefused);
    expect(terminals.get(ref.terminalId)!.connections.flatMap((c) => c.requests)).toHaveLength(4);
  });

  it("refuses every paste to a holder older than the gate, after checking its text and ref, and sends it nothing", async () => {
    const { runtime, ref, fake } = await made({ version: "1.2", protocol: ["1.2"] });
    await expect(runtime.paste(ref, "make\r", true)).rejects.toBeInstanceOf(RangeError);
    await expect(
      runtime.paste(refWith(ref, { generation: "1" }), "make", false),
    ).rejects.toMatchObject({
      reason: "process-replaced",
    });
    await expect(runtime.paste(ref, "make", true)).rejects.toThrow(
      new PasteRefused(
        "this terminal's holder predates gated paste; restart the terminal to paste",
      ),
    );
    expect(fake.connections.flatMap((c) => c.requests)).toEqual([]);
    const exited = await made({ exit: { type: "exited", code: 0 } });
    await expect(exited.runtime.paste(exited.ref, "make", false)).rejects.toBeInstanceOf(
      ProcessState,
    );
  });
});

/** Answers `screen` with a prompt and the history asked for, or refuses it with `code`. */
const screens =
  (code?: string): Handler =>
  (holder, request) => {
    if (request.type !== "screen") return ok(holder, request);
    if (code !== undefined) {
      const body = { request: "screen", code, message: "lost" };
      return holder.send({ type: "error", id: request.id, body });
    }
    const body = { text: "$ ls\n", history: request.body.history };
    holder.send({ type: "screen", id: request.id, body });
  };

async function screened(hello: Partial<HolderHelloReply>, handle: Handler) {
  const { runtime, terminals } = startingFakes(privateRoot(), hello, handle);
  const ref = await runtime.create(spec());
  return { runtime, ref, fake: terminals.get(ref.terminalId)! };
}

const screenReaders = (fake: FakeTerminal) =>
  fake.connections.filter((c) => c.requests.some((r) => r.type === "screen"));

describe("HolderRuntime: reading a terminal's screen", () => {
  it("reads it once its process has exited too, then hangs up", async () => {
    const { runtime, ref, fake } = await screened({ exit: { type: "exited", code: 0 } }, screens());
    expect(await runtime.screen(ref, 3)).toEqual({ text: "$ ls\n", history: 3 });
    const [reader, ...more] = screenReaders(fake);
    expect([reader?.requests.map((r) => r.type), more]).toEqual([["screen"], []]);
    await expect.poll(() => hungUp.has(reader!.holder)).toBe(true);
  });

  it("refuses a holder older than screen reads, to be restarted, and asks it nothing", async () => {
    const { runtime, ref, fake } = await screened({ version: "1.3", protocol: ["1.3"] }, screens());
    await expect(runtime.screen(ref, 0)).rejects.toThrow(
      new TerminalPredates(ref.terminalId, "screen reads"),
    );
    expect(screenReaders(fake)).toEqual([]);
  });

  it.each(["unavailable", "snapshot-too-large"] as const)(
    "calls a screen its holder refuses as %s unreadable",
    async (code) => {
      const { runtime, ref } = await screened({}, screens(code));
      await expect(runtime.screen(ref, 0)).rejects.toThrow(
        new ScreenUnreadable(ref.terminalId, "lost"),
      );
    },
  );
});

describe("HolderRuntime: watching agents' titles", () => {
  it("tells an agent's terminal, and never its title, as its watch opens and at each title its holder reports", async () => {
    const { runtime, terminals, reports } = watched(privateRoot(), undefined, { title: "first" });
    const ref = await runtime.create(agentSpec());
    const fake = terminals.get(ref.terminalId)!;
    await expect.poll(() => reports).toEqual([[ref.terminalId]]);
    const [watch, ...more] = await lasting(fake);
    expect(more).toEqual([]);
    watch!.holder.send({ type: "title", body: { offset: 3, text: "the thread" } });
    await expect.poll(() => reports).toEqual([[ref.terminalId], [ref.terminalId]]);
    expect(watch!.requests).toEqual([]);
    expect(watch!.holder.hello).toEqual(expect.objectContaining({ writer: false }));
  });

  it("watches an agent's terminal as it is created, not at the next listing", async () => {
    const root = privateRoot();
    const { runtime, terminals } = startingFakes(root, {}, undefined, {}, { titleSyncMs: 60_000 });
    const told: string[] = [];
    onTestFinished(runtime.onTitle((terminalId) => told.push(terminalId)));
    const ref = await runtime.create(agentSpec());
    await expect.poll(() => told).toEqual([ref.terminalId]);
    expect((await lasting(terminals.get(ref.terminalId)!)).length).toBe(1);
  });

  it("finds agents' terminals already running, and never watches a shell's", async () => {
    const root = privateRoot();
    const { runtime, terminals } = startingFakes(root);
    const running = await runtime.create(agentSpec());
    const shell = await runtime.create(spec());
    const told: string[] = [];
    onTestFinished(runtime.onTitle((terminalId) => told.push(terminalId)));
    await expect.poll(() => told).toEqual([running.terminalId]);
    expect(await lasting(terminals.get(shell.terminalId)!)).toEqual([]);
  });

  it("keeps one connection to an agent's holder across listings and respawns, and none once it closes", async () => {
    const exited = { exit: { type: "exited", code: 0 } } as const;
    const { runtime, terminals, told } = watched(privateRoot(), respawning, exited);
    const ref = await runtime.create(agentSpec());
    const fake = terminals.get(ref.terminalId)!;
    await expect.poll(() => told).toEqual([ref.terminalId]);
    await runtime.respawn(ref, { ...agentSpec(), generation: 1 });
    await listings(fake, 3);
    expect([(await lasting(fake)).length, told]).toEqual([1, [ref.terminalId]]);
    await runtime.close(ref);
    await expect.poll(() => openTo(fake).length).toBe(0);
  });

  it("keeps watching a terminal a listing leaves out, as one whose holder couldn't be read", async () => {
    const root = privateRoot();
    const { runtime, terminals, told, errors } = watched(root);
    const ref = await runtime.create(agentSpec());
    const fake = terminals.get(ref.terminalId)!;
    await expect.poll(() => told).toEqual([ref.terminalId]);
    const [watch] = await lasting(fake);
    chmodSync(holderSocket(root, ref.terminalId), 0o000);
    await expect.poll(() => errors.length).toBeGreaterThan(0);
    await sleep(100);
    watch!.holder.send({ type: "title", body: { offset: 0, text: "still heard" } });
    await expect.poll(() => told).toEqual([ref.terminalId, ref.terminalId]);
  });

  it("watches the holder that runs a terminal now, not an older one that kept its connection", async () => {
    const root = privateRoot();
    const { runtime, terminals, told } = watched(root);
    const ref = await runtime.create(agentSpec());
    const old = terminals.get(ref.terminalId)!;
    await expect.poll(() => told).toEqual([ref.terminalId]);
    // The old holder keeps its connections; a new one binds the terminal's socket.
    rmSync(holderSocket(root, ref.terminalId));
    const tags = encodeTags({ kind: "agent", agentId: newId("agent") });
    const now = await fakeTerminal(root, ref.terminalId, {
      tags,
      holderStart: FAKE_START + 1,
    });
    await expect.poll(() => told).toEqual([ref.terminalId, ref.terminalId]);
    await expect.poll(() => openTo(old).length).toBe(0);
    expect((await lasting(now)).length).toBe(1);
  });

  it("watches again, at the next listing, a holder that hung up on its watch", async () => {
    const { runtime, terminals, told } = watched(privateRoot());
    const ref = await runtime.create(agentSpec());
    const fake = terminals.get(ref.terminalId)!;
    await expect.poll(() => told).toEqual([ref.terminalId]);
    const [watch] = await lasting(fake);
    watch!.holder.hangUp();
    await expect.poll(() => told).toEqual([ref.terminalId, ref.terminalId]);
    expect((await lasting(fake)).length).toBe(1);
  });

  it("ends a watch whose connection was still opening when the last listener went", async () => {
    const root = privateRoot();
    const held = await handAnswered(root);
    const { runtime } = runtimeAt(root, { titleSyncMs: 60_000 });
    const told: string[] = [];
    const stop = runtime.onTitle((id) => told.push(id));
    onTestFinished(stop);
    await held.answer(0);
    await expect.poll(() => held.opened.length).toBe(2);
    stop();
    await held.answer(1);
    await expect.poll(() => hungUp.has(held.opened[1]!)).toBe(true);
    expect(told).toEqual([]);
  });

  it.each([
    ["another holder", { holderStart: FAKE_START + 1 }],
    ["another terminal", { terminalId: newId("term") }],
  ])("refuses a watch answered by %s than the listing named", async (_, other) => {
    const root = privateRoot();
    const held = await handAnswered(root);
    const { runtime } = runtimeAt(root, { titleSyncMs: 60_000 });
    const told: string[] = [];
    onTestFinished(runtime.onTitle((id) => told.push(id)));
    await held.answer(0);
    await held.answer(1, other, titleFrame("not its"));
    await expect.poll(() => hungUp.has(held.opened[1]!)).toBe(true);
    expect(told).toEqual([]);
  });

  it("ends every watch once the last listener goes, and opens none after", async () => {
    const { runtime, terminals, told, stop } = watched(privateRoot());
    const ref = await runtime.create(agentSpec());
    const fake = terminals.get(ref.terminalId)!;
    const other = runtime.onTitle(() => {});
    onTestFinished(other);
    await expect.poll(() => told).toEqual([ref.terminalId]);
    stop();
    expect((await lasting(fake)).length).toBe(1);
    other();
    await expect.poll(() => openTo(fake).length).toBe(0);
    await sleep(100);
    expect([openTo(fake).length, told]).toEqual([0, [ref.terminalId]]);
  });
});

describe("HolderRuntime: streams", () => {
  it("attaches on the holder's snapshot, and delivers what follows it to callbacks set after", async () => {
    const { runtime, ref, vt } = await attachable(5, (holder) =>
      holder.send(data(5, "ab"), { type: "alternate", body: { offset: 7, on: true } }),
    );
    const attached = await runtime.attach(ref, null);
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

  it("attaches with the history depth its holder says it keeps, not the runtime's default", async () => {
    const { runtime, ref } = await attachable(5, () => {}, 0, { hello: { historyLines: 321 } });
    const attached = await runtime.attach(ref, null);
    expect(attached.historyLines).toBe(321);
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
    const { stream } = await runtime.attach(ref, null);
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
      const { stream } = await runtime.attach(ref, null);
      stream.onClose((why) => whys.push(why));
    }
    await expect.poll(() => whys.toSorted()).toEqual(["behind", "ended"]);
  });

  it("sends every stream's input and resize on one writer connection, apart from its reader", async () => {
    const { runtime, ref, fake } = await attachable();
    const first = await runtime.attach(ref, { cols: 90, rows: 30 });
    const second = await runtime.attach(ref, null);
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
    const first = await runtime.attach(ref, { cols: 90, rows: 30 });
    await expect.poll(() => writers()).toHaveLength(1);
    const old = writers()[0]!.holder;
    const order: string[] = [];
    void old.ended.then(() => order.push("old hung up"));
    // A holder that has stopped reading holds the old connection's hang-up behind its input.
    old.stopReading();
    first.stream.write(new Uint8Array(4 * 1024 * 1024));
    await new Promise((wait) => setTimeout(wait, 50));
    first.stream.close();
    const second = runtime.attach(ref, { cols: 91, rows: 30 });
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
    const { stream } = await runtime.attach(ref, null);
    const told: string[] = [];
    stream.onFailure((failure) => told.push(failure.what));
    stream.write(Buffer.from("a"));
    await expect.poll(() => told, { timeout: 5_000 }).toEqual(["input"]);
    const asked = fake.connections.filter((c) => c.holder.hello?.writer === true);
    expect(asked).toHaveLength(1 + WRITER_RETRY_MS.length);
    await Promise.all(asked.map((c) => c.holder.closed));
    expect(asked.flatMap((c) => c.requests).filter((r) => r.type === "input")).toEqual([]);
    const late = await runtime.attach(ref, null);
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
    const attached = await runtime.attach(ref, null);
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
    const delivered = vi.spyOn(HolderStream.prototype, "event");
    const switched = { type: "alternate", body: { offset: 0, on: true } } as const;
    const { runtime, ref, fake } = await attachable(0, () => {}, 0, {
      // The switch and the resize's answer go out on different sockets, which nothing orders:
      // the answer waits until the reader has delivered the switch, so it lands before attach.
      duringResize: async () => {
        readers().at(-1)!.holder.send(switched);
        await vi.waitFor(() => expect(delivered).toHaveBeenCalledWith(switched));
      },
    });
    terminal = fake;
    const attached = await runtime.attach(ref, { cols: 90, rows: 30 });
    expect(attached.alternate).toBe(true);
    const pushed: boolean[] = [];
    attached.stream.onAlternate((on) => pushed.push(on));
    readers()
      .at(-1)!
      .holder.send({ type: "alternate", body: { offset: 0, on: false } });
    await expect.poll(() => pushed).toEqual([false]);
    attached.stream.close();
  });

  it("refuses input past what a terminal holds unsent, and sends none of it", async () => {
    const { runtime, ref, fake } = await attachable();
    const { stream } = await runtime.attach(ref, null);
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
    const { stream } = await runtime.attach(ref, null);
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
    const { stream } = await runtime.attach(ref, null);
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
    const { stream } = await runtime.attach(ref, null);
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
    const { stream } = await runtime.attach(ref, null);
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

/** Foregrounds read, by terminal. */
const byTerminal = (read: Awaited<ReturnType<HolderRuntime["foregrounds"]>>) =>
  Object.fromEntries(read.map(({ ref, ...rest }) => [ref.terminalId, rest]));

const sorted = (pids: readonly number[]) => [...pids].toSorted((a, b) => a - b);

describe("HolderRuntime: what holds terminals' foregrounds", () => {
  /** When every foreground group's leader started, as its holder says. */
  const LEADER_START = 1_700_000_100;
  /**
   * When this process started, as `ps` would show it: a leader that reads for real, so a read
   * that ignores the seam finds it.
   */
  const OWN_START = Math.floor(Date.now() / 1000 - process.uptime());
  /** A pid above the system's limit: no process, and so no working directory, has it. */
  const NO_CWD = FAKE_PID + 7;

  /** Answers `foreground` naming `pgid`, led by a process other than the terminal's own. */
  const leading =
    (pgid: number, pgidStart: number): Handler =>
    (holder, request) => {
      if (request.type !== "foreground") return ok(holder, request);
      const body = { childPid: FAKE_PID, childStart: FAKE_START, pgid, pgidStart };
      holder.send({ type: "foreground", id: request.id, body });
    };

  type Commands = NonNullable<HolderRuntimeOptions["commands"]>;
  type Read = Awaited<ReturnType<Commands>>;

  /** The commands seam, answering each read in turn and recording the pids each was asked. */
  function commandsReading(...reads: ((pids: readonly number[]) => Read)[]) {
    const asked: number[][] = [];
    const commands: Commands = async (pids) => {
      asked.push(sorted(pids));
      const read = reads[asked.length - 1];
      if (read === undefined) throw new Error(`commands read a ${asked.length}th time`);
      return read(pids);
    };
    return { asked, commands };
  }

  /** Every pid asked, led by `comm`, started when its holder says. */
  const all =
    (comm: string, start = LEADER_START) =>
    (pids: readonly number[]): Read =>
      new Map(pids.map((pid) => [pid, { start, comm }]));

  async function terminalsLedBy(root: string, pgids: readonly number[], start = LEADER_START) {
    const ids: string[] = [];
    for (const pgid of pgids) {
      const terminalId = newId("term");
      await fakeTerminal(root, terminalId, {}, leading(pgid, start));
      ids.push(terminalId);
    }
    return ids;
  }

  it("reads every leader's command at once, and again only the leaders with a directory", async () => {
    const root = privateRoot();
    const pgids = [process.pid, process.ppid, NO_CWD];
    const { asked, commands } = commandsReading(all("/usr/bin/vim"), all("/usr/bin/vim"));
    const { runtime } = runtimeAt(root, { commands });
    const [own, parent, gone] = await terminalsLedBy(root, pgids);
    const read = await runtime.foregrounds(new Set([own, parent, gone].map(String)));
    expect([asked, byTerminal(read)]).toEqual([
      [sorted(pgids), sorted([process.pid, process.ppid])],
      {
        [String(own)]: { command: "vim", own: false, cwd: expect.any(String) },
        [String(parent)]: { command: "vim", own: false, cwd: expect.any(String) },
        [String(gone)]: { command: "vim", own: false, cwd: null },
      },
    ]);
  });

  it("leaves out a terminal whose leader ps doesn't show, or shows started at another time", async () => {
    const root = privateRoot();
    const later = LEADER_START + START_SKEW_S + 1;
    const { commands } = commandsReading(
      () =>
        new Map([
          [NO_CWD, { start: LEADER_START + START_SKEW_S, comm: "less" }],
          [NO_CWD + 1, { start: later, comm: "less" }],
        ]),
      all("less"),
    );
    const { runtime } = runtimeAt(root, { commands });
    const [shown, reused, missing] = await terminalsLedBy(root, [NO_CWD, NO_CWD + 1, NO_CWD + 2]);
    const read = await runtime.foregrounds(new Set([shown, reused, missing].map(String)));
    expect(byTerminal(read)).toEqual({
      [String(shown)]: { command: "less", own: false, cwd: null },
    });
  });

  it("refuses the sweep when its leaders can't be read, and reads no further", async () => {
    const root = privateRoot();
    const { asked, commands } = commandsReading(() => "unreadable");
    const { runtime } = runtimeAt(root, { commands });
    const ids = await terminalsLedBy(root, [process.pid], OWN_START);
    await expect(runtime.foregrounds(new Set(ids.map(String)))).rejects.toThrow("can't read");
    expect(asked).toHaveLength(1);
  });

  it("keeps the commands and drops every directory when the second read can't be made", async () => {
    const root = privateRoot();
    const { commands } = commandsReading(all("htop"), () => "unreadable");
    const { runtime } = runtimeAt(root, { commands });
    const [own] = await terminalsLedBy(root, [process.pid]);
    expect(byTerminal(await runtime.foregrounds(new Set([String(own)])))).toEqual({
      [String(own)]: { command: "htop", own: false, cwd: null },
    });
  });

  it("drops a directory whose leader has changed by the second read", async () => {
    const root = privateRoot();
    const { commands } = commandsReading(all("htop"), all("htop", LEADER_START + 60));
    const { runtime } = runtimeAt(root, { commands });
    const [own] = await terminalsLedBy(root, [process.pid]);
    expect(byTerminal(await runtime.foregrounds(new Set([String(own)])))).toEqual({
      [String(own)]: { command: "htop", own: false, cwd: null },
    });
  });

  it("reads one terminal's foreground with one read of its leader", async () => {
    const root = privateRoot();
    const { asked, commands } = commandsReading(all("/bin/-zsh"));
    const { runtime } = runtimeAt(root, { commands });
    const [terminalId] = await terminalsLedBy(root, [NO_CWD]);
    const [ref] = (await runtime.inventory()).map((e) => e.ref);
    expect([ref?.terminalId, await runtime.foreground(ref!), asked]).toEqual([
      terminalId,
      { command: "-zsh", own: false },
      [[NO_CWD]],
    ]);
  });

  it("refuses one terminal's foreground when its leader can't be read", async () => {
    const root = privateRoot();
    const { commands } = commandsReading(() => "unreadable");
    const { runtime } = runtimeAt(root, { commands });
    await terminalsLedBy(root, [process.pid], OWN_START);
    const [ref] = (await runtime.inventory()).map((e) => e.ref);
    await expect(runtime.foreground(ref!)).rejects.toThrow("can't read terminal");
  });
});
