import headless from "@xterm/headless";
import { describe, expect, it } from "vitest";
import { newId, type AttachmentId, type TerminalId } from "@bazhen/core";
import { FakeRuntime } from "@bazhen/core/testing";
import type { AttachmentMode, StreamServerFrame } from "@bazhen/protocol";
import { TerminalClosed } from "./emulator.ts";
import { TerminalHub, ViewEnded, type AttachmentLog, type Viewer } from "./hub.ts";

/** What a browser shows after writing everything a view was sent: each non-blank line. */
async function screenOf(sent: readonly string[]): Promise<string[]> {
  const term = new headless.Terminal({ ...size, allowProposedApi: true });
  await new Promise<void>((resolve) => term.write(sent.join(""), resolve));
  const buffer = term.buffer.active;
  const lines = Array.from({ length: buffer.length }, (_, y) =>
    (buffer.getLine(y)?.translateToString(true) ?? "").trim(),
  );
  term.dispose();
  return lines.filter((line) => line !== "");
}

/** A runtime with one terminal, whose program echoes nothing, and what reaches it. */
async function fakeRuntime(history = "earlier output") {
  const runtime = new FakeRuntime();
  const ref = await runtime.create({
    terminalId: newId("term"),
    tags: { kind: "shell" },
    argv: ["sleep", "300"],
    cwd: "/w",
    env: {},
    size,
    generation: 0,
  });
  runtime.scroll(ref, history);
  const clients = runtime.clients(ref);
  return {
    runtime,
    ref,
    written: clients.written,
    sizes: clients.resizes,
    attachedAt: clients.attaches,
    emit: (s: string) => runtime.output(ref, s),
    end: () => runtime.vanish(ref),
    counts: () => ({ attaches: clients.attaches.length, closes: clients.closes }),
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

/** The same view, but `during` runs while its snapshot is being sent. */
function emittingOnSnapshot(view: Viewer, during: () => void): Viewer {
  return {
    ...view,
    notify: (frame) => {
      view.notify(frame);
      if (frame.type === "snapshot_start") during();
    },
  };
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

const size = { cols: 80, rows: 24 };

describe("terminal hub", () => {
  it("serves every view of a terminal from one runtime client", async () => {
    const rt = await fakeRuntime();
    const hub = new TerminalHub(rt.runtime, memoryLog().log);
    const a = viewer();
    const b = viewer("observe");
    await hub.join(rt.ref, a.v, size);
    await hub.join(rt.ref, b.v, size);
    rt.emit("out");
    expect([rt.counts().attaches, a.seen.at(-1), b.seen.at(-1)]).toEqual([1, "out", "out"]);
  });

  it("opens every view on the history and screen, then live output, with nothing missed or repeated", async () => {
    const rt = await fakeRuntime();
    const hub = new TerminalHub(rt.runtime, memoryLog().log);
    const first = viewer();
    await hub.join(rt.ref, first.v, size);
    rt.emit("one ");
    const late = viewer();
    await hub.join(
      rt.ref,
      emittingOnSnapshot(late.v, () => rt.emit("two ")),
      size,
    );
    rt.emit("three");
    expect([await screenOf(first.seen), await screenOf(late.seen)]).toEqual([
      ["earlier output", "one two three"],
      ["earlier output", "one two three"],
    ]);
  });

  it("never tells a view it is attached when the terminal closes while it opens", async () => {
    const rt = await fakeRuntime();
    const hub = new TerminalHub(rt.runtime, memoryLog().log);
    await hub.join(rt.ref, viewer().v, size);
    const late = viewer();
    await expect(
      hub.join(
        rt.ref,
        emittingOnSnapshot(late.v, () => rt.end()),
        size,
      ),
    ).rejects.toThrow(TerminalClosed);
    expect([late.frames.some((f) => f.type === "attached"), late.closed()]).toEqual([false, true]);
  });

  it("never tells a view it is attached when the terminal closes as its screen is sent", async () => {
    const rt = await fakeRuntime();
    const hub = new TerminalHub(rt.runtime, memoryLog().log);
    await hub.join(rt.ref, viewer().v, size);
    const late = viewer();
    const closingOnSend: Viewer = { ...late.v, send: () => rt.end() };
    await expect(hub.join(rt.ref, closingOnSend, size)).rejects.toThrow(ViewEnded);
    expect(late.frames.some((f) => f.type === "attached")).toBe(false);
  });

  it("tells a view it is attached only once it has its screen and is ready for input", async () => {
    const rt = await fakeRuntime();
    const hub = new TerminalHub(rt.runtime, memoryLog().log);
    await hub.join(rt.ref, viewer().v, size);
    const order: string[] = [];
    const late: Viewer = {
      mode: "interactive",
      send: () => order.push("bytes"),
      notify: (frame) => order.push(frame.type),
      close: () => {},
    };
    await hub.join(rt.ref, late, size);
    expect(order).toEqual(["lease", "snapshot_start", "bytes", "snapshot_end", "attached"]);
  });

  it("passes keystrokes only from the driver, and drops the rest without queuing them", async () => {
    const rt = await fakeRuntime();
    const hub = new TerminalHub(rt.runtime, memoryLog().log);
    const laptop = viewer();
    const watcher = viewer("observe");
    const l = await hub.join(rt.ref, laptop.v, size);
    const w = await hub.join(rt.ref, watcher.v, size);
    l.engage();
    l.input(Buffer.from("a"));
    w.input(Buffer.from("b"));
    w.input(Buffer.from("c"));
    expect(rt.written).toEqual(["a"]);
    expect(watcher.frames.filter((f) => f.type === "input_dropped")).toHaveLength(1);
  });

  it("drops a stray keystroke from an interactive view, and gives that view the lease", async () => {
    const rt = await fakeRuntime();
    const hub = new TerminalHub(rt.runtime, memoryLog().log);
    const laptop = viewer();
    const phone = viewer();
    const l = await hub.join(rt.ref, laptop.v, size);
    const p = await hub.join(rt.ref, phone.v, size);
    l.engage();
    p.input(Buffer.from("b"));
    p.input(Buffer.from("c"));
    expect([
      rt.written,
      laptop.frames.at(-1),
      phone.frames.some((f) => f.type === "input_dropped"),
    ]).toEqual([["c"], { type: "lease", driver: false, epoch: 6 }, false]);
  });

  it("never passes a terminal reply from the driver to the program", async () => {
    const rt = await fakeRuntime();
    const hub = new TerminalHub(rt.runtime, memoryLog().log);
    const d = await hub.join(rt.ref, viewer().v, size);
    d.engage();
    d.input(Buffer.from("\x1b[?1;2c"));
    d.input(Buffer.from("x"));
    expect(rt.written).toEqual(["x"]);
  });

  it("takes the lease for a stray keystroke, but not for a focus report", async () => {
    const rt = await fakeRuntime();
    const hub = new TerminalHub(rt.runtime, memoryLog().log);
    const laptop = viewer();
    const phone = viewer();
    const l = await hub.join(rt.ref, laptop.v, size);
    const p = await hub.join(rt.ref, phone.v, size);
    l.engage();
    p.input(Buffer.from("\x1b[O"));
    const afterFocusReport = laptop.frames.at(-1);
    p.input(Buffer.from("k"));
    expect([rt.written, afterFocusReport, laptop.frames.at(-1)]).toEqual([
      [],
      { type: "lease", driver: true, epoch: 5 },
      { type: "lease", driver: false, epoch: 6 },
    ]);
  });

  it("answers the runtime client's terminal queries itself, without asking any view", async () => {
    const rt = await fakeRuntime();
    const hub = new TerminalHub(rt.runtime, memoryLog().log);
    const a = viewer();
    await hub.join(rt.ref, a.v, size);
    rt.emit("\x1b[>q");
    await expect.poll(() => rt.written).toEqual(["\x1bP>|bazhen\x1b\\"]);
  });

  it("moves the lease to the view the user engages, and tells every view", async () => {
    const rt = await fakeRuntime();
    const { log, events } = memoryLog();
    const hub = new TerminalHub(rt.runtime, log);
    const laptop = viewer();
    const phone = viewer();
    const l = await hub.join(rt.ref, laptop.v, size);
    const p = await hub.join(rt.ref, phone.v, { cols: 40, rows: 50 });
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
    const rt = await fakeRuntime();
    const hub = new TerminalHub(rt.runtime, memoryLog().log);
    const watcher = viewer("observe");
    const w = await hub.join(rt.ref, watcher.v, size);
    w.engage();
    w.input(Buffer.from("x"));
    expect(rt.written).toEqual([]);
  });

  it("sizes the terminal only from its driver", async () => {
    const rt = await fakeRuntime();
    const hub = new TerminalHub(rt.runtime, memoryLog().log);
    const a = await hub.join(rt.ref, viewer().v, size);
    const b = await hub.join(rt.ref, viewer().v, size);
    a.engage();
    b.resize({ cols: 30, rows: 10 });
    a.resize({ cols: 100, rows: 30 });
    await expect.poll(() => rt.sizes).toEqual([{ cols: 100, rows: 30 }]);
  });

  it("never resizes the terminal to the size it already has, which would redraw every view", async () => {
    const rt = await fakeRuntime();
    const hub = new TerminalHub(rt.runtime, memoryLog().log);
    const a = await hub.join(rt.ref, viewer().v, size);
    await hub.join(rt.ref, viewer().v, size);
    a.engage();
    a.resize(size);
    await hub.join(rt.ref, viewer("observe").v, size);
    expect(rt.sizes).toEqual([]);
  });

  it("applies only the latest of a burst of resizes once the one in flight settles", async () => {
    const rt = await fakeRuntime();
    const hub = new TerminalHub(rt.runtime, memoryLog().log);
    const a = await hub.join(rt.ref, viewer().v, size);
    a.engage();
    for (let cols = 81; cols <= 90; cols++) a.resize({ cols, rows: 24 });
    await expect.poll(() => rt.sizes.at(-1)).toEqual({ cols: 90, rows: 24 });
    expect(rt.sizes).toEqual([
      { cols: 81, rows: 24 },
      { cols: 90, rows: 24 },
    ]);
  });

  it("never sizes the terminal from an observer, even the first one to open it", async () => {
    const rt = await fakeRuntime();
    const hub = new TerminalHub(rt.runtime, memoryLog().log);
    await hub.join(rt.ref, viewer("observe").v, { cols: 40, rows: 60 });
    expect([rt.attachedAt, rt.sizes]).toEqual([[null], []]);
  });

  it("sizes the terminal from the latest interactive view while nobody drives", async () => {
    const rt = await fakeRuntime();
    const hub = new TerminalHub(rt.runtime, memoryLog().log);
    await hub.join(rt.ref, viewer("observe").v, size);
    await hub.join(rt.ref, viewer().v, { cols: 120, rows: 40 });
    await expect.poll(() => rt.sizes).toEqual([{ cols: 120, rows: 40 }]);
  });

  it("hands the size to the remaining view when the driver leaves, and tells it", async () => {
    const rt = await fakeRuntime();
    const hub = new TerminalHub(rt.runtime, memoryLog().log);
    const laptop = await hub.join(rt.ref, viewer().v, { cols: 200, rows: 50 });
    const phone = viewer();
    await hub.join(rt.ref, phone.v, { cols: 60, rows: 50 });
    laptop.engage();
    await expect.poll(() => rt.sizes.at(-1)).toEqual({ cols: 200, rows: 50 });
    const leaseFrames = () => phone.frames.filter((f) => f.type === "lease").length;
    const before = leaseFrames();
    laptop.leave();
    await expect.poll(() => rt.sizes.at(-1)).toEqual({ cols: 60, rows: 50 });
    expect([leaseFrames() - before, phone.frames.at(-1)]).toEqual([
      1,
      { type: "lease", driver: false, epoch: 5 },
    ]);
  });

  it("closes the runtime client when the last view leaves, and only then", async () => {
    const rt = await fakeRuntime();
    const { log, events } = memoryLog();
    const hub = new TerminalHub(rt.runtime, log);
    const a = await hub.join(rt.ref, viewer().v, size);
    const b = await hub.join(rt.ref, viewer().v, size);
    a.leave();
    expect(rt.counts().closes).toBe(0);
    b.leave();
    expect([rt.counts().closes, events.at(-1)]).toEqual([1, `ended ${b.id} client_closed`]);
  });

  it("tells every view when the terminal itself goes away", async () => {
    const rt = await fakeRuntime();
    const { log, events } = memoryLog();
    const hub = new TerminalHub(rt.runtime, log);
    const a = viewer();
    const attached = await hub.join(rt.ref, a.v, size);
    rt.end();
    expect([a.frames.at(-1), a.closed(), events.at(-1)]).toEqual([
      { type: "exit" },
      true,
      `ended ${attached.id} terminal_closed`,
    ]);
  });
});
