import { assert, describe, expect, it } from "vitest";
import { newId } from "../ids.ts";
import { FakeRuntime, type FakeRuntimeOptions } from "./fake-runtime.ts";
import { runtimeContract, snapshotContract, type ContractHarness } from "./runtime-contract.ts";

const fakeOf = (runtime: unknown) => {
  if (!(runtime instanceof FakeRuntime)) throw new Error("not the fake runtime");
  return runtime;
};

const harness = (attach: NonNullable<FakeRuntimeOptions["attach"]>): ContractHarness => ({
  make: () => ({ runtime: new FakeRuntime({ attach }), dispose: () => {} }),
  unreadable: (runtime) => fakeOf(runtime).disconnect(),
  replaceProcess: (runtime, ref) => fakeOf(runtime).replaceProcess(ref),
  vanish: (runtime, ref) => fakeOf(runtime).vanish(ref),
  reboot: (runtime) => fakeOf(runtime).reboot(),
  forge: (ref) => ({ ...ref, locator: { ...ref.locator, serverStart: "1" } }),
  exitMayBeUnknown: false,
  cwd: "/w",
  waitMs: 1_000,
});

runtimeContract("FakeRuntime", harness("history"));
runtimeContract("FakeRuntime in snapshot mode", harness("snapshot"));
snapshotContract("FakeRuntime in snapshot mode", harness("snapshot"));

describe("the fake runtime's controls", () => {
  it("records what reached a terminal, and ends every client when the terminal goes", async () => {
    const fake = new FakeRuntime();
    const ref = await fake.create({
      terminalId: newId("term"),
      tags: { kind: "shell" },
      argv: ["sleep", "300"],
      cwd: "/w",
      env: {},
      size: { cols: 80, rows: 24 },
      generation: 0,
    });
    fake.scroll(ref, "one\ntwo\nthree");
    const attached = await fake.attach(ref, null, 2);
    assert(attached.kind === "history", "attached with a snapshot");
    const { stream, history } = attached;
    let closed = false;
    stream.onClose(() => (closed = true));
    stream.write(new Uint8Array([97]));
    await stream.resize({ cols: 100, rows: 30 });
    const record = fake.clients(ref);
    fake.vanish(ref);
    expect([history, record, closed]).toEqual([
      "two\nthree",
      { attaches: [null], written: ["a"], resizes: [{ cols: 100, rows: 30 }], closes: 0 },
      true,
    ]);
  });
});
