import { describe, expect, it } from "vitest";
import { newId } from "./ids.ts";
import { RoutedRuntime, UnknownRuntime } from "./routed-runtime.ts";
import type { RuntimeAdapter, RuntimeRef, TerminalSpec } from "./runtime.ts";
import { FakeRuntime, fakeContractHarness } from "./testing/fake-runtime.ts";
import { runtimeContract } from "./testing/runtime-contract.ts";

function pair() {
  const errors: unknown[] = [];
  const tmux = new FakeRuntime({ kind: "tmux" });
  const holder = new FakeRuntime({ kind: "holder", attach: "snapshot" });
  const routed = new RoutedRuntime({
    runtimes: [tmux, holder],
    defaultKind: "tmux",
    onError: (err) => errors.push(err),
  });
  return { tmux, holder, routed, errors };
}

const spec = (argv: TerminalSpec["argv"] = ["sleep", "300"]): TerminalSpec => ({
  terminalId: newId("term"),
  tags: { kind: "shell" },
  argv,
  cwd: "/w",
  env: {},
  size: { cols: 80, rows: 24 },
  generation: 0,
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
      onError: () => {},
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
  new RoutedRuntime({ runtimes, defaultKind, onError: () => {} });

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
    const attached = await routed.attach(onTmux, null, 0);
    attached.stream.close();
    expect([
      await ids(holder),
      await ids(tmux),
      attached.kind,
      routed.attachCommand(onTmux),
    ]).toEqual([[], [onTmux.terminalId], "history", `fake-attach ${onTmux.terminalId}`]);
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

  it("still sees one runtime's foregrounds while the other can't be read, and says why", async () => {
    const { tmux, routed, errors } = pair();
    await routed.create(spec());
    const shell = await routed.create({ ...spec(), runtime: "holder" });
    tmux.disconnect();
    const seen = await routed.foregrounds(new Set([shell.terminalId]));
    expect([seen.map((f) => f.ref.terminalId), errors.length]).toEqual([[shell.terminalId], 1]);
  });

  it("throws for foregrounds only when no runtime can be read", async () => {
    const { tmux, holder, routed } = pair();
    tmux.disconnect();
    holder.disconnect();
    await expect(routed.foregrounds(new Set())).rejects.toThrow("can't be read");
  });

  it("names every runtime's outdated terminals, a runtime with none naming nothing", async () => {
    const { holder, routed } = pair();
    const old = newId("term");
    Object.assign(holder, { outdated: async () => new Map([[old, ["2.0"]]]) });
    expect([...(await routed.outdated())]).toEqual([[old, ["2.0"]]]);
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
