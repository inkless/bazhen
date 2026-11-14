import headless from "@xterm/headless";
import { describe, expect, it, vi } from "vitest";
import { newId, type AttachmentId, type RuntimeRef, type TerminalId } from "@bazhen/core";
import { FakeRuntime, type FakeRuntimeOptions } from "@bazhen/core/testing";
import {
  oscColour,
  TERMINAL_COLOURS,
  type AttachmentMode,
  type StreamServerFrame,
  type TuiTheme,
} from "@bazhen/protocol";
import { TerminalClosed } from "./emulator.ts";
import {
  HUB_DEFAULTS,
  TerminalHub,
  ViewEnded,
  ViewRefused,
  type Attachment,
  type AttachmentLog,
  type HubOptions,
  type Viewer,
} from "./hub.ts";

/** What a browser shows after writing everything a view was sent: each non-blank line. */
async function screenOf(sent: readonly string[]): Promise<string[]> {
  return (await rowsOf(sent)).all.filter((line) => line !== "");
}

/** Every row a browser holds after writing what a view was sent, and the first on its screen. */
async function rowsOf(sent: readonly string[]): Promise<{ all: string[]; top: number }> {
  const term = new headless.Terminal({ ...size, allowProposedApi: true });
  await new Promise<void>((resolve) => term.write(sent.join(""), resolve));
  const buffer = term.buffer.active;
  const all = Array.from({ length: buffer.length }, (_, y) =>
    (buffer.getLine(y)?.translateToString(true) ?? "").trim(),
  );
  term.dispose();
  return { all, top: buffer.baseY };
}

/** A runtime with one terminal, whose program echoes nothing, and what reaches it. */
async function fakeRuntime(history = "earlier output", opts: FakeRuntimeOptions = {}) {
  const runtime = new FakeRuntime(opts);
  const terminal = async (text = history) => {
    const created = await runtime.create({
      terminalId: newId("term"),
      tags: { kind: "shell" },
      argv: ["sleep", "300"],
      cwd: "/w",
      env: {},
      size,
      generation: 0,
    });
    runtime.scroll(created, text);
    return created;
  };
  const ref = await terminal();
  const clients = runtime.clients(ref);
  return {
    runtime,
    ref,
    written: clients.written,
    sizes: clients.resizes,
    attachedAt: clients.attaches,
    emit: (s: string) => runtime.output(ref, s),
    end: () => runtime.vanish(ref),
    /** The runtime's screen check fails with `message`. */
    failScreenCheck: (message: string) =>
      runtime.fail(ref, { what: "screen check", cause: new Error(message) }),
    counts: () => ({ attaches: clients.attaches.length, closes: clients.closes }),
    /** Another terminal on the same runtime, with the same history unless given another. */
    another: terminal,
  };
}

/**
 * How a view declares its epoch: as a browser does, on every lease frame and once attached;
 * only when a test says (`manual`), so it can hold a declaration back as the network would; or
 * never, as a view from before protocol 1.30.
 */
type Declares = "auto" | "manual" | "never";

/** What each view does once it has its handle, for views that declare as a browser does. */
const onJoined = new WeakMap<Viewer, (attachment: Attachment) => void>();

/** A hub whose views declare as `viewer()` says. */
class Hub extends TerminalHub {
  override async join(...args: Parameters<TerminalHub["join"]>): Promise<Attachment> {
    const attachment = await super.join(...args);
    onJoined.get(args[1])?.(attachment);
    return attachment;
  }
}

/** The resume token a view was given in its `attached` frame. */
function tokenOf(view: { frames: StreamServerFrame[] }): string {
  const attached = view.frames.find((f) => f.type === "attached");
  if (attached?.type !== "attached" || attached.resumeToken === undefined) {
    throw new Error("the view was given no resume token");
  }
  return attached.resumeToken;
}

function viewer(
  mode: AttachmentMode = "interactive",
  unsent = () => 0,
  declares: Declares = "auto",
) {
  const seen: string[] = [];
  const frames: StreamServerFrame[] = [];
  let closed = false;
  let epoch = 0;
  let handle: Attachment | undefined;
  const declare = () => (declares === "auto" ? handle?.declareEpoch(epoch) : undefined);
  const v: Viewer = {
    mode,
    declaresEpoch: declares !== "never",
    send: (bytes, written) => {
      seen.push(Buffer.from(bytes).toString());
      written?.();
    },
    notify: (frame) => {
      frames.push(frame);
      if (frame.type !== "lease") return;
      epoch = frame.epoch;
      declare();
    },
    unsent,
    close: () => (closed = true),
  };
  onJoined.set(v, (attachment) => {
    handle = attachment;
    declare();
  });
  return { v, seen, frames, closed: () => closed };
}

/** The log, but `during` runs as the second view opens, once its snapshot has been asked for. */
function duringSecondSnapshot(log: AttachmentLog, during: () => void): AttachmentLog {
  let starts = 0;
  return {
    ...log,
    started: (...args) => {
      log.started(...args);
      starts++;
      if (starts === 2) during();
    },
  };
}

function memoryLog(closing = false) {
  const events: string[] = [];
  const log: AttachmentLog = {
    started: (a: AttachmentId) => events.push(`started ${a}`),
    ended: (a: AttachmentId, reason: string) => events.push(`ended ${a} ${reason}`),
    granted: (_t: TerminalId, a: AttachmentId, epoch: number) =>
      events.push(`granted ${a} ${epoch}`),
    epoch: () => 4,
    closing: () => closing,
    theme: () => "dark",
  };
  return { log, events };
}

const size = { cols: 80, rows: 24 };

describe("terminal hub", () => {
  it("serves every view of a terminal from one runtime client", async () => {
    const rt = await fakeRuntime();
    const hub = new Hub(rt.runtime, memoryLog().log);
    const a = viewer();
    const b = viewer("observe");
    await hub.join(rt.ref, a.v, size);
    await hub.join(rt.ref, b.v, size);
    rt.emit("out");
    expect([rt.counts().attaches, a.seen.at(-1), b.seen.at(-1)]).toEqual([1, "out", "out"]);
  });

  it("opens every view on the history and screen, then live output, with nothing missed or repeated", async () => {
    const rt = await fakeRuntime();
    const log = duringSecondSnapshot(memoryLog().log, () => rt.emit("two "));
    const hub = new Hub(rt.runtime, log);
    const first = viewer();
    await hub.join(rt.ref, first.v, size);
    rt.emit("one ");
    const late = viewer();
    await hub.join(rt.ref, late.v, size);
    rt.emit("three");
    expect([await screenOf(first.seen), await screenOf(late.seen)]).toEqual([
      ["earlier output", "one two three"],
      ["earlier output", "one two three"],
    ]);
  });

  it("opens every view on a runtime's snapshot, then live output, with nothing missed or repeated", async () => {
    const rt = await fakeRuntime("earlier output", { attach: "snapshot" });
    rt.emit("before ");
    const log = duringSecondSnapshot(memoryLog().log, () => rt.emit("two "));
    const hub = new Hub(rt.runtime, log);
    const first = viewer();
    await hub.join(rt.ref, first.v, size);
    rt.emit("one ");
    const late = viewer();
    await hub.join(rt.ref, late.v, size);
    rt.emit("three");
    expect([await screenOf(first.seen), await screenOf(late.seen)]).toEqual([
      ["earlier output", "before one two three"],
      ["earlier output", "before one two three"],
    ]);
    const { all, top } = await rowsOf(late.seen);
    expect([all.slice(0, top).includes("earlier output"), all[top]]).toEqual([
      true,
      "before one two three",
    ]);
  });

  it("never tells a view it is attached when the terminal closes while it opens", async () => {
    const rt = await fakeRuntime();
    const hub = new Hub(
      rt.runtime,
      duringSecondSnapshot(memoryLog().log, () => rt.end()),
    );
    await hub.join(rt.ref, viewer().v, size);
    const late = viewer();
    await expect(hub.join(rt.ref, late.v, size)).rejects.toThrow(TerminalClosed);
    expect([late.frames.some((f) => f.type === "attached"), late.closed()]).toEqual([false, true]);
  });

  it("never tells a view it is attached when the terminal closes as its screen is sent", async () => {
    const rt = await fakeRuntime();
    const hub = new Hub(rt.runtime, memoryLog().log);
    await hub.join(rt.ref, viewer().v, size);
    const late = viewer();
    const closingOnSend: Viewer = { ...late.v, send: () => rt.end() };
    await expect(hub.join(rt.ref, closingOnSend, size)).rejects.toThrow(ViewEnded);
    expect(late.frames.some((f) => f.type === "attached")).toBe(false);
  });

  it("tells a view it is attached only once it has its screen and is ready for input", async () => {
    const rt = await fakeRuntime();
    const hub = new Hub(rt.runtime, memoryLog().log);
    await hub.join(rt.ref, viewer().v, size);
    const order: string[] = [];
    const late: Viewer = {
      mode: "interactive",
      send: (_bytes, written) => {
        order.push("bytes");
        written?.();
      },
      notify: (frame) => order.push(frame.type),
      unsent: () => 0,
      close: () => {},
      declaresEpoch: true,
    };
    await hub.join(rt.ref, late, size);
    expect(order).toEqual([
      "snapshot_start",
      "lease",
      "bytes",
      "snapshot_end",
      "screen",
      "attached",
    ]);
  });

  it("passes keystrokes only from the driver, and drops the rest without queuing them", async () => {
    const rt = await fakeRuntime();
    const hub = new Hub(rt.runtime, memoryLog().log);
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
    const hub = new Hub(rt.runtime, memoryLog().log);
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
    ]).toEqual([["c"], { type: "lease", driver: false, driven: true, epoch: 6 }, false]);
  });

  it("drops a key typed before its view learnt of a takeover, and leaves the lease where it is", async () => {
    const rt = await fakeRuntime();
    const hub = new Hub(rt.runtime, memoryLog().log);
    const laptop = viewer("interactive", () => 0, "manual");
    const phone = viewer();
    const l = await hub.join(rt.ref, laptop.v, size);
    const p = await hub.join(rt.ref, phone.v, size);
    l.engage();
    l.declareEpoch(5);
    l.input(Buffer.from("a"));
    p.engage();
    // Typed at epoch 5, still on the wire as the phone took over.
    l.input(Buffer.from("b"));
    const afterStaleKey = phone.frames.at(-1);
    // The laptop has seen it lost: its next key is the user's, and takes the lease back.
    l.declareEpoch(6);
    l.input(Buffer.from("c"));
    expect([rt.written, afterStaleKey, phone.frames.at(-1)]).toEqual([
      ["a"],
      { type: "lease", driver: true, driven: false, epoch: 6 },
      { type: "lease", driver: false, driven: true, epoch: 7 },
    ]);
  });

  it("keeps the lease still while two views type at once, applying only the driver's keys", async () => {
    const rt = await fakeRuntime();
    const { log, events } = memoryLog();
    const hub = new Hub(rt.runtime, log);
    const l = await hub.join(rt.ref, viewer("interactive", () => 0, "manual").v, size);
    const p = await hub.join(rt.ref, viewer("interactive", () => 0, "manual").v, size);
    l.engage();
    l.declareEpoch(5);
    p.engage();
    p.declareEpoch(6);
    // The laptop hasn't heard it lost yet; its keys and the phone's interleave.
    for (const [view, key] of [
      [l, "1"],
      [p, "2"],
      [l, "3"],
      [p, "4"],
    ] as const) {
      view.input(Buffer.from(key));
    }
    expect([rt.written, events.filter((e) => e.startsWith("granted")).length]).toEqual([
      ["2", "4"],
      2,
    ]);
  });

  it("drops a declaring view's input until it declares its epoch, unlike one from before declarations", async () => {
    const rt = await fakeRuntime();
    const hub = new Hub(rt.runtime, memoryLog().log);
    const declaring = await hub.join(rt.ref, viewer("interactive", () => 0, "manual").v, size);
    const legacy = await hub.join(rt.ref, viewer("interactive", () => 0, "never").v, size);
    declaring.engage();
    declaring.input(Buffer.from("x"));
    declaring.declareEpoch(5);
    declaring.input(Buffer.from("y"));
    // Held to its own grant's epoch, and its stray key takes the lease over.
    legacy.input(Buffer.from("a"));
    legacy.input(Buffer.from("b"));
    expect(rt.written).toEqual(["y", "b"]);
  });

  it("drops input declared under an epoch the view was never granted", async () => {
    const rt = await fakeRuntime();
    const hub = new Hub(rt.runtime, memoryLog().log);
    const d = await hub.join(rt.ref, viewer("interactive", () => 0, "manual").v, size);
    d.engage();
    d.declareEpoch(6);
    d.input(Buffer.from("x"));
    expect(rt.written).toEqual([]);
  });

  it("ends a view's own earlier attachment when it reattaches, freeing the lease it held", async () => {
    const rt = await fakeRuntime();
    const { log, events } = memoryLog();
    const hub = new Hub(rt.runtime, log);
    const gone = viewer();
    const before = await hub.join(rt.ref, gone.v, size);
    before.engage();
    const back = viewer();
    await hub.join(rt.ref, back.v, size, { attachmentId: before.id, token: tokenOf(gone) });
    expect([
      gone.closed(),
      events.filter((e) => e.startsWith(`ended ${before.id}`)),
      back.frames.find((f) => f.type === "lease"),
    ]).toEqual([
      true,
      [`ended ${before.id} replaced`],
      { type: "lease", driver: false, driven: false, epoch: 5 },
    ]);
  });

  it("leaves the lease with a view that took it while the reattaching one was gone", async () => {
    const rt = await fakeRuntime();
    const { log, events } = memoryLog();
    const hub = new Hub(rt.runtime, log);
    const gone = viewer();
    const before = await hub.join(rt.ref, gone.v, size);
    const phone = viewer();
    const p = await hub.join(rt.ref, phone.v, size);
    before.engage();
    p.engage();
    const back = viewer();
    await hub.join(rt.ref, back.v, size, { attachmentId: before.id, token: tokenOf(gone) });
    expect([
      events.includes(`ended ${before.id} replaced`),
      back.frames.find((f) => f.type === "lease"),
      phone.frames.at(-1),
    ]).toEqual([
      true,
      { type: "lease", driver: false, driven: true, epoch: 6 },
      { type: "lease", driver: true, driven: false, epoch: 6 },
    ]);
  });

  it("ends no attachment for a token it wasn't given, which the driver's id alone can't name", async () => {
    const rt = await fakeRuntime();
    const { log, events } = memoryLog();
    const hub = new Hub(rt.runtime, log);
    const driver = viewer();
    const d = await hub.join(rt.ref, driver.v, size);
    d.engage();
    // Another view knows the driver's id, as every reader of the event stream does.
    const other = viewer();
    await hub.join(rt.ref, other.v, size);
    const intruder = viewer();
    await hub.join(rt.ref, intruder.v, size, { attachmentId: d.id, token: tokenOf(other) });
    expect([
      driver.closed(),
      events.some((e) => e.endsWith("replaced")),
      intruder.frames.find((f) => f.type === "lease"),
    ]).toEqual([false, false, { type: "lease", driver: false, driven: true, epoch: 5 }]);
  });

  it("gives every view its own resume token", async () => {
    const rt = await fakeRuntime();
    const hub = new Hub(rt.runtime, memoryLog().log);
    const a = viewer();
    const b = viewer();
    await hub.join(rt.ref, a.v, size);
    await hub.join(rt.ref, b.v, size);
    expect(tokenOf(a)).not.toBe(tokenOf(b));
  });

  it("names the driving view's device to the others, and none it isn't on", async () => {
    const rt = await fakeRuntime();
    const hub = new Hub(rt.runtime, memoryLog().log);
    const laptop = viewer();
    const l = await hub.join(rt.ref, laptop.v, size);
    const phone = viewer();
    const p = await hub.join(rt.ref, { ...phone.v, deviceName: "Phone" }, size);
    p.engage();
    const toLaptop = laptop.frames.at(-1);
    const toPhone = phone.frames.at(-1);
    l.engage();
    expect([toLaptop, toPhone, phone.frames.at(-1)]).toEqual([
      { type: "lease", driver: false, driven: true, epoch: 5, driverDevice: "Phone" },
      { type: "lease", driver: true, driven: false, epoch: 5 },
      { type: "lease", driver: false, driven: true, epoch: 6 },
    ]);
  });

  it("never passes a terminal reply from the driver to the program", async () => {
    const rt = await fakeRuntime();
    const hub = new Hub(rt.runtime, memoryLog().log);
    const d = await hub.join(rt.ref, viewer().v, size);
    d.engage();
    d.input(Buffer.from("\x1b[?1;2c"));
    d.input(Buffer.from("x"));
    expect(rt.written).toEqual(["x"]);
  });

  it("takes the lease for a stray keystroke, but not for a focus report", async () => {
    const rt = await fakeRuntime();
    const hub = new Hub(rt.runtime, memoryLog().log);
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
      { type: "lease", driver: true, driven: false, epoch: 5 },
      { type: "lease", driver: false, driven: true, epoch: 6 },
    ]);
  });

  it("answers the runtime client's terminal queries itself, without asking any view", async () => {
    const rt = await fakeRuntime();
    const hub = new Hub(rt.runtime, memoryLog().log);
    const a = viewer();
    await hub.join(rt.ref, a.v, size);
    rt.emit("\x1b[>q");
    await expect.poll(() => rt.written).toEqual(["\x1bP>|bazhen\x1b\\"]);
  });

  it("tells a program that asks the background of its terminal's current theme, which a respawn changes", async () => {
    const rt = await fakeRuntime();
    let theme: TuiTheme = "dark";
    const hub = new Hub(rt.runtime, { ...memoryLog().log, theme: () => theme });
    await hub.join(rt.ref, viewer().v, size);
    rt.emit("\x1b]11;?\x1b\\");
    await expect.poll(() => rt.written).toHaveLength(1);
    // A respawn in light keeps the terminal's client, and its emulator, alive.
    theme = "light";
    rt.emit("\x1b]11;?\x1b\\");
    await expect
      .poll(() => rt.written)
      .toEqual([
        `\x1b]11;${oscColour(TERMINAL_COLOURS.dark.background)}\x1b\\`,
        `\x1b]11;${oscColour(TERMINAL_COLOURS.light.background)}\x1b\\`,
      ]);
  });

  it("moves the lease to the view the user engages, and tells every view", async () => {
    const rt = await fakeRuntime();
    const { log, events } = memoryLog();
    const hub = new Hub(rt.runtime, log);
    const laptop = viewer();
    const phone = viewer();
    const l = await hub.join(rt.ref, laptop.v, size);
    const p = await hub.join(rt.ref, phone.v, { cols: 40, rows: 50 });
    l.engage();
    p.engage();
    expect(laptop.frames.at(-1)).toEqual({ type: "lease", driver: false, driven: true, epoch: 6 });
    expect(phone.frames.at(-1)).toEqual({ type: "lease", driver: true, driven: false, epoch: 6 });
    expect(events.filter((e) => e.startsWith("granted"))).toEqual([
      `granted ${l.id} 5`,
      `granted ${p.id} 6`,
    ]);
    await expect.poll(() => rt.sizes.at(-1)).toEqual({ cols: 40, rows: 50 });
  });

  it("never gives the lease to an observer", async () => {
    const rt = await fakeRuntime();
    const hub = new Hub(rt.runtime, memoryLog().log);
    const watcher = viewer("observe");
    const w = await hub.join(rt.ref, watcher.v, size);
    w.engage();
    w.input(Buffer.from("x"));
    expect(rt.written).toEqual([]);
  });

  it("sizes the terminal only from its driver", async () => {
    const rt = await fakeRuntime();
    const hub = new Hub(rt.runtime, memoryLog().log);
    const a = await hub.join(rt.ref, viewer().v, size);
    const b = await hub.join(rt.ref, viewer().v, size);
    a.engage();
    b.resize({ cols: 30, rows: 10 });
    a.resize({ cols: 100, rows: 30 });
    await expect.poll(() => rt.sizes).toEqual([{ cols: 100, rows: 30 }]);
  });

  it("never resizes the terminal to the size it already has, which would redraw every view", async () => {
    const rt = await fakeRuntime();
    const hub = new Hub(rt.runtime, memoryLog().log);
    const a = await hub.join(rt.ref, viewer().v, size);
    await hub.join(rt.ref, viewer().v, size);
    a.engage();
    a.resize(size);
    await hub.join(rt.ref, viewer("observe").v, size);
    expect(rt.sizes).toEqual([]);
  });

  it("applies only the latest of a burst of resizes once the one in flight settles", async () => {
    const rt = await fakeRuntime();
    const hub = new Hub(rt.runtime, memoryLog().log);
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
    const hub = new Hub(rt.runtime, memoryLog().log);
    await hub.join(rt.ref, viewer("observe").v, { cols: 40, rows: 60 });
    expect([rt.attachedAt, rt.sizes]).toEqual([[null], []]);
  });

  it("sizes the terminal from the latest interactive view while nobody drives", async () => {
    const rt = await fakeRuntime();
    const hub = new Hub(rt.runtime, memoryLog().log);
    await hub.join(rt.ref, viewer("observe").v, size);
    await hub.join(rt.ref, viewer().v, { cols: 120, rows: 40 });
    await expect.poll(() => rt.sizes).toEqual([{ cols: 120, rows: 40 }]);
  });

  it("hands the size to the remaining view when the driver leaves, and tells it", async () => {
    const rt = await fakeRuntime();
    const hub = new Hub(rt.runtime, memoryLog().log);
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
      { type: "lease", driver: false, driven: false, epoch: 5 },
    ]);
  });

  it("closes the runtime client when the last view leaves, and only then", async () => {
    const rt = await fakeRuntime();
    const { log, events } = memoryLog();
    const hub = new Hub(rt.runtime, log);
    const a = await hub.join(rt.ref, viewer().v, size);
    const b = await hub.join(rt.ref, viewer().v, size);
    a.leave();
    expect(rt.counts().closes).toBe(0);
    b.leave();
    expect([rt.counts().closes, events.at(-1)]).toEqual([1, `ended ${b.id} client_closed`]);
  });

  it("tells every view when the terminal itself goes away", async () => {
    const rt = await fakeRuntime();
    const { log, events } = memoryLog(true);
    const hub = new Hub(rt.runtime, log);
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

describe("terminal hub: screen state and slow views", () => {
  it("tells a view whether the program is on its alternate screen, right after its snapshot", async () => {
    const rt = await fakeRuntime();
    rt.emit("\x1b[?1049h");
    const hub = new Hub(rt.runtime, memoryLog().log);
    const a = viewer();
    await hub.join(rt.ref, a.v, size);
    const types = a.frames.map((f) => f.type);
    expect([
      types.indexOf("screen") - types.indexOf("snapshot_end"),
      a.frames.find((f) => f.type === "screen"),
    ]).toEqual([1, { type: "screen", alternate: true }]);
  });

  it("tells every view of a switch of screens as the runtime pushes it, once", async () => {
    const rt = await fakeRuntime();
    const hub = new Hub(rt.runtime, memoryLog().log);
    const a = viewer();
    const b = viewer("observe");
    await hub.join(rt.ref, a.v, size);
    await hub.join(rt.ref, b.v, size);
    rt.emit("\x1b[?1049h");
    rt.emit("drawn");
    const screens = (v: typeof a) => v.frames.filter((f) => f.type === "screen");
    const switched = [
      { type: "screen", alternate: false },
      { type: "screen", alternate: true },
    ];
    expect([screens(a), screens(b)]).toEqual([switched, switched]);
  });

  it("tells a view that opens after a switch of screens where the program is now", async () => {
    const rt = await fakeRuntime();
    const hub = new Hub(rt.runtime, memoryLog().log);
    await hub.join(rt.ref, viewer().v, size);
    rt.emit("\x1b[?1049h");
    const late = viewer();
    await hub.join(rt.ref, late.v, size);
    expect(late.frames.filter((f) => f.type === "screen")).toEqual([
      { type: "screen", alternate: true },
    ]);
  });

  it("tells every view what failed in the runtime", async () => {
    const rt = await fakeRuntime();
    const hub = new Hub(rt.runtime, memoryLog().log);
    const a = viewer();
    const b = viewer("observe");
    await hub.join(rt.ref, a.v, size);
    await hub.join(rt.ref, b.v, size);
    rt.failScreenCheck("tmux gone");
    const notices = (v: typeof a) => v.frames.filter((f) => f.type === "notice");
    expect([notices(a), notices(b)]).toEqual([
      [{ type: "notice", message: "screen check failed: tmux gone" }],
      [{ type: "notice", message: "screen check failed: tmux gone" }],
    ]);
  });

  it("tells views why a screen check failed, leaving out a secret the failure echoed", async () => {
    const rt = await fakeRuntime();
    const hub = new Hub(rt.runtime, memoryLog().log);
    const a = viewer();
    await hub.join(rt.ref, a.v, size);
    rt.failScreenCheck('tmux gone; api_key = "s3cr3t"');
    expect(a.frames.filter((f) => f.type === "notice")).toEqual([
      { type: "notice", message: "screen check failed: tmux gone; api_key = [redacted]" },
    ]);
  });

  it("ends a view that falls too far behind, and keeps serving the others", async () => {
    const rt = await fakeRuntime();
    const { log, events } = memoryLog();
    const hub = new Hub(rt.runtime, log, { ...HUB_DEFAULTS, maxUnsentBytes: 100 });
    let backlog = 0;
    const slow = viewer("observe", () => backlog);
    const fast = viewer();
    const s = await hub.join(rt.ref, slow.v, size);
    await hub.join(rt.ref, fast.v, size);
    // As a socket counts it: the snapshot it was sent, still unsent, and 101 bytes more.
    backlog = Buffer.byteLength(slow.seen.join("")) + 101;
    rt.emit("one");
    rt.emit("two");
    expect([
      slow.frames.at(-1),
      slow.closed(),
      slow.seen.at(-1),
      fast.seen.slice(-2),
      events.includes(`ended ${s.id} evicted_slow`),
      rt.counts().closes,
    ]).toEqual([{ type: "ended", reason: "evicted_slow" }, true, "one", ["one", "two"], true, 0]);
  });

  it("counts output held during a view's snapshot as unsent", async () => {
    const rt = await fakeRuntime();
    const log = duringSecondSnapshot(memoryLog().log, () => rt.emit("x".repeat(101)));
    const hub = new Hub(rt.runtime, log, { ...HUB_DEFAULTS, maxUnsentBytes: 100 });
    await hub.join(rt.ref, viewer().v, size);
    const late = viewer();
    await expect(hub.join(rt.ref, late.v, size)).rejects.toThrow(ViewEnded);
    expect(late.frames.at(-1)).toEqual({ type: "ended", reason: "evicted_slow" });
  });

  it("holds a view to the plain limit once its snapshot is written", async () => {
    const rt = await fakeRuntime("h".repeat(500));
    const hub = new Hub(rt.runtime, memoryLog().log, { ...HUB_DEFAULTS, maxUnsentBytes: 100 });
    let backlog = 0;
    const slow = viewer("observe", () => backlog);
    await hub.join(rt.ref, slow.v, size);
    backlog = 100;
    rt.emit("x");
    const atTheLimit = slow.closed();
    backlog = 101;
    rt.emit("y");
    expect([atTheLimit, slow.closed(), slow.frames.at(-1)]).toEqual([
      false,
      true,
      { type: "ended", reason: "evicted_slow" },
    ]);
  });

  it("ends views as disconnected when the runtime client is lost but the terminal lives on", async () => {
    const rt = await fakeRuntime();
    const { log, events } = memoryLog(false);
    const hub = new Hub(rt.runtime, log);
    const a = viewer();
    const attached = await hub.join(rt.ref, a.v, size);
    rt.end();
    expect([a.frames.at(-1), a.closed(), events.at(-1)]).toEqual([
      { type: "ended", reason: "disconnected" },
      true,
      `ended ${attached.id} disconnected`,
    ]);
  });
});

/**
 * A view whose socket writes what it is sent only when the test says, as a slow reader's does,
 * or never, as a gone one's. Its socket closing settles what is in flight, as `ws` does.
 */
function slowViewer() {
  const view = viewer("observe");
  const inFlight: (() => void)[] = [];
  let unsent = 0;
  let gone = false;
  const v: Viewer = {
    ...view.v,
    send: (bytes, written) => {
      view.v.send(bytes);
      if (gone) written?.();
      else if (written) {
        unsent += bytes.length;
        inFlight.push(() => {
          unsent -= bytes.length;
          written();
        });
      }
    },
    unsent: () => unsent,
  };
  return {
    ...view,
    v,
    inFlight: () => inFlight.length,
    /** Writes the piece in flight, if there is one. */
    write: () => inFlight.shift()?.(),
    disconnect: () => {
      gone = true;
      for (const written of inFlight.splice(0)) written();
    },
  };
}

const turn = () => new Promise((resolve) => setImmediate(resolve));

/** Starts a slow view opening, and waits until the first piece of its snapshot is in flight. */
async function loading(hub: TerminalHub, ref: RuntimeRef) {
  const view = slowViewer();
  const joined = hub.join(ref, view.v, size);
  joined.catch(() => {});
  await vi.waitFor(() => expect(view.inFlight()).toBe(1));
  return { ...view, joined };
}

describe("terminal hub: room for views", () => {
  const history = "h".repeat(500);
  let clock = 0;
  const room = {
    ...HUB_DEFAULTS,
    snapshotChunkBytes: 100,
    snapshotStallMs: 1000,
    now: () => clock,
  };

  /** A hub over a terminal with a long history, and the size of that terminal's snapshot. */
  async function measured(opts: (snapshot: number) => Partial<HubOptions>) {
    clock = 0;
    const rt = await fakeRuntime(history);
    const probe = viewer();
    const { log, events } = memoryLog();
    const sizing = new Hub(rt.runtime, log, room);
    (await sizing.join(rt.ref, probe.v, size)).leave();
    const snapshot = Buffer.byteLength(probe.seen.join(""));
    const hub = new Hub(rt.runtime, log, { ...room, ...opts(snapshot) });
    return { rt, hub, events, snapshot, screen: () => screenOf(probe.seen) };
  }

  it("turns a view away once its terminal has as many as it may, and leaves the others be", async () => {
    const rt = await fakeRuntime();
    const { log, events } = memoryLog();
    const hub = new Hub(rt.runtime, log, { ...room, maxViews: 2 });
    const [a, b, c] = [viewer(), viewer(), viewer()];
    await hub.join(rt.ref, a.v, size);
    await hub.join(rt.ref, b.v, size);
    await expect(hub.join(rt.ref, c.v, size)).rejects.toThrow(ViewRefused);
    const [started, ended] = events.slice(-2).map((e) => e.split(" "));
    expect([a.closed(), b.closed(), c.frames, started, ended]).toEqual([
      false,
      false,
      [],
      ["started", ended?.[1]],
      ["ended", started?.[1], "attach_failed"],
    ]);
  });

  it("turns a view away at the cap that names another view's attachment without its token", async () => {
    const rt = await fakeRuntime();
    const hub = new Hub(rt.runtime, memoryLog().log, { ...room, maxViews: 2 });
    const first = viewer();
    const a = await hub.join(rt.ref, first.v, size);
    await hub.join(rt.ref, viewer().v, size);
    const claim = { attachmentId: a.id, token: "not its token" };
    await expect(hub.join(rt.ref, viewer().v, size, claim)).rejects.toThrow(ViewRefused);
    expect(first.closed()).toBe(false);
  });

  it("lets a view reattach to a terminal that has as many views as it may, but no new one", async () => {
    const rt = await fakeRuntime();
    const hub = new Hub(rt.runtime, memoryLog().log, { ...room, maxViews: 2 });
    const gone = viewer();
    const before = await hub.join(rt.ref, gone.v, size);
    await hub.join(rt.ref, viewer().v, size);
    const back = viewer();
    await hub.join(rt.ref, back.v, size, { attachmentId: before.id, token: tokenOf(gone) });
    const fresh = hub.join(rt.ref, viewer().v, size);
    await expect(fresh).rejects.toThrow(ViewRefused);
    expect(back.frames.at(-1)?.type).toBe("attached");
  });

  it("sends a snapshot a piece at a time, each once the last is written, and loses none of it", async () => {
    const { rt, hub, snapshot, screen } = await measured(() => ({}));
    const view = slowViewer();
    const joined = hub.join(rt.ref, view.v, size);
    for (let piece = 0; piece < Math.ceil(snapshot / 100); piece++) {
      await vi.waitFor(() => expect(view.inFlight()).toBe(1));
      view.write();
    }
    expect([view.seen.length, view.seen.every((piece) => piece.length <= 100)]).toEqual([
      Math.ceil(snapshot / 100),
      true,
    ]);
    await expect(joined).resolves.toBeDefined();
    expect(await screenOf(view.seen)).toEqual(await screen());
  });

  it("ends a view whose snapshot has stalled when another needs the room, the oldest first", async () => {
    const { rt, hub, events, snapshot } = await measured((snap) => ({
      maxSnapshotBytes: snap * 2.5,
    }));
    const oldest = await loading(hub, rt.ref);
    clock = 10;
    const older = await loading(hub, rt.ref);
    clock = 1010;
    const late = viewer();
    await hub.join(rt.ref, late.v, size);
    expect([
      oldest.frames.at(-1),
      oldest.closed(),
      older.closed(),
      events.filter((e) => e.endsWith("evicted_slow")).length,
      Buffer.byteLength(late.seen.join("")),
    ]).toEqual([{ type: "ended", reason: "evicted_slow" }, true, false, 1, snapshot]);
    await expect(oldest.joined).rejects.toThrow(ViewEnded);
  });

  it("turns a view away when every snapshot being sent is still being read", async () => {
    const { rt, hub, events } = await measured((snap) => ({ maxSnapshotBytes: snap * 2.2 }));
    const first = await loading(hub, rt.ref);
    const second = await loading(hub, rt.ref);
    clock = 900;
    first.write();
    second.write();
    await turn();
    clock = 1500;
    await expect(hub.join(rt.ref, viewer().v, size)).rejects.toThrow(/still loading/);
    expect([first.closed(), second.closed(), events.at(-1)]).toEqual([
      false,
      false,
      expect.stringMatching(/ attach_failed$/),
    ]);
  });

  it("counts a snapshot in full until the last of it is written, since all of it is held", async () => {
    const { rt, hub, snapshot } = await measured((snap) => ({ maxSnapshotBytes: snap * 1.5 }));
    const reading = await loading(hub, rt.ref);
    for (let left = snapshot; left > snapshot / 2; left -= 100) {
      reading.write();
      await vi.waitFor(() => expect(reading.inFlight()).toBe(1));
    }
    await expect(hub.join(rt.ref, viewer().v, size)).rejects.toThrow(/still loading/);
    expect(reading.closed()).toBe(false);
  });

  it("leaves a reattaching view's earlier attachment be when there is no room for it", async () => {
    const { rt, hub, events } = await measured((snap) => ({ maxSnapshotBytes: snap * 1.5 }));
    const gone = viewer();
    const before = await hub.join(rt.ref, gone.v, size);
    before.engage();
    await loading(hub, rt.ref);
    const claim = { attachmentId: before.id, token: tokenOf(gone) };
    const back = viewer();
    await expect(hub.join(rt.ref, back.v, size, claim)).rejects.toThrow(/still loading/);
    before.input(Buffer.from("still driving"));
    expect([
      gone.closed(),
      events.filter((e) => e.startsWith(`ended ${before.id}`)),
      rt.written.at(-1),
      back.frames.some((f) => f.type === "snapshot_start"),
    ]).toEqual([false, [], "still driving", false]);
  });

  it("lets a view lag by the piece of its snapshot in flight and no further, and frees its room when it ends", async () => {
    const { rt, hub } = await measured((snap) => ({
      maxSnapshotBytes: snap * 1.5,
      maxUnsentBytes: 100,
    }));
    const slow = await loading(hub, rt.ref);
    rt.emit("x".repeat(100));
    const atTheLimit = slow.closed();
    rt.emit("y");
    const late = viewer();
    await hub.join(rt.ref, late.v, size);
    expect([atTheLimit, slow.frames.at(-1), late.frames.at(-1)?.type]).toEqual([
      false,
      { type: "ended", reason: "evicted_slow" },
      "attached",
    ]);
    await expect(slow.joined).rejects.toThrow(ViewEnded);
  });

  it("never ends a view that has its whole snapshot to make room", async () => {
    const { rt, hub } = await measured((snap) => ({ maxSnapshotBytes: snap * 1.5 }));
    const opened = viewer();
    await hub.join(rt.ref, opened.v, size);
    clock = 5000;
    await loading(hub, rt.ref);
    await expect(hub.join(rt.ref, viewer().v, size)).rejects.toThrow(ViewRefused);
    expect(opened.closed()).toBe(false);
  });

  it("ends no stalled view when ending them all would still leave no room", async () => {
    const { rt, hub } = await measured((snap) => ({ maxSnapshotBytes: snap * 2.5 }));
    const stalled = await loading(hub, rt.ref);
    const reading = await loading(hub, rt.ref);
    clock = 1000;
    reading.write();
    await turn();
    const larger = await rt.another("h".repeat(2000));
    await expect(hub.join(larger, viewer().v, size)).rejects.toThrow(/still loading/);
    expect([stalled.closed(), reading.closed()]).toEqual([false, false]);
  });

  it("never ends a view for a stalled snapshot while there is room", async () => {
    const { rt, hub } = await measured((snap) => ({ maxSnapshotBytes: snap * 3 }));
    const slow = await loading(hub, rt.ref);
    clock = 1_000_000;
    await hub.join(rt.ref, viewer().v, size);
    expect(slow.closed()).toBe(false);
  });

  it("ends a stalled view of one terminal for a view of another", async () => {
    const { rt, hub } = await measured((snap) => ({ maxSnapshotBytes: snap * 1.5 }));
    const stalled = await loading(hub, rt.ref);
    clock = 1000;
    const other = await rt.another();
    await hub.join(other, viewer().v, size);
    expect(stalled.closed()).toBe(true);
  });

  it("sends a snapshot larger than the cap only while no other is being sent", async () => {
    const { rt, hub } = await measured((snap) => ({ maxSnapshotBytes: snap / 2 }));
    const alone = await loading(hub, rt.ref);
    await expect(hub.join(rt.ref, viewer().v, size)).rejects.toThrow(/still loading/);
    expect(alone.closed()).toBe(false);
  });

  it("lets a view whose socket closes mid-snapshot finish opening, and frees its room", async () => {
    const { rt, hub } = await measured((snap) => ({ maxSnapshotBytes: snap * 1.5 }));
    const closing = await loading(hub, rt.ref);
    closing.disconnect();
    const late = viewer();
    await expect(closing.joined).resolves.toBeDefined();
    await hub.join(rt.ref, late.v, size);
    expect(late.frames.at(-1)?.type).toBe("attached");
  });
});
