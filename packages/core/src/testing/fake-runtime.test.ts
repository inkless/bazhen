import { describe, expect, it } from "vitest";
import { newId } from "../ids.ts";
import { FakeRuntime } from "./fake-runtime.ts";
import { runtimeContract } from "./runtime-contract.ts";

const fakeOf = (runtime: unknown) => {
  if (!(runtime instanceof FakeRuntime)) throw new Error("not the fake runtime");
  return runtime;
};

runtimeContract("FakeRuntime", {
  make: () => ({ runtime: new FakeRuntime(), dispose: () => {} }),
  unreadable: (runtime) => fakeOf(runtime).disconnect(),
  replacePane: (runtime, ref) => fakeOf(runtime).replacePane(ref),
  vanish: (runtime, ref) => fakeOf(runtime).vanish(ref),
  killServer: (runtime) => fakeOf(runtime).killServer(),
  cwd: "/w",
  waitMs: 1_000,
});

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
    const { stream, history } = await fake.attach(ref, null, 2);
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
