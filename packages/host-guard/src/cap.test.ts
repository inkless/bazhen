import { describe, expect, it } from "vitest";
import {
  CAPPED_ENV,
  MIN_SYSTEMD,
  cappedRunRefusal,
  cappedScope,
  cgroupOf,
  chooseMode,
  clampMemory,
  fallbackWatchdog,
  journalKills,
  judgeProbe,
  oomKills,
  parseTop,
  scopeArgv,
  sliceMemory,
  statAnon,
  statParent,
  statusAnon,
  treeRows,
  type ModeDeps,
  type Verdict,
} from "./cap.ts";

const GIB = 1024 ** 3;
const cap = { memory: 8 * GIB, timeMs: 20 * 60_000 };
const SCOPE =
  "/user.slice/user-1000.slice/user@1000.service/bazhen.slice/bazhen-tests.slice/" +
  "bazhen-capped-42-1.scope";

const reader =
  (files: Record<string, string>) =>
  (path: string): string | undefined =>
    files[path];

const ok: Verdict = { ok: true };
const no: Verdict = { ok: false, why: "systemd-run is missing" };
/** A probe that throws, so a mode that needs none is seen to make none. */
const deps = (over: Partial<ModeDeps>): ModeDeps => ({
  inScope: () => false,
  watchdog: () => undefined,
  probe: () => Promise.reject(new Error("probed")),
  ...over,
});

describe("the caps", () => {
  it("holds a run to half the machine, so a cap above it still fires", () => {
    expect(clampMemory(24 * GIB, 16 * GIB)).toBe(8 * GIB);
    expect(clampMemory(4 * GIB, 64 * GIB)).toBe(4 * GIB);
  });

  it("holds every run together below the whole machine, in whole pages", () => {
    expect(sliceMemory(10 * GIB)).toBe(6 * GIB);
    expect(sliceMemory(10_000) % 4096).toBe(0);
  });

  it("asks systemd to kill only the biggest process, without swap, and to forget a failed scope", () => {
    const argv = scopeArgv("u.scope", cap, "vitest", ["run"]);
    expect(argv).toEqual(
      expect.arrayContaining([
        "--slice=bazhen-tests.slice",
        `MemoryMax=${8 * GIB}`,
        "MemorySwapMax=0",
        "OOMPolicy=continue",
        "RuntimeMaxSec=1200",
        "CollectMode=inactive-or-failed",
      ]),
    );
    expect(argv.slice(-3)).toEqual(["--", "vitest", "run"]);
  });
});

describe("whether this process is in a capped run", () => {
  it("reads the cgroup's own cap", () => {
    const read = reader({
      "/proc/self/cgroup": `0::${SCOPE}\n`,
      [`/sys/fs/cgroup${SCOPE}/memory.max`]: "8589934592\n",
    });
    expect(cappedScope(read)).toBe(8 * GIB);
  });

  it("isn't fooled by a scope of that name with no memory cap", () => {
    const read = reader({
      "/proc/self/cgroup": `0::${SCOPE}\n`,
      [`/sys/fs/cgroup${SCOPE}/memory.max`]: "max\n",
    });
    expect(cappedScope(read)).toBeUndefined();
  });

  it("isn't fooled by a capped cgroup outside the slice", () => {
    const elsewhere = SCOPE.replace("bazhen-tests.slice", "app.slice");
    const read = reader({
      "/proc/self/cgroup": `0::${elsewhere}\n`,
      [`/sys/fs/cgroup${elsewhere}/memory.max`]: "8589934592\n",
    });
    expect(cappedScope(read)).toBeUndefined();
  });

  it("reads the unified hierarchy's line among v1 ones", () => {
    expect(cgroupOf("12:pids:/x\n0::/a/b.scope\n")).toBe("/a/b.scope");
  });

  it("trusts a fallback run's variable only while its watchdog lives", () => {
    const env = { [CAPPED_ENV]: "fallback:4242" };
    expect(fallbackWatchdog(env, () => true)).toBe(4242);
    expect(fallbackWatchdog(env, () => false)).toBeUndefined();
    expect(fallbackWatchdog({ [CAPPED_ENV]: "systemd:4242" }, () => true)).toBeUndefined();
  });
});

describe("the probe's verdict", () => {
  const slice = 37 * GIB;
  const good = {
    version: MIN_SYSTEMD,
    memory: `${cap.memory}\n`,
    swap: "0\n",
    slice: `${slice}\n`,
  };

  it("takes a scope that reads back every cap it was given", () => {
    expect(judgeProbe(cap, slice, good)).toEqual({ ok: true });
  });

  it("refuses a memory controller that took MemoryMax and enforces nothing", () => {
    expect(judgeProbe(cap, slice, { ...good, memory: "max\n" })).toMatchObject({
      ok: false,
      why: expect.stringContaining("memory.max reads max"),
    });
  });

  it("refuses a scope that can still swap, or a slice without its cap", () => {
    expect(judgeProbe(cap, slice, { ...good, swap: "max" })).toMatchObject({ ok: false });
    expect(judgeProbe(cap, slice, { ...good, slice: "max" })).toMatchObject({ ok: false });
  });

  it("refuses a systemd whose scopes can't take OOMPolicy", () => {
    expect(judgeProbe(cap, slice, { ...good, version: MIN_SYSTEMD - 1 })).toMatchObject({
      ok: false,
      why: expect.stringContaining(`older than ${MIN_SYSTEMD}`),
    });
  });
});

describe("how a run is capped", () => {
  it("needs no probe inside a capped scope", async () => {
    await expect(chooseMode(cap, true, {}, deps({ inScope: () => true }))).resolves.toEqual({
      mode: "scope",
    });
  });

  it("runs a test binary inside a watched run as it is, its watchdog covering it", async () => {
    await expect(chooseMode(cap, true, {}, deps({ watchdog: () => 7 }))).resolves.toEqual({
      mode: "through",
    });
  });

  it("refuses a test binary that nothing would cap", async () => {
    await expect(chooseMode(cap, true, {}, deps({ probe: async () => no }))).resolves.toEqual({
      refused: "systemd-run is missing",
    });
  });

  it("watches a whole command where systemd can't cap it, and says why", async () => {
    await expect(chooseMode(cap, false, {}, deps({ probe: async () => no }))).resolves.toEqual({
      mode: "watched",
      note: "systemd-run is missing",
    });
  });

  it("gives a command its own scope where the probe passes", async () => {
    await expect(chooseMode(cap, false, {}, deps({ probe: async () => ok }))).resolves.toEqual({
      mode: "scope",
    });
  });
});

describe("whether vitest may start", () => {
  it("starts inside a capped scope without asking systemd", async () => {
    await expect(cappedRunRefusal({}, deps({ inScope: () => true }))).resolves.toBeUndefined();
  });

  it("refuses to start outside any capped run", async () => {
    await expect(cappedRunRefusal({}, deps({}))).resolves.toBe("it isn't inside a capped run");
  });

  it("takes a watched run only where systemd can't cap, so the variable is no way round it", async () => {
    const watched = { watchdog: () => 7 };
    await expect(
      cappedRunRefusal({}, deps({ ...watched, probe: async () => no })),
    ).resolves.toBeUndefined();
    await expect(
      cappedRunRefusal({}, deps({ ...watched, probe: async () => ok })),
    ).resolves.toContain("systemd can cap a run here");
  });
});

describe("reading memory", () => {
  it("reads a cgroup's anonymous bytes and its kills", () => {
    expect(statAnon("file 900\nanon 1234\nanon_thp 0\n")).toBe(1234);
    expect(oomKills("low 0\nhigh 0\nmax 3\noom 1\noom_kill 2\n")).toBe(2);
  });

  it("counts the OOM kills systemd logged for a scope, and nothing else it logged", () => {
    const log = [
      "Started bazhen-capped-1-1.scope - /usr/bin/node.",
      "bazhen-capped-1-1.scope: A process of this unit has been killed by the OOM killer.",
      "bazhen-capped-1-1.scope: Consumed 1.2s CPU time.",
    ].join("\n");
    expect(journalKills(log)).toBe(1);
  });

  it("counts every process below the root, a child that left its group included", () => {
    const rows = [
      { pid: 10, ppid: 1, bytes: 1 },
      { pid: 11, ppid: 10, bytes: 2 },
      { pid: 12, ppid: 11, bytes: 4 },
      { pid: 13, ppid: 1, bytes: 8 },
    ];
    expect(treeRows(rows, 10).map((r) => r.pid)).toEqual([10, 11, 12]);
  });

  it("reads top's footprint in each of its units", () => {
    const top = [
      "Processes: 3 total",
      "PID    PPID  MEM",
      "501    1     12M+",
      "502    501   1.5G",
      "503    501   900K-",
    ].join("\n");
    expect(parseTop(top)).toEqual([
      { pid: 501, ppid: 1, bytes: 12 * 1024 ** 2 },
      { pid: 502, ppid: 501, bytes: 1.5 * GIB },
      { pid: 503, ppid: 501, bytes: 900 * 1024 },
    ]);
  });

  it("reads a parent pid past a command name that has spaces and parens in it", () => {
    expect(statParent("4242 (a (b) c) S 77 4242 4242 0 -1")).toBe(77);
  });

  it("reads anonymous resident memory, not file-backed", () => {
    expect(statusAnon("VmRSS:\t  900 kB\nRssAnon:\t     300 kB\nRssFile:\t 600 kB\n")).toBe(
      300 * 1024,
    );
  });
});
