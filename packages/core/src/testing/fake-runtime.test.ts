import { assert, describe, expect, it } from "vitest";
import { newId } from "../ids.ts";
import { FakeRuntime, fakeContractHarness } from "./fake-runtime.ts";
import { runtimeContract } from "./runtime-contract.ts";

runtimeContract("FakeRuntime", fakeContractHarness("history"));
runtimeContract("FakeRuntime in snapshot mode", fakeContractHarness("snapshot"));

describe("the fake runtime's controls", () => {
  it("takes a respawned terminal's program back to its main screen, telling open streams", async () => {
    const fake = new FakeRuntime();
    const spec = {
      terminalId: newId("term"),
      tags: { kind: "shell" },
      argv: ["cat"],
      cwd: "/w",
      env: {},
      size: { cols: 80, rows: 24 },
      generation: 0,
    } as const;
    const ref = await fake.create(spec);
    const { stream } = await fake.attach(ref, null, 0);
    const pushed: boolean[] = [];
    stream.onAlternate((on) => pushed.push(on));
    fake.output(ref, "\x1b[?1049h");
    fake.exitProcess(ref);
    await fake.respawn(ref, { ...spec, generation: 1 });
    expect(pushed).toEqual([true, false]);
  });

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
