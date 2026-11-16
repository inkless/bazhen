import { EventEmitter } from "node:events";
import type { IPty } from "node-pty";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ptySpawner, unixTerminal, type PtySpawn } from "./node-pty.ts";

const isPty = (value: unknown): value is IPty =>
  typeof value === "object" && value !== null && "onExit" in value && "kill" in value;

// Beyond any pid the kernel hands out, so even a signal that got past the stub reaches nobody.
const NO_SUCH_PID = 0x7fff_ffff;

const own = (value: unknown) => ({ value, writable: true, configurable: true });

/**
 * A node-pty terminal with no PTY behind it: node-pty's own `destroy`, `kill`, `_close`, `on`,
 * `emit` and `ptsName`, over a read socket that closes when destroyed. `write` and `resize`, which would reach a
 * real fd, only record.
 */
function standIn() {
  const socket = Object.assign(new EventEmitter(), {
    readable: true,
    destroyed: false,
    destroy() {
      socket.destroyed = true;
      socket.emit("close");
    },
  });
  const exits: Array<(e: { exitCode: number }) => void> = [];
  const written: unknown[] = [];
  const resized: unknown[] = [];
  const terminal: unknown = Object.create(unixTerminal(), {
    _pid: own(NO_SUCH_PID),
    _pty: own("/dev/pts/999"),
    _socket: own(socket),
    _writeStream: own({ dispose() {} }),
    _internalee: own(new EventEmitter()),
    onData: own(() => ({ dispose() {} })),
    onExit: own((cb: (e: { exitCode: number }) => void) => {
      exits.push(cb);
      return { dispose() {} };
    }),
    write: own((data: unknown) => written.push(data)),
    resize: own((cols: number, rows: number) => resized.push([cols, rows])),
  });
  if (!isPty(terminal)) throw new TypeError("not a terminal");
  return {
    terminal,
    socket,
    written,
    resized,
    exit: (exitCode: number) => {
      for (const cb of exits) cb({ exitCode });
    },
  };
}

/** One of node-pty's own methods, called on `terminal` as node-pty ships it. */
function call(terminal: IPty, name: string, ...args: unknown[]) {
  const shipped: unknown = Reflect.get(terminal, name);
  if (typeof shipped !== "function") throw new TypeError(`no ${name}`);
  Reflect.apply(shipped, terminal, args);
}

/** What node-pty does at its child's end of file: it closes the master, before the exit is heard. */
function endOfFile(terminal: IPty) {
  call(terminal, "_close");
  call(terminal, "emit", "close");
}

/**
 * What happens when the seam is built over a terminal whose prototype lacks `name`: the error it
 * refuses with, and how many children it started first.
 */
function startsWithout(name: string) {
  let started = 0;
  const spawn: PtySpawn = () => {
    started++;
    return standIn().terminal;
  };
  const terminal: object = Object.create(unixTerminal(), { [name]: own(undefined) });
  try {
    ptySpawner(spawn, terminal).spawn(["sh"], { cols: 80, rows: 24 }, {});
    return { refused: null, started };
  } catch (error) {
    return { refused: error instanceof Error ? error.message : String(error), started };
  }
}

function spawned(terminal: IPty) {
  const spawn: PtySpawn = () => terminal;
  return ptySpawner(spawn, unixTerminal()).spawn(["sh"], { cols: 80, rows: 24 }, {});
}

const signals = () => vi.spyOn(process, "kill").mockImplementation(() => true);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the PTY seam over node-pty", () => {
  it("hangs up by closing the master, and signals no pid, though node-pty's destroy alone would", () => {
    const sent = signals();
    call(standIn().terminal, "destroy");
    expect(sent).toHaveBeenCalledWith(NO_SUCH_PID, "SIGHUP");
    sent.mockClear();
    const { terminal, socket } = standIn();
    spawned(terminal).hangUp();
    expect(sent).not.toHaveBeenCalled();
    expect(socket.destroyed).toBe(true);
  });

  it("does nothing to a terminal whose child has exited", () => {
    const sent = signals();
    const { terminal, socket, exit } = standIn();
    const pty = spawned(terminal);
    exit(0);
    pty.hangUp();
    expect(sent).not.toHaveBeenCalled();
    expect(socket.destroyed).toBe(false);
  });

  it("neither writes nor resizes once hung up, when the master's fd may be another file's", () => {
    signals();
    const { terminal, written, resized } = standIn();
    const pty = spawned(terminal);
    pty.hangUp();
    pty.write(new Uint8Array([0x61]));
    pty.resize({ cols: 100, rows: 30 });
    expect(written).toEqual([]);
    expect(resized).toEqual([]);
  });

  it("neither writes nor resizes once its child has exited", () => {
    const { terminal, written, resized, exit } = standIn();
    const pty = spawned(terminal);
    exit(0);
    pty.write(new Uint8Array([0x61]));
    pty.resize({ cols: 100, rows: 30 });
    expect(written).toEqual([]);
    expect(resized).toEqual([]);
  });

  it("neither writes nor resizes once node-pty has closed the master, before the exit is heard", () => {
    const { terminal, written, resized } = standIn();
    const pty = spawned(terminal);
    endOfFile(terminal);
    pty.write(new Uint8Array([0x61]));
    pty.resize({ cols: 100, rows: 30 });
    expect(written).toEqual([]);
    expect(resized).toEqual([]);
  });

  it("writes and resizes a live terminal", () => {
    const { terminal, written, resized } = standIn();
    const pty = spawned(terminal);
    pty.write(new Uint8Array([0x61]));
    pty.resize({ cols: 100, rows: 30 });
    expect(written).toEqual([Buffer.from("a")]);
    expect(resized).toEqual([[100, 30]]);
  });

  it("refuses a terminal with no destroy before it starts a child", () => {
    expect(startsWithout("destroy")).toEqual({
      refused: expect.stringMatching(/destroy/),
      started: 0,
    });
  });

  it("refuses a terminal with no kill before it starts a child", () => {
    expect(startsWithout("kill")).toEqual({ refused: expect.stringMatching(/kill/), started: 0 });
  });

  it("refuses a terminal with no on before it starts a child", () => {
    expect(startsWithout("on")).toEqual({ refused: expect.stringMatching(/\bon\b/), started: 0 });
  });

  it("refuses a terminal with no ptsName before it starts a child", () => {
    expect(startsWithout("ptsName")).toEqual({
      refused: expect.stringMatching(/ptsName/),
      started: 0,
    });
  });

  it("names the terminal device node-pty opened, while its master is open", () => {
    expect(spawned(standIn().terminal).tty).toBe("/dev/pts/999");
  });

  it("names no device once hung up, when another PTY may be given its name", () => {
    signals();
    const pty = spawned(standIn().terminal);
    pty.hangUp();
    expect(pty.tty).toBeUndefined();
  });

  it("names no device once node-pty has closed the master, before the exit is heard", () => {
    const { terminal } = standIn();
    const pty = spawned(terminal);
    endOfFile(terminal);
    expect(pty.tty).toBeUndefined();
  });

  it("names no device once its child has exited", () => {
    const { terminal, exit } = standIn();
    const pty = spawned(terminal);
    exit(0);
    expect(pty.tty).toBeUndefined();
  });

  it("hangs up a terminal that names no device, and refuses it", () => {
    const sent = signals();
    const { terminal, socket } = standIn();
    Object.defineProperty(terminal, "_pty", { value: undefined });
    expect(() => spawned(terminal)).toThrow(/terminal device/);
    expect(socket.destroyed).toBe(true);
    expect(sent).not.toHaveBeenCalled();
  });

  it("refuses a terminal whose kill it can't replace", () => {
    const { terminal } = standIn();
    Object.defineProperty(terminal, "kill", { value: () => {}, configurable: false });
    expect(() => spawned(terminal)).toThrow(/kill/);
  });
});
