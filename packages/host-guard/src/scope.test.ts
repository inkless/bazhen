import { describe, expect, it } from "vitest";
import {
  MEMORY_MAX,
  PROBE_SCRIPT,
  TERMINALS_SLICE,
  inTerminalScope,
  isTerminalScope,
  parseProbe,
  probeContainment,
  scopeArgs,
  terminalScope,
  type Containment,
  type ProbeDeps,
  type Ran,
} from "./scope.ts";

const GIB = 1024 ** 3;
const caps = { terminal: "50%", total: "80%" };
const RUN = "/usr/bin/systemd-run";
const CTL = "/usr/bin/systemctl";
const XDG = "/run/user/1000";

interface Call {
  readonly file: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
}

const ok = (stdout: string): Ran => ({ code: 0, stdout, stderr: "" });

const scoped = (oomPolicy: boolean): Extract<Containment, { kind: "scoped" }> => ({
  kind: "scoped",
  systemd: oomPolicy ? 255 : 252,
  oomPolicy,
  caps,
  terminalBytes: 31 * GIB,
  totalBytes: 50 * GIB,
  systemdRun: RUN,
  runtimeDir: XDG,
});

/** The arguments of the probe scope's `systemd-run`. */
function probeArgs(calls: readonly Call[]): readonly string[] {
  const probe = calls.find((c) => c.args.includes(PROBE_SCRIPT));
  if (probe === undefined) throw new Error("no probe scope was started");
  return probe.args;
}

/** A `/proc` with only `files` in it. */
const procWith =
  (files: Readonly<Record<string, string>>) =>
  (path: string): string | undefined =>
    files[path];

/** A user manager that answers as `answers` says, and records what it was asked. */
function fakeSystemd(answers: {
  version?: string;
  set?: Ran;
  probe?: Ran;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  onPath?: readonly string[];
}) {
  const calls: Call[] = [];
  const reading = { memory: `${31 * GIB}\n`, slice: `${50 * GIB}\n` };
  const deps: ProbeDeps = {
    platform: answers.platform ?? "linux",
    env: answers.env ?? { XDG_RUNTIME_DIR: XDG, PATH: "/usr/bin", HOME: "/home/u" },
    which: (command) =>
      (answers.onPath ?? ["systemd-run", "systemctl"]).includes(command)
        ? `/usr/bin/${command}`
        : undefined,
    node: "/usr/bin/node",
    run: (file, args, env) => {
      calls.push({ file, args, env });
      if (args[0] === "--version")
        return Promise.resolve(ok(answers.version ?? "systemd 255 (255.4)\n+PAM"));
      if (file === CTL) return Promise.resolve(answers.set ?? ok(""));
      return Promise.resolve(answers.probe ?? ok(JSON.stringify(reading)));
    },
  };
  return { deps, calls };
}

const valueAfter = (args: readonly string[], flag: string) =>
  args.filter((_, i) => args[i - 1] === flag);

describe("the argv that starts a command in a scope", () => {
  it("puts each property behind its own -p and ends at the command's --", () => {
    expect(scopeArgs("u.scope", "s.slice", ["A=1", "B=2"])).toEqual([
      "--user",
      "--scope",
      "--quiet",
      "--unit=u.scope",
      "--slice=s.slice",
      "-p",
      "A=1",
      "-p",
      "B=2",
      "--",
    ]);
  });
});

describe("whether terminals can be contained here", () => {
  it("contains them when the kernel shows both caps from inside a probe scope", async () => {
    const { deps } = fakeSystemd({});
    expect(await probeContainment(caps, deps)).toEqual({
      kind: "scoped",
      systemd: 255,
      oomPolicy: true,
      caps,
      terminalBytes: 31 * GIB,
      totalBytes: 50 * GIB,
      systemdRun: RUN,
      runtimeDir: XDG,
    });
  });

  it("sets the terminals' slice to the total cap before the probe", async () => {
    const { deps, calls } = fakeSystemd({});
    await probeContainment(caps, deps);
    expect(calls.map((c) => c.args)).toContainEqual([
      "--user",
      "set-property",
      "--runtime",
      TERMINALS_SLICE,
      "MemoryMax=80%",
    ]);
    expect(calls.findIndex((c) => c.file === CTL)).toBeLessThan(
      calls.findIndex((c) => c.args.includes(PROBE_SCRIPT)),
    );
  });

  it("probes with a terminal's own properties, in the terminals' slice", async () => {
    const { deps, calls } = fakeSystemd({});
    await probeContainment(caps, deps);
    const probe = probeArgs(calls);
    expect(valueAfter(probe, "-p")).toEqual([
      "MemoryMax=50%",
      "OOMPolicy=continue",
      "CollectMode=inactive-or-failed",
    ]);
    expect(probe).toContain(`--slice=${TERMINALS_SLICE}`);
  });

  it("reaches systemd with the bus's directory alone, as a holder's launch will", async () => {
    const { deps, calls } = fakeSystemd({});
    await probeContainment(caps, deps);
    expect(calls.map((c) => c.env)).toEqual(calls.map(() => ({ XDG_RUNTIME_DIR: XDG })));
  });

  it("leaves OOMPolicy out before systemd 253, which would refuse it", async () => {
    const { deps, calls } = fakeSystemd({ version: "systemd 252 (252.1)" });
    const got = await probeContainment(caps, deps);
    expect(got).toMatchObject({ kind: "scoped", systemd: 252, oomPolicy: false });
    const probe = probeArgs(calls);
    expect(probe.some((a) => a.startsWith("OOMPolicy"))).toBe(false);
  });

  it("takes infinity as no cap, which the kernel shows as max", async () => {
    const reading = { memory: "max\n", slice: "max\n" };
    const probe = { code: 0, stdout: JSON.stringify(reading), stderr: "" };
    const { deps } = fakeSystemd({ probe });
    expect(await probeContainment({ terminal: "infinity", total: "infinity" }, deps)).toMatchObject(
      {
        kind: "scoped",
        terminalBytes: null,
        totalBytes: null,
      },
    );
  });

  const refusals: [string, Parameters<typeof fakeSystemd>[0], string][] = [
    ["on macOS", { platform: "darwin" }, "darwin has no cgroups"],
    ["with no XDG_RUNTIME_DIR", { env: { PATH: "/usr/bin" } }, "XDG_RUNTIME_DIR isn't set"],
    ["without systemd-run", { onPath: ["systemctl"] }, "systemd-run or systemctl isn't on PATH"],
    ["when systemd-run can't say its version", { version: "" }, "systemd-run --version failed"],
    [
      "when the slice's cap can't be set",
      { set: { code: 1, stdout: "", stderr: "Failed to connect to bus: No medium found" } },
      "couldn't set bazhen-terminals.slice's cap: Failed to connect to bus",
    ],
    [
      "when the probe scope won't start",
      { probe: { code: 1, stdout: "", stderr: "Unit already exists" } },
      "a probe scope wouldn't start: Unit already exists",
    ],
    [
      "when the kernel shows no cap the manager took",
      { probe: { code: 0, stdout: JSON.stringify({ memory: "max\n", slice: "1\n" }), stderr: "" } },
      "enforces no cap here",
    ],
    [
      "when the memory controller isn't there to read",
      { probe: { code: 0, stdout: "{}", stderr: "" } },
      "the kernel shows no memory.max",
    ],
  ];

  it.each(refusals)("leaves them uncontained %s, and says why", async (_, answers, why) => {
    const { deps } = fakeSystemd(answers);
    const got = await probeContainment(caps, deps);
    expect(got).toEqual({ kind: "uncontained", why: expect.stringContaining(why) });
  });

  it("refuses a cap systemd wouldn't take, before running anything", async () => {
    const { deps, calls } = fakeSystemd({});
    const got = await probeContainment({ terminal: "8GB", total: "80%" }, deps);
    expect(got).toEqual({ kind: "uncontained", why: expect.stringContaining("8GB") });
    expect(calls).toEqual([]);
  });
});

describe("the sizes a cap may be given in", () => {
  it.each(["8G", "512M", "1073741824", "50%", "12.5%", "100%", "infinity"])("takes %s", (size) => {
    expect(MEMORY_MAX.test(size)).toBe(true);
  });

  it.each(["8GB", "8g", "-1", "101%", "100.5%", "", "max", "8 G"])("refuses %j", (size) => {
    expect(MEMORY_MAX.test(size)).toBe(false);
  });
});

describe("a terminal's scope launch", () => {
  it("names a scope of the terminal's own, unique to this launch, in the terminals' slice", () => {
    const { argv } = terminalScope(scoped(true), "term_abc", () => "0123456789ab");
    expect(argv[0]).toBe(RUN);
    expect(argv).toContain("--unit=bazhen-terminal-term_abc-0123456789ab.scope");
    expect(argv).toContain(`--slice=${TERMINALS_SLICE}`);
    expect(argv.at(-1)).toBe("--");
  });

  it("caps it at the terminal's cap and keeps its holder through an OOM kill", () => {
    const { argv } = terminalScope(scoped(true), "term_abc");
    expect(valueAfter(argv, "-p")).toEqual([
      "MemoryMax=50%",
      "OOMPolicy=continue",
      "CollectMode=inactive-or-failed",
    ]);
  });

  it("leaves OOMPolicy to the kernel before systemd 253", () => {
    const { argv } = terminalScope(scoped(false), "term_abc");
    expect(valueAfter(argv, "-p")).toEqual(["MemoryMax=50%", "CollectMode=inactive-or-failed"]);
  });

  it("needs only the bus's directory in the environment", () => {
    expect(terminalScope(scoped(true), "term_abc").env).toEqual({ XDG_RUNTIME_DIR: XDG });
  });
});

describe("which processes run in a terminal's scope", () => {
  const base = "/user.slice/user-1000.slice/user@1000.service";
  it.each([
    [`${base}/bazhen.slice/${TERMINALS_SLICE}/bazhen-terminal-term_a-0f.scope`, true],
    [`${base}/bazhen.slice/bazhen-tests.slice/bazhen-terminal-term_a-0f.scope`, false],
    [`${base}/app.slice/${TERMINALS_SLICE}/bazhen-terminal-term_a-0f.scope`, false],
    [`${base}/bazhen.slice/${TERMINALS_SLICE}/bazhen-capped-1-0f.scope`, false],
    [`${base}/app.slice/app-cosmic-term-20805.scope`, false],
  ])("%s: %s", (cgroup, contained) => {
    expect(isTerminalScope(cgroup)).toBe(contained);
  });

  it("reads a process's cgroup from /proc, and says nothing of one it can't read", () => {
    const cgroup = `0::${base}/bazhen.slice/${TERMINALS_SLICE}/bazhen-terminal-term_a-0f.scope\n`;
    const read = procWith({ "/proc/42/cgroup": cgroup });
    expect(inTerminalScope(42, read)).toBe(true);
    expect(inTerminalScope(43, read)).toBeNull();
  });
});

describe("a probe's reading", () => {
  it("keeps the fields it knows, as strings", () => {
    expect(parseProbe('{"memory":"1\\n","slice":2,"other":"x"}')).toEqual({
      memory: "1\n",
      swap: undefined,
      slice: undefined,
      sliceSwap: undefined,
    });
  });

  it.each(["", "not json", "null", "3"])("is nothing for %j", (stdout) => {
    expect(parseProbe(stdout)).toBeUndefined();
  });
});
