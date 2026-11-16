import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import type { IPty } from "node-pty";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ptySpawner, type PtySpawn } from "./node-pty.ts";

/** node-pty's own terminal class's prototype, whose `destroy` and `kill` these tests run. */
function unixTerminal(): object {
  const lib: unknown = createRequire(import.meta.url)("node-pty/lib/unixTerminal.js");
  const proto: unknown =
    typeof lib === "object" && lib !== null && "UnixTerminal" in lib
      ? Reflect.get(Object(lib.UnixTerminal), "prototype")
      : undefined;
  if (typeof proto !== "object" || proto === null) throw new TypeError("no UnixTerminal");
  return proto;
}

const isPty = (value: unknown): value is IPty =>
  typeof value === "object" && value !== null && "onExit" in value && "kill" in value;

// Beyond any pid the kernel hands out, so even a signal that got past the stub reaches nobody.
const NO_SUCH_PID = 0x7fff_ffff;

const own = (value: unknown) => ({ value, writable: true, configurable: true });

/**
 * A node-pty terminal with no PTY behind it: node-pty's own `destroy`, `kill` and `_close`, over a
 * read socket that closes when destroyed. `write` and `resize`, which would reach a real fd, only
 * record.
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
    _socket: own(socket),
    _writeStream: own({ dispose() {} }),
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

/** node-pty's `destroy`, called on `terminal` as node-pty ships it. */
function destroy(terminal: IPty) {
  const shipped: unknown = Reflect.get(terminal, "destroy");
  if (typeof shipped !== "function") throw new TypeError("no destroy");
  Reflect.apply(shipped, terminal, []);
}

function spawned(terminal: IPty) {
  const spawn: PtySpawn = () => terminal;
  return ptySpawner(spawn).spawn(["sh"], { cols: 80, rows: 24 }, {});
}

const signals = () => vi.spyOn(process, "kill").mockImplementation(() => true);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the PTY seam over node-pty", () => {
  it("hangs up by closing the master, and signals no pid, though node-pty's destroy alone would", () => {
    const sent = signals();
    destroy(standIn().terminal);
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

  it("writes and resizes a live terminal", () => {
    const { terminal, written, resized } = standIn();
    const pty = spawned(terminal);
    pty.write(new Uint8Array([0x61]));
    pty.resize({ cols: 100, rows: 30 });
    expect(written).toEqual([Buffer.from("a")]);
    expect(resized).toEqual([[100, 30]]);
  });

  it("refuses a terminal with no destroy, which it can't hang up without a signal", () => {
    const { terminal } = standIn();
    Object.defineProperty(terminal, "destroy", { value: undefined });
    expect(() => spawned(terminal)).toThrow(/destroy/);
  });

  it("refuses a terminal whose kill it can't replace", () => {
    const { terminal } = standIn();
    Object.defineProperty(terminal, "kill", { value: () => {}, configurable: false });
    expect(() => spawned(terminal)).toThrow(/kill/);
  });
});
