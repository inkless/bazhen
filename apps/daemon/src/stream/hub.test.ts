import { describe, expect, it } from "vitest";
import {
  newId,
  type AttachmentId,
  type RuntimeAdapter,
  type Size,
  type TerminalId,
} from "@bazhen/core";
import type { AttachmentMode, StreamServerFrame } from "@bazhen/protocol";
import { TerminalHub, type AttachmentLog, type Viewer } from "./hub.ts";

/** A runtime whose single terminal echoes nothing and records what reaches it. */
function fakeRuntime() {
  const written: string[] = [];
  const sizes: Size[] = [];
  let attaches = 0;
  let closes = 0;
  let emit: ((s: string) => void) | undefined;
  let end: (() => void) | undefined;
  const runtime: RuntimeAdapter = {
    kind: "fake",
    health: () => Promise.reject(new Error("not used")),
    inventory: () => Promise.reject(new Error("not used")),
    create: () => Promise.reject(new Error("not used")),
    close: () => Promise.reject(new Error("not used")),
    snapshot: async () => "<screen>",
    attach: async () => {
      attaches++;
      return {
        onData: (cb) => (emit = (s) => cb(Buffer.from(s))),
        onClose: (cb) => (end = cb),
        write: (bytes) => written.push(Buffer.from(bytes).toString()),
        resize: async (size) => void sizes.push(size),
        close: () => void closes++,
      };
    },
  };
  return {
    runtime,
    written,
    sizes,
    emit: (s: string) => emit?.(s),
    end: () => end?.(),
    counts: () => ({ attaches, closes }),
  };
}

function viewer(mode: AttachmentMode = "interactive") {
  const seen: string[] = [];
  const frames: StreamServerFrame[] = [];
  let closed = false;
  const v: Viewer = {
    mode,
    send: (bytes) => seen.push(Buffer.from(bytes).toString()),
    notify: (frame) => frames.push(frame),
    close: () => (closed = true),
  };
  return { v, seen, frames, closed: () => closed };
}

function memoryLog() {
  const events: string[] = [];
  const log: AttachmentLog = {
    started: (a: AttachmentId) => events.push(`started ${a}`),
    ended: (a: AttachmentId, reason: string) => events.push(`ended ${a} ${reason}`),
    granted: (_t: TerminalId, a: AttachmentId, epoch: number) =>
      events.push(`granted ${a} ${epoch}`),
    epoch: () => 4,
  };
  return { log, events };
}

const ref = { terminalId: newId("term"), runtime: "fake", locator: {} };
const size = { cols: 80, rows: 24 };

describe("terminal hub", () => {
  it("serves every view of a terminal from one runtime client", async () => {
    const rt = fakeRuntime();
    const hub = new TerminalHub(rt.runtime, memoryLog().log);
    const a = viewer();
    const b = viewer("observe");
    await hub.join(ref, a.v, size);
    await hub.join(ref, b.v, size);
    rt.emit("out");
    expect([rt.counts().attaches, a.seen, b.seen]).toEqual([1, ["out"], ["<screen>", "out"]]);
  });

  it("passes keystrokes only from the driver, and drops the rest without queuing them", async () => {
    const rt = fakeRuntime();
    const hub = new TerminalHub(rt.runtime, memoryLog().log);
    const laptop = viewer();
    const phone = viewer();
    const l = await hub.join(ref, laptop.v, size);
    const p = await hub.join(ref, phone.v, size);
    l.engage();
    l.input(Buffer.from("a"));
    p.input(Buffer.from("b"));
    p.input(Buffer.from("c"));
    expect(rt.written).toEqual(["a"]);
    expect(phone.frames.filter((f) => f.type === "input_dropped")).toHaveLength(1);
  });

  it("moves the lease to the view the user engages, and tells every view", async () => {
    const rt = fakeRuntime();
    const { log, events } = memoryLog();
    const hub = new TerminalHub(rt.runtime, log);
    const laptop = viewer();
    const phone = viewer();
    const l = await hub.join(ref, laptop.v, size);
    const p = await hub.join(ref, phone.v, { cols: 40, rows: 50 });
    l.engage();
    p.engage();
    expect(laptop.frames.at(-1)).toEqual({ type: "lease", driver: false, epoch: 6 });
    expect(phone.frames.at(-1)).toEqual({ type: "lease", driver: true, epoch: 6 });
    expect(events.filter((e) => e.startsWith("granted"))).toEqual([
      `granted ${l.id} 5`,
      `granted ${p.id} 6`,
    ]);
    await expect.poll(() => rt.sizes.at(-1)).toEqual({ cols: 40, rows: 50 });
  });

  it("never gives the lease to an observer", async () => {
    const rt = fakeRuntime();
    const hub = new TerminalHub(rt.runtime, memoryLog().log);
    const watcher = viewer("observe");
    const w = await hub.join(ref, watcher.v, size);
    w.engage();
    w.input(Buffer.from("x"));
    expect(rt.written).toEqual([]);
  });

  it("sizes the terminal only from its driver", async () => {
    const rt = fakeRuntime();
    const hub = new TerminalHub(rt.runtime, memoryLog().log);
    const a = await hub.join(ref, viewer().v, size);
    const b = await hub.join(ref, viewer().v, size);
    a.engage();
    b.resize({ cols: 30, rows: 10 });
    a.resize({ cols: 100, rows: 30 });
    await expect.poll(() => rt.sizes).toEqual([size, { cols: 100, rows: 30 }]);
  });

  it("applies only the latest of a burst of resizes once the one in flight settles", async () => {
    const rt = fakeRuntime();
    const hub = new TerminalHub(rt.runtime, memoryLog().log);
    const a = await hub.join(ref, viewer().v, size);
    a.engage();
    for (let cols = 81; cols <= 90; cols++) a.resize({ cols, rows: 24 });
    await expect.poll(() => rt.sizes.at(-1)).toEqual({ cols: 90, rows: 24 });
    expect(rt.sizes).toEqual([size, { cols: 90, rows: 24 }]);
  });

  it("closes the runtime client when the last view leaves, and only then", async () => {
    const rt = fakeRuntime();
    const { log, events } = memoryLog();
    const hub = new TerminalHub(rt.runtime, log);
    const a = await hub.join(ref, viewer().v, size);
    const b = await hub.join(ref, viewer().v, size);
    a.leave();
    expect(rt.counts().closes).toBe(0);
    b.leave();
    expect([rt.counts().closes, events.at(-1)]).toEqual([1, `ended ${b.id} client_closed`]);
  });

  it("tells every view when the terminal itself goes away", async () => {
    const rt = fakeRuntime();
    const { log, events } = memoryLog();
    const hub = new TerminalHub(rt.runtime, log);
    const a = viewer();
    const attached = await hub.join(ref, a.v, size);
    rt.end();
    expect([a.frames.at(-1), a.closed(), events.at(-1)]).toEqual([
      { type: "exit" },
      true,
      `ended ${attached.id} terminal_closed`,
    ]);
  });
});
