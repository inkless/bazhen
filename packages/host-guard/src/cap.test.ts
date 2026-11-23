import { describe, expect, it } from "vitest";
import {
  CAPPED_ENV,
  cappedRunRefusal,
  cgroupLimit,
  cappedScope,
  chooseMode,
  clampMemory,
  cpuLimit,
  descendantsIn,
  fallbackWatchdog,
  isAncestor,
  journalArgs,
  journalKills,
  judgeProbe,
  ownedArgv,
  oomKills,
  parsePs,
  namesOf,
  psGroupNames,
  smapsShmem,
  scopeArgv,
  sliceMemory,
  statAnon,
  statComm,
  statInGroup,
  statParent,
  statusAnon,
  treeRows,
  UNNAMED,
  type ModeDeps,
  type Verdict,
} from "./cap.ts";
import { MIN_SYSTEMD, cgroupOf } from "./scope.ts";

const GIB = 1024 ** 3;

const fail = (path: string, code: string): never => {
  throw Object.assign(new Error(`${code}: ${path}`), { code });
};

/** A reader of `files`, which fails as a gone process's file does for any path not in it. */
const readerOf =
  (files: Record<string, () => string>) =>
  (path: string): string =>
    (files[path] ?? (() => fail(path, "ENOENT")))();
const cap = { memory: 8 * GIB, timeMs: 20 * 60_000 };
const SCOPE =
  "/user.slice/user-1000.slice/user@1000.service/bazhen.slice/bazhen-tests.slice/" +
  "bazhen-capped-42-1.scope";

const reader =
  (files: Record<string, string>) =>
  (path: string): string | undefined =>
    files[path];

const yes = () => true;
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
  it("holds a run to 90% of the limit of a cgroup it runs in, its budget already", () => {
    expect(clampMemory(8 * GIB, 64 * GIB, 5 * GIB)).toBe(4.5 * GIB);
    expect(clampMemory(8 * GIB, 16 * GIB, Infinity)).toBe(8 * GIB);
  });

  it("holds a run to half the machine, so a cap above it still fires", () => {
    expect(clampMemory(24 * GIB, 16 * GIB, Infinity)).toBe(8 * GIB);
    expect(clampMemory(4 * GIB, 64 * GIB, Infinity)).toBe(4 * GIB);
  });

  it("reads the smallest memory limit of the cgroups a process runs in", () => {
    const read = reader({
      "/proc/self/cgroup": "0::/a/b\n",
      "/sys/fs/cgroup/a/b/memory.max": "max\n",
      "/sys/fs/cgroup/a/memory.max": `${4 * GIB}\n`,
      "/sys/fs/cgroup/memory.max": `${8 * GIB}\n`,
    });
    expect(cgroupLimit(read)).toBe(4 * GIB);
  });

  it("reads a container's own limit at the root of its cgroup namespace", () => {
    const read = reader({
      "/proc/self/cgroup": "0::/\n",
      "/sys/fs/cgroup/memory.max": `${4 * GIB}\n`,
    });
    expect(cgroupLimit(read)).toBe(4 * GIB);
    expect(cgroupLimit(reader({}))).toBe(Infinity);
  });

  it("holds every run together below the whole machine, in whole pages", () => {
    expect(sliceMemory(10 * GIB)).toBe(6 * GIB);
    // Whole MiB, a multiple of any page size, so the cap reads back from the kernel as it was set.
    expect(sliceMemory(10 * GIB + 12_345) % 1024 ** 2).toBe(0);
    expect(clampMemory(10 * GIB, 7 * GIB + 3, Infinity) % 1024 ** 2).toBe(0);
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

  it("trusts a watched run's variable only while its watchdog lives, as an ancestor", () => {
    const env = { [CAPPED_ENV]: "fallback:4242" };
    expect(fallbackWatchdog(env, yes, yes)).toBe(4242);
    expect(fallbackWatchdog(env, () => false, yes)).toBeUndefined();
    expect(fallbackWatchdog(env, yes, () => false)).toBeUndefined();
    expect(fallbackWatchdog({ [CAPPED_ENV]: "systemd:4242" }, yes, yes)).toBeUndefined();
  });

  it("finds an ancestor by walking parent pids, and stops at init or a loop", () => {
    const parents: Record<number, number> = { 50: 40, 40: 30, 30: 1, 60: 61, 61: 60 };
    const parent = (pid: number) => parents[pid];
    expect([30, 40].map((pid) => isAncestor(pid, parent, 50))).toEqual([true, true]);
    expect([50, 1, 99].map((pid) => isAncestor(pid, parent, 50))).toEqual([false, false, false]);
    expect(isAncestor(99, parent, 60)).toBe(false);
  });
});

describe("the probe's verdict", () => {
  const slice = 37 * GIB;
  const good = {
    version: MIN_SYSTEMD,
    memory: `${cap.memory}\n`,
    swap: "0\n",
    slice: `${slice}\n`,
    sliceSwap: "0\n",
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
    expect(judgeProbe(cap, slice, { ...good, sliceSwap: "max" })).toMatchObject({ ok: false });
  });

  it("refuses a systemd whose scopes can't take OOMPolicy", () => {
    expect(judgeProbe(cap, slice, { ...good, version: MIN_SYSTEMD - 1 })).toMatchObject({
      ok: false,
      why: expect.stringContaining(`older than ${MIN_SYSTEMD}`),
    });
  });
});

describe("how a run is capped", () => {
  it("runs a test binary inside a capped scope as it is, so the scope's cap holds its tests", async () => {
    await expect(chooseMode(cap, "test-binary", deps({ inScope: () => true }))).resolves.toEqual({
      mode: "through",
    });
  });

  it("runs a whole command inside a capped scope through, so that scope's cap holds it", async () => {
    await expect(chooseMode(cap, "run", deps({ inScope: () => true }))).resolves.toEqual({
      mode: "through",
    });
  });

  it("gives a test binary outside a scope one of its own where systemd caps", async () => {
    await expect(chooseMode(cap, "test-binary", deps({ probe: async () => ok }))).resolves.toEqual({
      mode: "scope",
    });
  });

  it("has the runner cap a test binary itself where systemd can't, its watched run or none", async () => {
    await expect(
      chooseMode(cap, "test-binary", deps({ watchdog: () => 7, probe: async () => no })),
    ).resolves.toEqual({ mode: "owned", note: "systemd-run is missing" });
  });

  it("gives a run that asks for a scope of its own one inside a capped scope, beside that scope", async () => {
    const inScope = deps({ inScope: () => true, probe: async () => ok });
    await expect(chooseMode(cap, "own-scope", inScope)).resolves.toEqual({ mode: "scope" });
  });

  it("watches a run that asks for a scope of its own where systemd won't give one, even inside a scope", async () => {
    const refused = deps({ inScope: () => true, probe: async () => no });
    await expect(chooseMode(cap, "own-scope", refused)).resolves.toEqual({
      mode: "watched",
      note: "systemd-run is missing",
    });
  });

  it("chooses for a run that asks for a scope of its own outside one as for any run", async () => {
    await expect(chooseMode(cap, "own-scope", deps({ probe: async () => no }))).resolves.toEqual({
      mode: "watched",
      note: "systemd-run is missing",
    });
  });

  it("watches a whole command where systemd can't cap it, and says why", async () => {
    await expect(chooseMode(cap, "run", deps({ probe: async () => no }))).resolves.toEqual({
      mode: "watched",
      note: "systemd-run is missing",
    });
  });
});

describe("a test binary its runner caps", () => {
  const four = { memory: 4 * GIB, timeMs: 15 * 60_000 };
  const cpu = 'ulimit -S -t "$1" && ulimit -H -t "$2" && shift 2';

  it("on Linux starts under a data limit a quarter above its cap, and a CPU-time limit", () => {
    expect(ownedArgv("/t/a", ["--x"], four, "linux", null, 8)).toEqual([
      "sh",
      [
        "-c",
        `ulimit -d "$1" && shift && ${cpu} && exec "$@"`,
        "sh",
        String(5 * 1024 ** 2),
        "7200",
        "7210",
        "/t/a",
        "--x",
      ],
    ]);
  });

  it("may use its time cap's CPU on every core, which counts CPU over all its threads", () => {
    expect(cpuLimit(four, 8)).toBe(15 * 60 * 8);
  });

  it("dies with its runner on Linux where setpriv can say so", () => {
    const [bin, argv] = ownedArgv("/t/a", [], four, "linux", "/usr/bin/setpriv", 8);
    expect([bin, ...argv.slice(0, 4)]).toEqual([
      "/usr/bin/setpriv",
      "--pdeathsig",
      "KILL",
      "--",
      "sh",
    ]);
  });

  it("never gets a data limit below 2 GiB, which would stop a runtime starting", () => {
    const small = { ...four, memory: 128 * 1024 ** 2 };
    expect(ownedArgv("/t/a", [], small, "linux", null, 8)[1][3]).toBe(String(2 * 1024 ** 2));
  });

  it("on darwin, which has no data limit that counts mappings, starts under its CPU time alone", () => {
    expect(ownedArgv("/t/a", ["--x"], four, "darwin", null, 8)).toEqual([
      "sh",
      ["-c", `${cpu} && exec "$@"`, "sh", "7200", "7210", "/t/a", "--x"],
    ]);
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

/** A capped scope's journal entry, as `journalctl -o json` prints one. */
const entry = (fields: Record<string, string>) =>
  JSON.stringify({ USER_UNIT: "bazhen-capped-1-1.scope", ...fields });

describe("reading memory", () => {
  it("reads a cgroup's anonymous bytes and its kills", () => {
    expect(statAnon("file 900\nanon 1234\nanon_thp 0\n")).toBe(1234);
    expect(oomKills("low 0\nhigh 0\nmax 3\noom 1\noom_kill 2\n")).toBe(2);
  });

  it("counts the OOM kills systemd logged for a scope by their message id, in any wording", () => {
    const oom = "fe6faa94e7774663a0da52717891d8ef";
    const log = [
      entry({ MESSAGE: "Started bazhen-capped-1-1.scope - /usr/bin/node." }),
      entry({
        MESSAGE_ID: oom,
        MESSAGE:
          "bazhen-capped-1-1.scope: A process of this unit has been killed by the OOM killer.",
      }),
      entry({
        MESSAGE_ID: oom,
        MESSAGE:
          "bazhen-capped-1-1.scope: The kernel OOM killer killed some processes in this unit.",
      }),
      entry({
        MESSAGE_ID: oom,
        MESSAGE:
          "bazhen-capped-1-1.scope: The kernel OOM killer killed some processes in this unit.",
      }),
      entry({
        MESSAGE_ID: "ae8f7b866b0347b9af31fe1c80b127c0",
        MESSAGE: "bazhen-capped-1-1.scope: Consumed 1.2s CPU time.",
      }),
      entry({ MESSAGE: "a process said: killed by the OOM killer" }),
      JSON.stringify({ MESSAGE_ID: [oom] }),
      "-- No entries --",
      `{"MESSAGE_ID":"${oom}`,
      "null",
      "",
    ].join("\n");
    expect(journalKills(log)).toBe(3);
  });

  it("asks the journal for a unit's OOM kills alone, as one id a line", () => {
    const args = journalArgs("bazhen-capped-1-1.scope", 5_400);
    expect(args.slice(0, 5)).toEqual([
      "--user",
      "-u",
      "bazhen-capped-1-1.scope",
      "MESSAGE_ID=fe6faa94e7774663a0da52717891d8ef",
      "--since=@5",
    ]);
    expect(args).toEqual(expect.arrayContaining(["-o", "json", "--output-fields=MESSAGE_ID"]));
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

  it("reads ps's resident memory, in KiB", () => {
    const ps = ["  501     1  12288", "  502   501 1572864", "garbage"].join("\n");
    expect(parsePs(ps)).toEqual([
      { pid: 501, ppid: 1, bytes: 12 * 1024 ** 2 },
      { pid: 502, ppid: 501, bytes: 1.5 * GIB },
    ]);
  });

  it("reads a parent pid past a command name that has spaces and parens in it", () => {
    expect(statParent("4242 (a (b) c) S 77 4242 4242 0 -1")).toBe(77);
  });

  it("counts a live process in a group past a command with parens, and no zombie or other group", () => {
    expect([
      statInGroup("10 (a (b) 42) S 1 42 42 0 -1", 42),
      statInGroup("11 (sh) Z 1 42 42 0 -1", 42),
      statInGroup("12 (sh) S 42 43 43 0 -1", 42),
    ]).toEqual([true, false, false]);
  });

  it("names a process past a command with parens", () => {
    expect(statComm("10 (a (b) 42) S 1 42 42 0 -1")).toBe("a (b) 42");
  });

  it("names a process with an empty name as unnamed", () => {
    expect(statComm("10 () S 1 42 42 0 -1")).toBe(UNNAMED);
  });

  it("names ps's live rows in a group, and no zombie or other group", () => {
    const rows = [
      "   42 S    /usr/bin/tmux",
      "   42 Z+   sh",
      "   43 S    sleep",
      "   42 R+   /opt/a b/bazhen-holder",
      "garbage",
    ];
    expect(psGroupNames(rows.join("\n"), 42)).toEqual(["tmux", "bazhen-holder"]);
  });

  it("names ps's row of a process with an empty name, which still counts", () => {
    const rows = ["   42 S", "   43 S    sleep", "   42 S+   ", "   42 S    tmux"];
    expect(psGroupNames(rows.join("\n"), 42)).toEqual([UNNAMED, UNNAMED, "tmux"]);
  });

  it("names each process listed, but one gone before its name was read", () => {
    const read = readerOf({ "/proc/7/comm": () => "tmux\n", "/proc/9/comm": () => "sleep\n" });
    expect(namesOf(["7", "8", "9"], () => ["7", "9"], read)).toEqual(["tmux", "sleep"]);
  });

  it("counts a listed process whose /proc entry is hidden, as hidepid hides another user's", () => {
    const read = readerOf({ "/proc/7/comm": () => "tmux\n" });
    expect(namesOf(["7", "8"], () => ["7", "8"], read)).toEqual(["tmux", UNNAMED]);
  });

  it("counts a listed process whose name reads empty or can't be read", () => {
    const read = readerOf({
      "/proc/7/comm": () => "\n",
      "/proc/8/comm": () => fail("/proc/8/comm", "EACCES"),
      "/proc/9/comm": () => fail("/proc/9/comm", "ESRCH"),
      "/proc/10/comm": () => "tmux\n",
    });
    expect(namesOf(["7", "8", "9", "10"], () => ["7", "8", "10"], read)).toEqual([
      UNNAMED,
      UNNAMED,
      "tmux",
    ]);
  });

  it("reads a process's own anonymous memory, swapped out included, but no shared memory", () => {
    const status =
      "VmRSS:\t 900 kB\nRssAnon:\t 300 kB\nRssFile:\t 600 kB\nRssShmem:\t 20 kB\nVmSwap:\t 5 kB\n";
    expect(statusAnon(status)).toBe(305 * 1024);
  });

  it("reads a process's proportional share of the shared memory it maps", () => {
    const rollup = "Rss:\t 1000 kB\nPss:\t 400 kB\nPss_Anon:\t 100 kB\nPss_Shmem:\t 75 kB\n";
    expect(smapsShmem(rollup)).toBe(75 * 1024);
  });
});

const procStat = (pid: number, name: string, state: string, ppid: number, pgrp = pid) =>
  `${pid} (${name}) ${state} ${ppid} ${pgrp} ${pgrp} 0 -1 4194560`;
const procStats = (...lines: string[]) =>
  new Map(lines.map((line) => [Number(line.slice(0, line.indexOf(" "))), line]));

describe("descendantsIn", () => {
  it("reads every live process below the root, whatever its group, and none beside it", () => {
    const read = descendantsIn(
      procStats(
        procStat(100, "capped", "S", 50),
        procStat(101, "vitest", "S", 100),
        procStat(102, "tmux: server", "S", 100, 102),
        procStat(103, "sh", "S", 102, 103),
        procStat(200, "bystander", "S", 50, 100),
        procStat(201, "its child", "S", 200, 100),
      ),
      100,
      new Set(),
    );
    expect(
      read.map((d) => [d.pid, d.pgid, d.name]).toSorted(([a], [b]) => Number(a) - Number(b)),
    ).toEqual([
      [101, 101, "vitest"],
      [102, 102, "tmux: server"],
      [103, 103, "sh"],
    ]);
  });

  it("counts a zombie, its own or a descendant's, as nothing live", () => {
    const read = descendantsIn(
      procStats(
        procStat(300, "cat", "Z", 100),
        procStat(301, "x", "X", 100),
        procStat(302, "deep", "Z", 303),
        procStat(303, "sleep", "S", 100),
      ),
      100,
      new Set(),
    );
    expect(read.map((d) => d.pid)).toEqual([303]);
  });

  it("leaves out a helper and what is below it", () => {
    const read = descendantsIn(
      procStats(
        procStat(400, "systemctl", "S", 100),
        procStat(401, "pager", "S", 400),
        procStat(402, "x", "S", 100),
      ),
      100,
      new Set([400]),
    );
    expect(read.map((d) => d.pid)).toEqual([402]);
  });

  it("reads a name holding spaces and parens", () => {
    const read = descendantsIn(procStats(procStat(500, "a) b (c", "S", 100)), 100, new Set());
    expect(read).toEqual([{ pid: 500, pgid: 500, name: "a) b (c" }]);
  });
});
