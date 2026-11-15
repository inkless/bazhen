import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { K, frame, type Frame } from "./lib.ts";
import { type RecorderDeps, startRecorder } from "./recorder.ts";
import { ScreenTracker, findDetach, restoreBytes, restoreTerminal } from "./tty.ts";

describe("restoreBytes", () => {
  it("is the exact reset sequence an attach client copies", () => {
    const tail =
      "\x1b[>4;0m" +
      "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l\x1b[?1015l" +
      "\x1b[?1004l\x1b[?2004l" +
      "\x1b[?1l\x1b>" +
      "\x1b7\x1b[r\x1b8" +
      "\x1b[0m\x1b(B\x1b[0 q\x1b[?7h\x1b[4l\x1b[?25h";
    assert.equal(restoreBytes(false), "\x1b[?2026l\x1b[<99u" + tail);
    assert.equal(restoreBytes(true), "\x1b[?2026l\x1b[<99u\x1b[?1049l\x1b[<99u" + tail);
  });
});

describe("ScreenTracker", () => {
  it("follows the last switch, including one split across chunks", () => {
    const t = new ScreenTracker();
    t.observe(Buffer.from("a\x1b[?1049hb"));
    assert.equal(t.alternate, true);
    t.observe(Buffer.from("\x1b[?1049lc\x1b[?47h"));
    assert.equal(t.alternate, true);
    t.observe(Buffer.from("x\x1b[?10"));
    t.observe(Buffer.from("47ly"));
    assert.equal(t.alternate, false);
  });
});

describe("restoreTerminal", () => {
  it("leaves raw mode and writes the restore for the screen the program left on", () => {
    for (const alternate of [false, true]) {
      const raw: boolean[] = [];
      const written: string[] = [];
      restoreTerminal({ isTTY: true, setRawMode: (on) => raw.push(on) }, (s) => written.push(s), alternate);
      assert.deepEqual(raw, [false]);
      assert.deepEqual(written, [restoreBytes(alternate)]);
    }
  });

  it("still writes the restore when leaving raw mode throws, and never throws itself", () => {
    const written: string[] = [];
    const tty = {
      isTTY: true,
      setRawMode: () => {
        throw new Error("EIO");
      },
    };
    restoreTerminal(tty, (s) => written.push(s), false);
    assert.deepEqual(written, [restoreBytes(false)]);
    assert.doesNotThrow(() =>
      restoreTerminal(
        tty,
        () => {
          throw new Error("EIO");
        },
        false,
      ),
    );
  });
});

describe("findDetach", () => {
  const at = (s: string) => findDetach(Buffer.from(s, "latin1"));

  it("finds the legacy byte anywhere in a chunk", () => {
    assert.equal(at("\x1d"), 0);
    assert.equal(at("ab\x1dcd"), 2);
  });

  it("finds kitty's CSI 93;5u, with lock bits, a press event and extra fields", () => {
    assert.equal(at("\x1b[93;5u"), 0);
    assert.equal(at("x\x1b[93;5u"), 1);
    assert.equal(at("\x1b[93;69u"), 0, "Caps Lock");
    assert.equal(at("\x1b[93;133u"), 0, "Num Lock");
    assert.equal(at("\x1b[93;5:1u"), 0, "press");
    assert.equal(at("\x1b[93:125;5u"), 0, "shifted key");
    assert.equal(at("\x1b[93;5;29u"), 0, "text");
  });

  it("finds modifyOtherKeys' CSI 27;5;93~", () => {
    assert.equal(at("ab\x1b[27;5;93~"), 2);
  });

  it("ignores ], other modifiers, other keys, and kitty's repeat and release events", () => {
    for (const s of ["]", "\x1b[93u", "\x1b[93;6u", "\x1b[93;7u", "\x1b[91;5u", "\x1b[93;5:2u", "\x1b[93;5:3u", "\x1b[27;6;93~", "\x1b[193;5u"]) {
      assert.equal(at(s), -1, JSON.stringify(s));
    }
  });

  it("returns the earliest match", () => {
    assert.equal(at("ab\x1b[93;5u\x1d"), 2);
  });
});

class FakeConn {
  onFrame: (f: Frame) => void = () => {};
  onClose: () => void = () => {};
  sent: Buffer[] = [];
  closed = 0;
  send(...frames: Buffer[]) {
    this.sent.push(...frames);
  }
  close() {
    this.closed++;
    this.onClose();
  }
  emit(kind: number, payload: Buffer = Buffer.alloc(0)) {
    this.onFrame({ kind, payload });
  }
  data(text: string) {
    this.emit(K.R_DATA, Buffer.concat([Buffer.alloc(8), Buffer.from(text)]));
  }
}

class FakeStdin extends EventEmitter {
  isTTY = true;
  raw: boolean[] = [];
  paused = false;
  setRawMode(on: boolean) {
    this.raw.push(on);
  }
  pause() {
    this.paused = true;
  }
}

class FakeProc extends EventEmitter {
  pid = 4242;
  codes: number[] = [];
  exit(code: number) {
    this.codes.push(code);
  }
}

interface Harness {
  conn: FakeConn;
  stdin: FakeStdin;
  proc: FakeProc;
  written: string[];
  mirrored: string[];
  saved: { file: string; bytes: string }[];
  calls: string[];
  done: Promise<void>;
}

function harness(over: Partial<RecorderDeps> = {}): Harness {
  const conn = new FakeConn();
  const stdin = new FakeStdin();
  const proc = new FakeProc();
  const written: string[] = [];
  const mirrored: string[] = [];
  const saved: { file: string; bytes: string }[] = [];
  const calls: string[] = [];
  let resolve!: () => void;
  const done = new Promise<void>((r) => (resolve = r));
  const exit = proc.exit.bind(proc);
  proc.exit = (code: number) => {
    exit(code);
    resolve();
  };
  startRecorder({
    name: "agent",
    conn,
    stdin,
    proc,
    write: (s) => written.push(s),
    mirror: (b) => mirrored.push(b.toString()),
    recordingPath: (partial) => (partial ? "agent.partial.bin" : "agent.bin"),
    save: (file, bytes) => {
      calls.push("save");
      saved.push({ file, bytes: bytes.toString() });
    },
    reap: async () => {
      calls.push("reap");
      return { leftAlive: [] };
    },
    removeHome: () => calls.push("removeHome"),
    ...over,
  });
  return { conn, stdin, proc, written, mirrored, saved, calls, done };
}

const restoredOnce = (h: Harness, alternate = false) => {
  const restore = restoreBytes(alternate);
  assert.equal(h.written.filter((s) => s.startsWith("\x1b[?2026l")).length, 1);
  assert.equal(h.written[0], restore, "restore is the first thing written");
  assert.deepEqual(h.stdin.raw, [true, false]);
};

describe("startRecorder", () => {
  it("puts stdin in raw mode, subscribes, mirrors output and forwards keys", () => {
    const h = harness();
    assert.deepEqual(h.stdin.raw, [true]);
    assert.equal(h.conn.sent[0]![4], K.SUBSCRIBE);
    h.conn.data("hello");
    h.stdin.emit("data", Buffer.from("\x03"));
    assert.deepEqual(h.mirrored, ["hello"]);
    assert.deepEqual(h.conn.sent.at(-1), frame(K.INPUT, "\x03"));
    assert.deepEqual(h.proc.codes, []);
  });

  it("prints both ways out before the program starts", () => {
    const h = harness();
    assert.match(h.written[0]!, /Ctrl-\].*kill 4242/);
  });

  for (const [name, end] of [
    ["Ctrl-]", (h: Harness) => h.stdin.emit("data", Buffer.from("\x1d"))],
    ["Ctrl-] under the kitty protocol", (h: Harness) => h.stdin.emit("data", Buffer.from("\x1b[93;5u"))],
    ["the program exiting", (h: Harness) => h.conn.emit(K.R_EXITED, Buffer.from('{"code":0}'))],
  ] as const) {
    it(`on ${name}: restores, saves the full recording, reaps, exits 0`, async () => {
      const h = harness();
      h.written.length = 0;
      h.conn.data("abc");
      end(h);
      await h.done;
      restoredOnce(h);
      assert.deepEqual(h.saved, [{ file: "agent.bin", bytes: "abc" }]);
      assert.deepEqual(h.calls, ["save", "reap", "removeHome"]);
      assert.equal(h.conn.closed, 1);
      assert.deepEqual(h.proc.codes, [0]);
    });
  }

  for (const [signal, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
    ["SIGHUP", 129],
  ] as const) {
    it(`on ${signal}: saves the full recording and exits ${code}`, async () => {
      const h = harness();
      h.written.length = 0;
      h.proc.emit(signal, signal);
      await h.done;
      restoredOnce(h);
      assert.deepEqual(h.saved.map((s) => s.file), ["agent.bin"]);
      assert.deepEqual(h.calls, ["save", "reap", "removeHome"]);
      assert.deepEqual(h.proc.codes, [code]);
    });
  }

  for (const [name, end] of [
    ["the connection dropping", (h: Harness) => h.conn.onClose()],
    ["an uncaught exception", (h: Harness) => h.proc.emit("uncaughtException", new Error("boom"))],
    ["an unhandled rejection", (h: Harness) => h.proc.emit("unhandledRejection", new Error("boom"))],
  ] as const) {
    it(`on ${name}: saves a partial recording and exits 1`, async () => {
      const h = harness();
      h.written.length = 0;
      end(h);
      await h.done;
      restoredOnce(h);
      assert.deepEqual(h.saved.map((s) => s.file), ["agent.partial.bin"]);
      assert.deepEqual(h.calls, ["save", "reap", "removeHome"]);
      assert.deepEqual(h.proc.codes, [1]);
    });
  }

  it("leaves the alternate screen only when the program left it on", async () => {
    for (const [output, alternate] of [
      ["\x1b[?1049hdraw", true],
      ["\x1b[?1049hdraw\x1b[?1049l", false],
    ] as const) {
      const h = harness();
      h.written.length = 0;
      h.conn.data(output);
      h.stdin.emit("data", Buffer.from("\x1d"));
      await h.done;
      restoredOnce(h, alternate);
    }
  });

  it("forwards the bytes before Ctrl-] and nothing after it", async () => {
    const h = harness();
    h.stdin.emit("data", Buffer.from("ab\x1dcd"));
    await h.done;
    assert.deepEqual(h.conn.sent.at(-1), frame(K.INPUT, "ab"));
  });

  it("runs once however many ends arrive, and stops mirroring and forwarding", async () => {
    const h = harness();
    h.written.length = 0;
    h.stdin.emit("data", Buffer.from("\x1d"));
    h.conn.emit(K.R_EXITED, Buffer.from("{}"));
    h.proc.emit("SIGTERM", "SIGTERM");
    h.conn.data("late");
    const sent = h.conn.sent.length;
    h.stdin.emit("data", Buffer.from("x"));
    await h.done;
    restoredOnce(h);
    assert.deepEqual(h.calls, ["save", "reap", "removeHome"]);
    assert.deepEqual(h.proc.codes, [0]);
    assert.deepEqual(h.mirrored, []);
    assert.equal(h.conn.sent.length, sent);
    assert.ok(h.stdin.paused);
  });

  it("a second end while the first is finishing restores, saves and reaps nothing again", async () => {
    const h = harness();
    h.conn.close = () => {
      h.conn.closed++;
    };
    h.written.length = 0;
    h.stdin.emit("data", Buffer.from("\x1d"));
    h.proc.emit("SIGTERM", "SIGTERM");
    await h.done;
    await new Promise((r) => setImmediate(r));
    restoredOnce(h);
    assert.deepEqual(h.calls, ["save", "reap", "removeHome"]);
    assert.equal(h.conn.closed, 1);
    assert.deepEqual(h.proc.codes, [0]);
  });

  it("still reaps and removes the home when saving throws, and exits 1", async () => {
    const h = harness({
      save: () => {
        throw new Error("ENOSPC");
      },
    });
    h.written.length = 0;
    h.stdin.emit("data", Buffer.from("\x1d"));
    await h.done;
    restoredOnce(h);
    assert.deepEqual(h.calls, ["reap", "removeHome"]);
    assert.match(h.written.join(""), /save failed: ENOSPC/);
    assert.deepEqual(h.proc.codes, [1]);
  });

  it("exits 1 and names the pids when a holder is left alive", async () => {
    const h = harness({ reap: async () => ({ leftAlive: [11, 12] }) });
    h.stdin.emit("data", Buffer.from("\x1d"));
    await h.done;
    assert.match(h.written.join(""), /11 12/);
    assert.deepEqual(h.proc.codes, [1]);
  });

  it("exits 1 through the watchdog when reaping hangs, with the terminal already restored", async () => {
    const h = harness({ reap: () => new Promise(() => {}), watchdogMs: 20 });
    h.written.length = 0;
    h.stdin.emit("data", Buffer.from("\x1d"));
    await h.done;
    restoredOnce(h);
    assert.deepEqual(h.proc.codes, [1]);
  });

  it("restores the terminal on process exit even if nothing finished", () => {
    const h = harness();
    h.written.length = 0;
    h.proc.emit("exit", 0);
    h.proc.emit("exit", 0);
    restoredOnce(h);
  });
});
