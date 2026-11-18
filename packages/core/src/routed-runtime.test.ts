import { describe, expect, it } from "vitest";
import { newId } from "./ids.ts";
import { healthOfEach, RoutedRuntime, UnknownRuntime } from "./routed-runtime.ts";
import type { RuntimeAdapter, RuntimeRef, TerminalSpec } from "./runtime.ts";
import { FakeRuntime, fakeContractHarness } from "./testing/fake-runtime.ts";
import { runtimeContract } from "./testing/runtime-contract.ts";

function pair() {
  const logged: unknown[][] = [];
  const tmux = new FakeRuntime({ kind: "tmux" });
  const holder = new FakeRuntime({ kind: "holder", attach: "snapshot" });
  const routed = new RoutedRuntime({
    runtimes: [tmux, holder],
    defaultKind: "tmux",
    log: (...line) => logged.push(line),
  });
  return { tmux, holder, routed, logged };
}

/**
 * Three runtimes whose foreground reads each fail with the error `fail` last gave its kind, and
 * read as usual once it is given none.
 */
function faulty() {
  const logged: unknown[][] = [];
  const faults = new Map<string, Error>();
  const runtimes = ["tmux", "holder", "other"].map((kind) => {
    const runtime = new FakeRuntime({ kind });
    const read = runtime.foregrounds.bind(runtime);
    runtime.foregrounds = (ids) => {
      const fault = faults.get(kind);
      return fault === undefined ? read(ids) : Promise.reject(fault);
    };
    return runtime;
  });
  const routed = new RoutedRuntime({
    runtimes,
    defaultKind: "tmux",
    log: (...line) => logged.push(line),
  });
  const fail = (kind: string, fault?: Error) =>
    fault === undefined ? faults.delete(kind) : faults.set(kind, fault);
  const sweep = (times = 1) =>
    Array.from({ length: times }).reduce<Promise<unknown>>(
      (done) => done.then(() => routed.foregrounds(new Set())),
      Promise.resolve(),
    );
  return { routed, logged, fail, sweep };
}

const cantRead = (kind: string, err: Error) => [`runtime ${kind}: can't read foregrounds:`, err];
const readsAgain = (kind: string) => [`runtime ${kind}: foregrounds read again`];

const spec = (argv: TerminalSpec["argv"] = ["sleep", "300"]): TerminalSpec => ({
  terminalId: newId("term"),
  tags: { kind: "shell" },
  argv,
  cwd: "/w",
  env: {},
  size: { cols: 80, rows: 24 },
  generation: 0,
  historyLines: 10_000,
});

const ids = async (runtime: RuntimeAdapter) =>
  (await runtime.inventory()).map((e) => e.ref.terminalId);

const routedOf = (runtime: RuntimeAdapter) => {
  if (!(runtime instanceof RoutedRuntime)) throw new Error("not the routed runtime");
  return runtime;
};

/** The suite's terminals all land on the non-default runtime, so every verb has to be routed. */
const fake = fakeContractHarness("snapshot");
runtimeContract("RoutedRuntime over two FakeRuntimes", {
  ...fake,
  make: () => {
    const tmux = new FakeRuntime({ kind: "tmux" });
    const holder = new FakeRuntime({ kind: "holder", attach: "snapshot" });
    const routed = new RoutedRuntime({
      runtimes: [tmux, holder],
      defaultKind: "tmux",
      log: () => {},
    });
    const create = routed.create.bind(routed);
    routed.create = (s) => create({ ...s, runtime: "holder" });
    return { runtime: routed, dispose: () => {} };
  },
  unreadable: (runtime) => fake.unreadable(routedOf(runtime).only("holder")),
  replaceProcess: (runtime, ref) => fake.replaceProcess(routedOf(runtime).only("holder"), ref),
  vanish: (runtime, ref) => fake.vanish(routedOf(runtime).only("holder"), ref),
  reboot: (runtime) => fake.reboot(routedOf(runtime).only("holder")),
});

const make = (runtimes: RuntimeAdapter[], defaultKind: string) =>
  new RoutedRuntime({ runtimes, defaultKind, log: () => {} });

/** tmux and a default holder, neither of which can be read, each in use while `inUse` has it. */
function unreadable(inUse: ReadonlySet<string>): RoutedRuntime {
  const tmux = new FakeRuntime({ kind: "tmux" });
  const holder = new FakeRuntime({ kind: "holder" });
  tmux.disconnect();
  holder.disconnect();
  return new RoutedRuntime({
    runtimes: [tmux, holder],
    defaultKind: "holder",
    inUse: (kind) => inUse.has(kind),
    log: () => {},
  });
}

describe("RoutedRuntime", () => {
  it("creates a terminal on the runtime its spec names, and on the default when none", async () => {
    const { tmux, holder, routed } = pair();
    const onHolder = await routed.create({ ...spec(), runtime: "holder" });
    const onDefault = await routed.create(spec());
    expect([onHolder.runtime, onDefault.runtime, await ids(holder), await ids(tmux)]).toEqual([
      "holder",
      "tmux",
      [onHolder.terminalId],
      [onDefault.terminalId],
    ]);
  });

  it("sends a verb on a ref to the runtime the ref names, and to no other", async () => {
    const { tmux, holder, routed } = pair();
    const onTmux = await routed.create(spec());
    const onHolder = await routed.create({ ...spec(), runtime: "holder" });
    await routed.close(onHolder);
    const attached = await routed.attach(onTmux, null);
    attached.stream.close();
    expect([
      await ids(holder),
      await ids(tmux),
      attached.kind,
      routed.attachCommand(onTmux),
    ]).toEqual([[], [onTmux.terminalId], "history", `fake-attach ${onTmux.terminalId}`]);
  });

  it("reads a terminal's screen from the runtime its ref names", async () => {
    const { tmux, holder, routed } = pair();
    const onTmux = await routed.create(spec());
    const onHolder = await routed.create({ ...spec(), runtime: "holder" });
    tmux.output(onTmux, "on tmux");
    holder.output(onHolder, "on the holder");
    expect(await routed.screen(onHolder, 0)).toEqual({ text: "on the holder\n", history: 0 });
  });

  it("refuses a ref on a runtime it doesn't run, and never calls that terminal gone", async () => {
    const { routed } = pair();
    const ref: RuntimeRef = { terminalId: newId("term"), runtime: "elsewhere", locator: {} };
    await expect(routed.close(ref)).rejects.toBeInstanceOf(UnknownRuntime);
    await expect(routed.signal(ref, "SIGTERM")).rejects.toBeInstanceOf(UnknownRuntime);
    expect(() => routed.attachCommand(ref)).toThrow(UnknownRuntime);
    expect(await routed.gone(ref)).toBe(false);
  });

  it("refuses two runtimes of one kind, and a default it doesn't run", () => {
    expect(() => make([new FakeRuntime(), new FakeRuntime()], "fake")).toThrow(RangeError);
    expect(() => make([new FakeRuntime()], "holder")).toThrow(UnknownRuntime);
  });

  it("lists every runtime's terminals, and throws when any runtime can't be read", async () => {
    const { tmux, holder, routed } = pair();
    const a = await routed.create(spec());
    const b = await routed.create({ ...spec(), runtime: "holder" });
    const both = await ids(routed);
    holder.disconnect();
    await expect(routed.inventory()).rejects.toThrow("can't be read");
    expect([both.toSorted(), await ids(tmux)]).toEqual([
      [a.terminalId, b.terminalId].toSorted(),
      [a.terminalId],
    ]);
  });

  it("reads as the worst of its runtimes' health, each judged by its own refs", async () => {
    const { tmux, routed } = pair();
    const idle = await routed.health();
    await routed.create({ ...spec(), runtime: "holder" });
    const running = await routed.health();
    tmux.disconnect();
    const blind = await routed.health();
    expect([idle.state, running.state, blind.state, running.version]).toEqual([
      "not-running",
      "healthy",
      "unreachable",
      "fake",
    ]);
  });

  describe("a runtime neither the default nor in use", () => {
    it("is reported unused without being read, and counts for nothing in the worst", async () => {
      const routed = unreadable(new Set());
      expect([await healthOfEach(routed), (await routed.health()).state]).toEqual([
        [
          { kind: "tmux", state: "unused", version: null },
          { kind: "holder", state: "unreachable", version: null },
        ],
        "unreachable",
      ]);
    });

    it("is read once a terminal is open on it, and fails like any other", async () => {
      const inUse = new Set<string>();
      const routed = unreadable(inUse);
      const idle = (await healthOfEach(routed)).map((r) => r.state);
      inUse.add("tmux");
      const used = (await healthOfEach(routed)).map((r) => r.state);
      expect([idle, used]).toEqual([
        ["unused", "unreachable"],
        ["unreachable", "unreachable"],
      ]);
    });

    it("isn't asked for foregrounds, which come from the runtimes read", async () => {
      const tmux = new FakeRuntime({ kind: "tmux" });
      const holder = new FakeRuntime({ kind: "holder" });
      const asked: string[] = [];
      for (const runtime of [tmux, holder]) {
        const read = runtime.foregrounds.bind(runtime);
        runtime.foregrounds = (terminalIds) => {
          asked.push(runtime.kind);
          return read(terminalIds);
        };
      }
      const routed = new RoutedRuntime({
        runtimes: [tmux, holder],
        defaultKind: "holder",
        inUse: () => false,
        log: () => {},
      });
      const ref = await routed.create(spec());
      await routed.foregrounds(new Set([ref.terminalId]));
      expect(asked).toEqual(["holder"]);
    });

    it("leaves the worst to the runtimes read", async () => {
      const tmux = new FakeRuntime({ kind: "tmux" });
      const holder = new FakeRuntime({ kind: "holder" });
      tmux.disconnect();
      await holder.create(spec());
      const routed = new RoutedRuntime({
        runtimes: [tmux, holder],
        defaultKind: "holder",
        inUse: () => false,
        log: () => {},
      });
      expect(await routed.health()).toEqual({ state: "healthy", version: "fake" });
    });
  });

  it("still sees one runtime's foregrounds while the other can't be read, and says why", async () => {
    const { tmux, routed, logged } = pair();
    await routed.create(spec());
    const shell = await routed.create({ ...spec(), runtime: "holder" });
    tmux.disconnect();
    const seen = await routed.foregrounds(new Set([shell.terminalId]));
    expect([seen.map((f) => f.ref.terminalId), logged]).toEqual([
      [shell.terminalId],
      [cantRead("tmux", new Error("the fake runtime's server can't be read"))],
    ]);
  });

  it("says a runtime's foreground fault once while it lasts, with the error itself", async () => {
    const { logged, fail, sweep } = faulty();
    const fault = new Error("ps unreadable");
    fail("holder", fault);
    await sweep(3);
    expect(logged).toHaveLength(1);
    expect(logged[0]?.[1]).toBe(fault);
  });

  it("says a runtime's foreground fault again when its message changes", async () => {
    const { logged, fail, sweep } = faulty();
    const [first, then] = [new Error("ps unreadable"), new Error("EACCES")];
    fail("holder", first);
    await sweep(2);
    fail("holder", then);
    await sweep(2);
    expect(logged).toEqual([cantRead("holder", first), cantRead("holder", then)]);
  });

  it("says once that a runtime reads again, and a fault after that afresh", async () => {
    const { logged, fail, sweep } = faulty();
    const fault = new Error("ps unreadable");
    fail("holder", fault);
    await sweep(2);
    fail("holder");
    await sweep(2);
    fail("holder", new Error("ps unreadable"));
    await sweep();
    expect(logged).toEqual([
      cantRead("holder", fault),
      readsAgain("holder"),
      cantRead("holder", fault),
    ]);
  });

  it("says the same fault on two runtimes for each of them", async () => {
    const { logged, fail, sweep } = faulty();
    const fault = new Error("EACCES");
    fail("tmux", fault);
    fail("holder", fault);
    await sweep(2);
    expect(logged).toEqual([cantRead("tmux", fault), cantRead("holder", fault)]);
  });

  it("neither says nor clears a fault when no runtime can be read", async () => {
    const { routed, logged, fail, sweep } = faulty();
    const fault = new Error("ps unreadable");
    fail("holder", fault);
    await sweep();
    for (const kind of ["tmux", "other"]) fail(kind, new Error("down"));
    await expect(routed.foregrounds(new Set())).rejects.toThrow("down");
    for (const kind of ["tmux", "other"]) fail(kind);
    await sweep();
    expect(logged).toEqual([cantRead("holder", fault)]);
  });

  it("throws for foregrounds only when no runtime can be read", async () => {
    const { tmux, holder, routed } = pair();
    tmux.disconnect();
    holder.disconnect();
    await expect(routed.foregrounds(new Set())).rejects.toThrow("can't be read");
  });

  it("unions every runtime's compatibility, a runtime without one adding nothing", async () => {
    const { holder, routed } = pair();
    const [old, current] = [newId("term"), newId("term")];
    Object.assign(holder, {
      compatibility: async () => ({
        outdated: new Map([[old, ["2.0"]]]),
        served: new Set([current]),
      }),
    });
    const { outdated, served } = await routed.compatibility();
    expect([[...outdated], [...served]]).toEqual([[[old, ["2.0"]]], [current]]);
  });

  it("hears every runtime's exits until unsubscribed from all of them", async () => {
    const { routed } = pair();
    const a = await routed.create(spec(["sh", "-c", "exit 3"]));
    const b = await routed.create({ ...spec(["sh", "-c", "exit 4"]), runtime: "holder" });
    const heard: string[] = [];
    const off = routed.onExit((ref, status) =>
      heard.push(`${ref.runtime}:${JSON.stringify(status)}`),
    );
    await Promise.resolve();
    off();
    await routed.create(spec(["sh", "-c", "exit 5"]));
    await Promise.resolve();
    expect([heard.toSorted(), a.runtime, b.runtime]).toEqual([
      ['holder:{"type":"exited","code":4}', 'tmux:{"type":"exited","code":3}'],
      "tmux",
      "holder",
    ]);
  });
});
