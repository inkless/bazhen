import { describe, expect, it } from "vitest";
import { hostPtyReader, ptyNodes, type PtySource } from "./ptys.ts";

const source = (over: Partial<PtySource>): PtySource => ({
  platform: "linux",
  readFile: () => {
    throw new Error("no file");
  },
  readdir: () => [],
  ptmxMax: () => {
    throw new Error("no sysctl");
  },
  ...over,
});

const linux = (files: Record<string, string>) =>
  source({
    readFile: (path) => {
      const text = files[path];
      if (text === undefined) throw new Error(`ENOENT: ${path}`);
      return text;
    },
  });

const kernel = { "/proc/sys/kernel/pty/max": "4096\n", "/proc/sys/kernel/pty/reserve": "1024\n" };

describe("hostPtyReader", () => {
  it("reads Linux's kernel counters as an exact count, the limit less the first mount's reserve", () => {
    const read = hostPtyReader(linux({ ...kernel, "/proc/sys/kernel/pty/nr": "37\n" }));
    expect(read()).toEqual({
      ok: true,
      used: 37,
      max: 3072,
      exact: true,
      limit: "kernel.pty.max",
    });
  });

  it("reads Linux's counters again on every call", () => {
    const files = { ...kernel, "/proc/sys/kernel/pty/nr": "1" };
    const read = hostPtyReader(linux(files));
    read();
    files["/proc/sys/kernel/pty/nr"] = "2";
    expect(read()).toMatchObject({ used: 2 });
  });

  it("answers why when a Linux counter is missing or not a count", () => {
    const missing = hostPtyReader(linux(kernel))();
    const garbled = hostPtyReader(linux({ ...kernel, "/proc/sys/kernel/pty/nr": "lots" }))();
    expect([missing, garbled]).toEqual([
      { ok: false, reason: "ENOENT: /proc/sys/kernel/pty/nr" },
      { ok: false, reason: 'kernel.pty.nr is "lots"' },
    ]);
  });

  it("can't say the limit when the first mount's reserve is all of the PTYs", () => {
    const read = hostPtyReader(
      linux({ ...kernel, "/proc/sys/kernel/pty/reserve": "4096", "/proc/sys/kernel/pty/nr": "3" }),
    );
    expect(read()).toEqual({
      ok: false,
      reason: "kernel.pty.reserve (4096) is all of kernel.pty.max (4096)",
    });
  });

  it("counts macOS's /dev/ttys nodes as an upper bound, not an exact count", () => {
    const read = hostPtyReader(
      source({
        platform: "darwin",
        ptmxMax: () => "511\n",
        readdir: () => ["ttys000", "ttys001", "ttyp0", "console", "ttys"],
      }),
    );
    expect(read()).toEqual({
      ok: true,
      used: 3,
      max: 511,
      exact: false,
      limit: "kern.tty.ptmx_max",
    });
  });

  it("asks macOS for its maximum only once", () => {
    let asked = 0;
    const read = hostPtyReader(
      source({
        platform: "darwin",
        ptmxMax: () => {
          asked += 1;
          return "511";
        },
      }),
    );
    read();
    read();
    expect(asked).toBe(1);
  });

  it("keeps a failure to read macOS's maximum, rather than asking again on every call", () => {
    let asked = 0;
    const read = hostPtyReader(
      source({
        platform: "darwin",
        ptmxMax: () => {
          asked += 1;
          throw new Error("sysctl timed out");
        },
      }),
    );
    expect([read(), read(), asked]).toEqual([
      { ok: false, reason: "sysctl timed out" },
      { ok: false, reason: "sysctl timed out" },
      1,
    ]);
  });

  it("can't say the limit of a macOS that allows no PTYs", () => {
    const read = hostPtyReader(source({ platform: "darwin", ptmxMax: () => "0" }));
    expect(read()).toEqual({ ok: false, reason: "kern.tty.ptmx_max is 0" });
  });

  it("counts macOS's PTY nodes without asking for its maximum", () => {
    expect(ptyNodes(source({ readdir: () => ["ttys000", "ttys001", "tty.usb"] }))).toBe(2);
  });

  it("counts nothing on a platform it can't read", () => {
    expect(hostPtyReader(source({ platform: "freebsd" }))()).toEqual({
      ok: false,
      reason: "PTYs aren't counted on freebsd",
    });
  });
});
