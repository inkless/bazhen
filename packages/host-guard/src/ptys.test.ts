import { describe, expect, it } from "vitest";
import { hostPtyReader, type PtySource } from "./ptys.ts";

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

describe("hostPtyReader", () => {
  it("reads Linux's kernel counters as an exact count", () => {
    const read = hostPtyReader(
      linux({ "/proc/sys/kernel/pty/nr": "37\n", "/proc/sys/kernel/pty/max": "4096\n" }),
    );
    expect(read()).toEqual({ ok: true, used: 37, max: 4096, exact: true });
  });

  it("reads Linux's counters again on every call", () => {
    const files = { "/proc/sys/kernel/pty/nr": "1", "/proc/sys/kernel/pty/max": "4096" };
    const read = hostPtyReader(linux(files));
    read();
    files["/proc/sys/kernel/pty/nr"] = "2";
    expect(read()).toMatchObject({ used: 2 });
  });

  it("answers why when a Linux counter is missing or not a count", () => {
    const missing = hostPtyReader(linux({ "/proc/sys/kernel/pty/max": "4096" }))();
    const garbled = hostPtyReader(
      linux({ "/proc/sys/kernel/pty/nr": "lots", "/proc/sys/kernel/pty/max": "4096" }),
    )();
    expect([missing, garbled]).toEqual([
      { ok: false, reason: "ENOENT: /proc/sys/kernel/pty/nr" },
      { ok: false, reason: 'kernel.pty.nr is "lots"' },
    ]);
  });

  it("counts macOS's /dev/ttys nodes as an upper bound, not an exact count", () => {
    const read = hostPtyReader(
      source({
        platform: "darwin",
        ptmxMax: () => "511\n",
        readdir: () => ["ttys000", "ttys001", "ttyp0", "console", "ttys"],
      }),
    );
    expect(read()).toEqual({ ok: true, used: 3, max: 511, exact: false });
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

  it("counts nothing on a platform it can't read", () => {
    expect(hostPtyReader(source({ platform: "freebsd" }))()).toEqual({
      ok: false,
      reason: "PTYs aren't counted on freebsd",
    });
  });
});
