import { SLICE } from "@bazhen/host-guard";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RUST_TOOLS } from "./rust-gate.ts";
import { GROUPS } from "./holder-mutants.ts";
import {
  MUTANT_GROUPS,
  SUITE_NAMES,
  suiteCommand,
  looksSecret,
  ownerOf,
  parseArgs,
  pins,
  cpuBudget,
  memoryBudget,
  run,
  stopper,
  sweep,
  type DockerCall,
  type DockerResult,
  type Host,
} from "./test-real.ts";

const repo: Record<string, string> = {
  ".nvmrc": "26.13.0\n",
  "package.json": JSON.stringify({ packageManager: "pnpm@12.16.1" }),
  "tests/e2e/package.json": JSON.stringify({ devDependencies: { "@playwright/test": "1.64.1" } }),
};
const read = (files: Record<string, string>) => (path: string) => files[path] ?? "";

describe("make test-real", () => {
  it("runs the suites it is given, once each and in order, or all but falsify", () => {
    expect(parseArgs([]).suites).toEqual(["integration", "api", "e2e", "holder", "rust"]);
    expect(parseArgs(["falsify", "api", "falsify"]).suites).toEqual(["falsify", "api"]);
    expect(parseArgs(["soak"]).suites).toEqual(["soak"]);
    expect(suiteCommand("soak")).toEqual(["make", "test-soak"]);
  });

  it("judges falsify against main, or the base it is given", () => {
    expect(parseArgs(["falsify"]).base).toBe("origin/main");
    expect(parseArgs(["falsify", "--base", "gz/below"])).toEqual({
      suites: ["falsify"],
      base: "gz/below",
    });
  });

  it("runs the holder's mutants by the group it is given, and a shard of it", () => {
    expect(parseArgs(["mutants", "--group", "signal", "--shard", "1/3"])).toEqual({
      suites: ["mutants"],
      base: "origin/main",
      mutants: { group: "signal", shard: "1/3" },
    });
    expect(suiteCommand("mutants", { group: "signal", shard: "1/3" })).toEqual([
      "make",
      "test-mutants-holder",
      "ARGS=--group signal --shard 1/3",
    ]);
  });

  it("passes on --only, which narrows the group to the mutants it names", () => {
    const only = "^crates/bazhen-holder/src/ring\\.rs:(?:10|12):";
    expect(parseArgs(["mutants", "--group", "rest", "--only", only])).toEqual({
      suites: ["mutants"],
      base: "origin/main",
      mutants: { group: "rest", only },
    });
    expect(suiteCommand("mutants", { group: "rest", only })).toEqual([
      "make",
      "test-mutants-holder",
      "ARGS=--group rest --only '^crates/bazhen-holder/src/ring\\.rs:(?:10|12):'",
    ]);
  });

  it("refuses a mutant group the sweep doesn't have, or whose code the container doesn't compile, before building anything", () => {
    expect(() => parseArgs(["mutants", "--group", "everything"])).toThrow("no mutant group");
    expect(GROUPS.macos.platform).toBe("darwin");
    expect(() => parseArgs(["mutants", "--group", "macos"])).toThrow("no mutant group");
    expect(MUTANT_GROUPS).toEqual(
      Object.entries(GROUPS)
        .filter(([, spec]) => spec.platform === undefined)
        .map(([name]) => name),
    );
  });

  it("refuses the mutants suite without a group, and a group or shard without the mutants suite", () => {
    expect(() => parseArgs(["mutants"])).toThrow("needs a group");
    expect(() => parseArgs(["holder", "--group", "signal"])).toThrow("needs a group");
    expect(() => parseArgs(["mutants", "--shard", "1/3"])).toThrow("needs a group");
    expect(() => parseArgs(["mutants", "--only", "ring"])).toThrow("needs a group");
    expect(() => parseArgs(["holder", "--only", "ring"])).toThrow("needs a group");
    expect(() => parseArgs(["mutants", "--group", "rest", "--only", "ring("])).toThrow(
      "--only takes a regex",
    );
    expect(() => parseArgs(["mutants", "--group", "rest", "--only", ""])).toThrow("it is empty");
    expect(() => parseArgs(["mutants", "--group"])).toThrow("usage");
  });

  it("refuses a suite it does not know, or a --base without a ref, rather than running none", () => {
    expect(() => parseArgs(["api", "medium"])).toThrow("unknown suite medium");
    expect(() => parseArgs(["falsify", "--base"])).toThrow("usage");
    expect(() => parseArgs(["--base", "--api"])).toThrow("usage");
  });

  it("builds the image on the repository's own node, pnpm, Playwright and Rust tool pins", () => {
    expect(pins(read(repo))).toEqual({
      NODE_VERSION: "26.13.0",
      PNPM_VERSION: "12.16.1",
      PLAYWRIGHT_VERSION: "1.64.1",
      NEXTEST_VERSION: RUST_TOOLS["cargo-nextest"],
      CARGO_MUTANTS_VERSION: RUST_TOOLS["cargo-mutants"],
    });
  });

  it("runs a suite's make target, and falsify against the image's base, then the base's falsify", () => {
    expect(suiteCommand("api")).toEqual(["make", "test-api"]);
    expect(suiteCommand("falsify")).toEqual([
      "sh",
      "-c",
      "make test-falsify ARGS='--base refs/remotes/origin/main' && " +
        "make test-falsify-base ARGS='--base refs/remotes/origin/main'",
    ]);
  });

  it("refuses to build when a pin is missing", () => {
    expect(() => pins(read({ ...repo, "package.json": "{}" }))).toThrow("not pinned");
  });

  it("gives a suite half the machine, so its own load cannot take the rest of it", () => {
    expect(cpuBudget({}, 32)).toBe("16");
    expect(cpuBudget({}, 4)).toBe("2");
    // An odd core count floors: five cores is two for the suite, never three.
    expect(cpuBudget({}, 5)).toBe("2");
    // A one- or two-core machine still gets both: a fraction of itself is no quota at all.
    expect(cpuBudget({}, 1)).toBe("2");
    expect(cpuBudget({ BZ_TEST_CPUS: "3" }, 32)).toBe("3");
    expect(cpuBudget({ BZ_TEST_CPUS: "0.5" }, 32)).toBe("0.5");
    expect(() => cpuBudget({ BZ_TEST_CPUS: "many" }, 32)).toThrow("BZ_TEST_CPUS");
    expect(() => cpuBudget({ BZ_TEST_CPUS: "0" }, 32)).toThrow("BZ_TEST_CPUS");
  });

  it("gives a suite half the machine's memory in the shared slice, a quarter outside it", () => {
    const gib = 1024 ** 3;
    expect(memoryBudget({}, 64 * gib, true)).toBe(String(32 * gib));
    expect(memoryBudget({}, 64 * gib, false)).toBe(String(16 * gib));
    expect(memoryBudget({ BZ_TEST_MEMORY: "6" }, 64 * gib, true)).toBe(String(6 * gib));
    expect(() => memoryBudget({ BZ_TEST_MEMORY: "8G" }, 64 * gib, true)).toThrow("BZ_TEST_MEMORY");
    expect(() => memoryBudget({ BZ_TEST_MEMORY: "0.5" }, 64 * gib, true)).toThrow("BZ_TEST_MEMORY");
  });

  it("keeps a file that looks like a secret out of the image, and every other file in", () => {
    const secret = [
      ".env",
      "apps/web/.env.local",
      "certs/dev.pem",
      "x.key",
      "id_ed25519",
      ".npmrc",
    ];
    const secretToo = ["aws-credentials.json", "client_secret.json"];
    const kept = ["src/tokens.test.ts", "environment.ts", "keys.test.ts", "README.md"];
    expect([...secret, ...secretToo].filter((p) => !looksSecret(p))).toEqual([]);
    expect(kept.filter(looksSecret)).toEqual([]);
  });
});

const OWN_PID = 4242;
const HOST = "this-host";
const RUN = `bz-real-${OWN_PID}-AbC123`;
const IMAGE = `bazhen-test-real:${RUN}`;
const PROBES = [`${RUN}-slice-probe-0`, `${RUN}-slice-probe-1`];
/** The probe's container id, as `docker inspect` prints it and its cgroup names it. */
const PROBE_ID = "8308b241d5e554f9f53cb7d564ac0d4005e37119f15c6cb6bbd630ea6d859ded";
const GIB = 1024 ** 3;

const result = (code: number | null, out = "", err = ""): DockerResult => ({ code, out, err });

/**
 * What a fake host answers one docker command with. A pending call settles when it is stopped,
 * as docker does when a signal reaches it; a wedged one never settles, as on a stuck daemon.
 */
type Answer = DockerResult | "pending" | "wedged";

const never = new Promise<never>(() => {});

/**
 * A host in memory. `answer` decides each docker command's result. It is disposable unless told
 * otherwise, as a CI runner is, so a test of something other than where containers land needs no
 * slice. Its probe's cgroup reads as `cgroup` only while the probe runs, as `/proc` does.
 */
function fakeHost(
  answer: (args: readonly string[]) => Answer,
  more: {
    alive?: number[];
    dirs?: string[];
    prepare?: () => never;
    timeouts?: boolean;
    cgroup?: string;
    sliceCap?: number;
    disposable?: boolean;
    cgroupThrows?: boolean;
  } = {},
) {
  const calls: string[][] = [];
  const stopped: NodeJS.Signals[] = [];
  const removed: string[] = [];
  const waiting: string[][] = [];
  const handlers = new Set<(signal: NodeJS.Signals) => void>();
  let probeRuns = false;
  const host: Host = {
    pid: OWN_PID,
    id: HOST,
    disposable: more.disposable ?? true,
    totalMemory: 64 * GIB,
    docker(args): DockerCall {
      calls.push([...args]);
      if (verb(args) === "run --detach") probeRuns = true;
      if (args[0] === "stop") probeRuns = false;
      const answered = answer(args);
      if (typeof answered === "object") return { done: Promise.resolve(answered), stop: () => {} };
      let settle!: (r: DockerResult) => void;
      const done = new Promise<DockerResult>((resolve) => (settle = resolve));
      waiting.push([...args]);
      const stop = (signal: NodeJS.Signals) => {
        stopped.push(signal);
        if (answered === "pending") settle(result(130));
      };
      return { done, stop };
    },
    prepare: more.prepare ?? (() => ({ dir: `/tmp/${RUN}`, buildArgs: { NODE_VERSION: "26" } })),
    removeDir: (dir) => removed.push(dir),
    runDirs: () => more.dirs ?? [],
    isAlive: (pid) => (more.alive ?? []).includes(pid),
    onSignal(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    after: () => (more.timeouts === true ? Promise.resolve() : never),
    cgroupOf: () => {
      if (more.cgroupThrows === true && probeRuns) throw new Error("cgroupOf threw");
      return probeRuns ? more.cgroup : undefined;
    },
    memoryMax: (cgroup) => (cgroup.endsWith(`/${SLICE}`) ? more.sliceCap : undefined),
  };
  const signal = (s: NodeJS.Signals) => {
    for (const handler of handlers) handler(s);
  };
  /** The command most recently left waiting, by its first two words. */
  const waitingOn = () => waiting.at(-1)?.slice(0, 2).join(" ");
  return { host, calls, stopped, removed, handlers, signal, waitingOn };
}

const verb = (args: readonly string[]) => args.slice(0, 2).join(" ");
/** A suite's own container, not the probe that checks where containers land. */
const isSuiteRun = (args: readonly string[]) => args[0] === "run" && !args.includes("--detach");
/** The argument after `flag` in a command, or undefined when the command lacks it. */
const valueAfter = (args: readonly string[] | undefined, flag: string) =>
  args?.[args.indexOf(flag) + 1];
const passing = (): Answer => result(0);
/** tini's setting that passes a signal to the whole process group of the command it runs. */
const GROUP_SIGNAL = "--env TINI_KILL_PROCESS_GROUP=1";
const uid = process.getuid?.() ?? -1;
const userSlice = `/user.slice/user-${uid}.slice/user@${uid}.service/bazhen.slice/${SLICE}`;
/** The memory a suite's container gets when the probe lands in `cgroup`. */
async function memoryOf(cgroup: string): Promise<number> {
  const fake = fakeHost(probeHasPid, { cgroup, sliceCap: 2 ** 34 });
  await run(["api"], fake.host);
  return Number(valueAfter(fake.calls.find(isSuiteRun), "--memory"));
}

const probeHasPid = (args: readonly string[]): Answer =>
  verb(args) === "inspect --format" ? result(0, `4343 ${PROBE_ID}\n`) : passing();
const isIntegration = (args: readonly string[]) =>
  args[0] === "run" && args.includes("test-integration");
const buildFails = (args: readonly string[]) => (args[0] === "build" ? result(1) : passing());
const buildHangs = (args: readonly string[]) => (args[0] === "build" ? "pending" : passing());
const integrationFails = (args: readonly string[]) => (isIntegration(args) ? result(1) : passing());
const integrationHangs = (args: readonly string[]) => (isIntegration(args) ? "pending" : passing());
const imageRmHangs = (args: readonly string[]): Answer =>
  verb(args) === "image rm" ? "pending" : passing();
const imageRmWedged = (args: readonly string[]): Answer =>
  verb(args) === "image rm" ? "wedged" : passing();
const integrationHangsThenRmWedged = (args: readonly string[]): Answer =>
  args[0] === "rm" ? "wedged" : integrationHangs(args);
const rmConflicts = (args: readonly string[]): Answer =>
  args[0] === "rm" ? result(1, "", "Error response from daemon: conflict") : passing();
const rmFindsNothing = (args: readonly string[]): Answer =>
  args[0] === "rm"
    ? result(1, "", `Error response from daemon: No such container: ${RUN}-api`)
    : passing();
/** What Podman's `docker` shim prints on stderr before every command. */
const SHIM_NOTICE =
  "Emulate Docker CLI using podman. Create /etc/containers/nodocker to quiet msg.";
const imageNotKnown = (args: readonly string[]): Answer =>
  verb(args) === "image rm"
    ? result(2, "", `${SHIM_NOTICE}\nError: ${IMAGE}: image not known\n`)
    : passing();
const failing = () => {
  throw new Error("no such ref");
};
const isRemoval = (c: string[]) => c[0] === "rm" || verb(c) === "image rm";
const cleanup = (calls: string[][]) => calls.filter(isRemoval);
const quietly = () => vi.spyOn(console, "warn").mockImplementation(() => {});
afterEach(() => vi.restoreAllMocks());
/** The first probe hangs until stopped, and any other won't start. */
const firstProbeHangs = (args: readonly string[]): Answer => {
  if (verb(args) !== "run --detach") return passing();
  return args.includes(`${RUN}-slice-probe-0`) ? "pending" : result(125);
};
const probeWontStart = (args: readonly string[]): Answer =>
  verb(args) === "run --detach" ? result(125) : probeHasPid(args);
/** A run on a machine people work on, where the probe answers `answer` and lands in `cgroup`. */
async function onAWorkstation(answer: (args: readonly string[]) => Answer, cgroup?: string) {
  const said = vi.spyOn(console, "error").mockImplementation(() => {});
  const fake = fakeHost(answer, { ...(cgroup === undefined ? {} : { cgroup }), disposable: false });
  const code = await run(["api"], fake.host);
  const message = said.mock.calls.flat().join("\n");
  return {
    code,
    suiteStarted: fake.calls.some(isSuiteRun),
    imageRemoved: cleanup(fake.calls).some((c) => c.join(" ") === `image rm ${IMAGE}`),
    refused: message.includes("Refusing to start"),
    said: message,
  };
}
const refusal = (why: string) => ({
  code: 1,
  suiteStarted: false,
  imageRemoved: true,
  refused: true,
  said: expect.stringContaining(why),
});

describe("make test-real cleans up after itself", () => {
  it("names its run, image and containers by its own pid and host, and labels them with both", async () => {
    const fake = fakeHost(passing);
    expect(await run(["api"], fake.host)).toBe(0);
    const build = fake.calls.find((c) => c[0] === "build");
    const suite = fake.calls.find(isSuiteRun);
    expect(build).toEqual(expect.arrayContaining(["--tag", IMAGE, "org.bazhen.test-real=1"]));
    expect(build).toContain(`org.bazhen.test-real.owner-pid=${OWN_PID}`);
    expect(build).toContain(`org.bazhen.test-real.host=${HOST}`);
    expect(suite).toEqual(expect.arrayContaining(["--name", `${RUN}-api`, IMAGE]));
    expect(suite).toContain(`org.bazhen.test-real.owner-pid=${OWN_PID}`);
    expect(suite).toContain(`org.bazhen.test-real.host=${HOST}`);
    expect(ownerOf(RUN)).toBe(OWN_PID);
  });

  it("has every suite's init pass a signal to the suite's whole group, not to make or a shell alone", async () => {
    const fake = fakeHost(passing);
    expect(await run([...SUITE_NAMES, "--group", "signal"], fake.host)).toBe(0);
    expect(
      fake.calls
        .filter(isSuiteRun)
        .map((c) => [
          valueAfter(c, "--name"),
          c.includes("--init"),
          c.join(" ").includes(GROUP_SIGNAL),
        ]),
    ).toEqual(SUITE_NAMES.map((suite) => [`${RUN}-${suite}`, true, true]));
  });

  it("passes any signal on to the running suite as SIGINT, which make leaves to its group", async () => {
    const stopped = await Promise.all(
      (["SIGINT", "SIGHUP", "SIGTERM"] as const).map(async (signal) => {
        const fake = fakeHost(integrationHangs);
        const exit = run(["integration"], fake.host);
        await expect.poll(fake.waitingOn).toBe("run --rm");
        fake.signal(signal);
        await exit;
        return fake.stopped;
      }),
    );
    expect(stopped).toEqual([["SIGINT"], ["SIGINT"], ["SIGINT"]]);
  });

  it("gives each suite's container a CPU budget, so the run cannot take the machine", async () => {
    const fake = fakeHost(passing);
    expect(await run(["api"], fake.host)).toBe(0);
    const suite = fake.calls.find(isSuiteRun);
    expect(suite).toContain("--cpus");
    expect(Number(valueAfter(suite, "--cpus"))).toBeGreaterThan(0);
  });

  it("puts each suite's container in the slice every capped run shares, where a probe lands", async () => {
    const fake = fakeHost(probeHasPid, {
      cgroup: `${userSlice}/libpod-${PROBE_ID}.scope`,
      sliceCap: 2 ** 34,
      disposable: false,
    });
    expect(await run(["api"], fake.host)).toBe(0);
    expect(valueAfter(fake.calls.find(isSuiteRun), "--cgroup-parent")).toBe(SLICE);
  });

  it("gives a container in the slice twice the memory of one outside it", async () => {
    quietly();
    const inSlice = await memoryOf(`${userSlice}/libpod-${PROBE_ID}.scope`);
    const outside = await memoryOf(`/bazhen.slice/${SLICE}/docker-${PROBE_ID}.scope`);
    expect(Math.abs(inSlice - 2 * outside)).toBeLessThan(4);
  });

  it("stops the probe it started, and tries once more where it couldn't read where it landed", async () => {
    const fake = fakeHost(passing);
    quietly();
    expect(await run(["api"], fake.host)).toBe(0);
    expect(fake.calls.filter((c) => verb(c) === "run --detach")).toHaveLength(2);
    expect(fake.calls.filter((c) => c[0] === "stop").map((c) => c.at(-1))).toEqual([
      `${RUN}-slice-probe-0`,
      `${RUN}-slice-probe-1`,
    ]);
  });

  it("reads the slice's own cap, however deep a runtime puts its containers below it", async () => {
    const fake = fakeHost(probeHasPid, {
      cgroup: `${userSlice}/libpod-${PROBE_ID}.scope/container`,
      sliceCap: 2 ** 34,
      disposable: false,
    });
    expect(await run(["api"], fake.host)).toBe(0);
    expect(valueAfter(fake.calls.find(isSuiteRun), "--cgroup-parent")).toBe(SLICE);
  });

  it("on a disposable host, keeps the containers out of a slice with no cap, which holds nothing together", async () => {
    const warn = quietly();
    const fake = fakeHost(probeHasPid, {
      cgroup: `${userSlice}/libpod-${PROBE_ID}.scope`,
      disposable: true,
    });
    expect(await run(["api"], fake.host)).toBe(0);
    expect(fake.calls.find(isSuiteRun)).not.toContain("--cgroup-parent");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`${SLICE} has no memory cap`));
  });

  it("on a disposable host, runs the suites where they would have run, and says so, where the probe lands elsewhere", async () => {
    const warn = quietly();
    // Rootful Docker under systemd makes a system slice of the same name, without the cap.
    const fake = fakeHost(probeHasPid, {
      cgroup: `/bazhen.slice/${SLICE}/docker-${PROBE_ID}.scope`,
      disposable: true,
    });
    expect(await run(["api"], fake.host)).toBe(0);
    expect(fake.calls.find(isSuiteRun)).not.toContain("--cgroup-parent");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`lands in /bazhen.slice/${SLICE}`));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("a quarter of the machine"));
  });

  it("refuses to run outside the slice on a machine people work on, where the probe's cgroup can't be read", async () => {
    expect(await onAWorkstation(passing)).toEqual(refusal("cgroup couldn't be read"));
  });

  it("refuses to run outside the slice on a machine people work on, where the probe lands elsewhere", async () => {
    const elsewhere = `/bazhen.slice/${SLICE}/docker-${PROBE_ID}.scope`;
    expect(await onAWorkstation(probeHasPid, elsewhere)).toEqual(refusal(`lands in ${elsewhere}`));
  });

  it("refuses to run outside the slice on a machine people work on, where the slice has no cap", async () => {
    const uncapped = `${userSlice}/libpod-${PROBE_ID}.scope`;
    expect(await onAWorkstation(probeHasPid, uncapped)).toEqual(
      refusal(`${SLICE} has no memory cap`),
    );
  });

  it("refuses to run outside the slice on a machine people work on, where the probe won't start", async () => {
    expect(await onAWorkstation(probeWontStart)).toEqual(refusal("wouldn't start"));
  });

  it("refuses where the probe's pid names a process of this host's that isn't the probe, though it is in the slice", async () => {
    // A runtime in a pid namespace of its own hands back a pid that means another process here.
    const ours = `${userSlice}/bazhen-capped-1.scope`;
    expect(await onAWorkstation(probeHasPid, ours)).toEqual(refusal(`names a process in ${ours}`));
  });

  it("refuses where the slice's cap is the whole machine, which holds nothing together", async () => {
    const said = vi.spyOn(console, "error").mockImplementation(() => {});
    const fake = fakeHost(probeHasPid, {
      cgroup: `${userSlice}/libpod-${PROBE_ID}.scope`,
      sliceCap: 64 * GIB,
      disposable: false,
    });
    expect(await run(["api"], fake.host)).toBe(1);
    expect(said).toHaveBeenCalledWith(expect.stringContaining(`${SLICE} has no memory cap`));
  });

  it("stops the probe even when reading where it landed throws", async () => {
    const fake = fakeHost(probeHasPid, { cgroupThrows: true });
    await expect(run(["api"], fake.host)).rejects.toThrow("cgroupOf threw");
    expect(fake.calls).toContainEqual(["stop", "--time", "0", PROBES[0]]);
  });

  it("removes both probes on the way out, should a probe's own stop have left one", async () => {
    const fake = fakeHost(probeHasPid, {
      cgroup: `${userSlice}/libpod-${PROBE_ID}.scope`,
      sliceCap: 2 ** 34,
    });
    expect(await run(["api"], fake.host)).toBe(0);
    expect(cleanup(fake.calls)[0]).toEqual(["rm", "--force", ...PROBES, `${RUN}-api`]);
  });

  it("starts no second probe once interrupted, and doesn't call the interruption a refusal", async () => {
    const said = vi.spyOn(console, "error").mockImplementation(() => {});
    const fake = fakeHost(firstProbeHangs, { disposable: false });
    const exit = run(["api"], fake.host);
    await expect.poll(fake.waitingOn).toBe("run --detach");
    fake.signal("SIGINT");
    expect(await exit).toBe(130);
    expect(fake.calls.filter((c) => verb(c) === "run --detach")).toHaveLength(1);
    expect(said).not.toHaveBeenCalledWith(expect.stringContaining("Refusing to start"));
  });

  it("gives each suite's container a memory cap with no swap beyond it", async () => {
    const fake = fakeHost(passing);
    expect(await run(["api"], fake.host)).toBe(0);
    const suite = fake.calls.find(isSuiteRun);
    expect(Number(valueAfter(suite, "--memory"))).toBeGreaterThan(0);
    expect(valueAfter(suite, "--memory-swap")).toBe(valueAfter(suite, "--memory"));
  });

  it("removes its image and context when the build fails, and runs no suite", async () => {
    const fake = fakeHost(buildFails);
    expect(await run(["api"], fake.host)).toBe(1);
    expect(fake.calls.some(isSuiteRun)).toBe(false);
    expect(cleanup(fake.calls)).toEqual([["image", "rm", IMAGE]]);
    expect(fake.removed).toEqual([`/tmp/${RUN}`]);
    expect(fake.handlers.size).toBe(0);
  });

  it("removes its containers, image and context when a suite fails, after running the rest", async () => {
    const fake = fakeHost(integrationFails);
    expect(await run(["integration", "api"], fake.host)).toBe(1);
    expect(fake.calls.filter(isSuiteRun)).toHaveLength(2);
    expect(cleanup(fake.calls)).toEqual([
      ["rm", "--force", ...PROBES, `${RUN}-integration`, `${RUN}-api`],
      ["image", "rm", IMAGE],
    ]);
    expect(fake.removed).toEqual([`/tmp/${RUN}`]);
  });

  it("stops the running suite on SIGTERM, runs no other, cleans up and exits 143", async () => {
    const fake = fakeHost(integrationHangs);
    const exit = run(["integration", "api"], fake.host);
    await expect.poll(fake.waitingOn).toBe("run --rm");
    fake.signal("SIGTERM");
    expect(await exit).toBe(143);
    expect(fake.stopped).toEqual(["SIGINT"]);
    expect(fake.calls.filter(isSuiteRun)).toHaveLength(1);
    expect(cleanup(fake.calls)).toEqual([
      ["rm", "--force", ...PROBES, `${RUN}-integration`],
      ["image", "rm", IMAGE],
    ]);
    expect(fake.removed).toEqual([`/tmp/${RUN}`]);
    expect(fake.handlers.size).toBe(0);
  });

  it("stops an interrupted build, removes whatever it tagged and exits 130 on SIGINT", async () => {
    const fake = fakeHost(buildHangs);
    const exit = run(["api"], fake.host);
    await expect.poll(fake.waitingOn).toBe("build --tag");
    fake.signal("SIGINT");
    expect(await exit).toBe(130);
    expect(fake.stopped).toEqual(["SIGINT"]);
    expect(fake.calls.some(isSuiteRun)).toBe(false);
    expect(cleanup(fake.calls)).toEqual([["image", "rm", IMAGE]]);
    expect(fake.removed).toEqual([`/tmp/${RUN}`]);
  });

  it("exits 128 + the signal's number when it arrives during a passing run's cleanup", async () => {
    const fake = fakeHost(imageRmHangs);
    const exit = run(["api"], fake.host);
    await expect.poll(fake.waitingOn).toBe("image rm");
    fake.signal("SIGHUP");
    expect(await exit).toBe(129);
    expect(fake.stopped).toEqual(["SIGINT"]);
  });

  it("abandons the rest of its cleanup on a second signal, and says what it left", async () => {
    const warn = quietly();
    const fake = fakeHost(integrationHangsThenRmWedged);
    const exit = run(["integration"], fake.host);
    await expect.poll(fake.waitingOn).toBe("run --rm");
    fake.signal("SIGTERM");
    await expect.poll(fake.waitingOn).toBe("rm --force");
    fake.signal("SIGINT");
    await expect.poll(() => fake.stopped).toEqual(["SIGINT", "SIGKILL"]);
    expect(await exit).toBe(143);
    expect(fake.calls.some((c) => verb(c) === "image rm")).toBe(false);
    expect(fake.removed).toEqual([`/tmp/${RUN}`]);
    expect(fake.handlers.size).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`${RUN}-integration, ${IMAGE}`));
  });

  it("gives up a cleanup command that hangs, stops it, and says what it left", async () => {
    const warn = quietly();
    const fake = fakeHost(imageRmWedged, { timeouts: true });
    const exit = run(["api"], fake.host);
    await expect.poll(() => fake.stopped).toEqual(["SIGTERM"]);
    expect(await exit).toBe(0);
    expect(fake.removed).toEqual([`/tmp/${RUN}`]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`left ${IMAGE}`));
  });

  it("goes on cleaning up after a step fails, and reports only a real failure", async () => {
    const warn = quietly();
    const conflict = fakeHost(rmConflicts);
    expect(await run(["api"], conflict.host)).toBe(0);
    expect(cleanup(conflict.calls).map(verb)).toEqual(["rm --force", "image rm"]);
    expect(conflict.removed).toEqual([`/tmp/${RUN}`]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(`left ${PROBES.join(", ")}, ${RUN}-api;`),
    );
    warn.mockClear();
    expect(await run(["api"], fakeHost(rmFindsNothing).host)).toBe(0);
    expect(await run(["api"], fakeHost(imageNotKnown).host)).toBe(0);
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("left"));
  });

  it("stops listening for signals when the context can't be prepared", async () => {
    const fake = fakeHost(passing, { prepare: failing });
    await expect(run(["api"], fake.host)).rejects.toThrow("no such ref");
    expect(fake.calls.some((c) => c[0] === "build")).toBe(false);
    expect(fake.handlers.size).toBe(0);
  });
});

/** A grace period that ends when the test says. */
function grace() {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { wait: () => promise, elapse: () => resolve() };
}

describe("make test-real's stop", () => {
  it("kills a command still running when the grace period ends", async () => {
    const sent: NodeJS.Signals[] = [];
    const clock = grace();
    const stop = stopper(
      (s) => sent.push(s),
      () => false,
      clock.wait,
    );
    stop("SIGTERM");
    stop("SIGINT");
    clock.elapse();
    await expect.poll(() => sent).toEqual(["SIGTERM", "SIGINT", "SIGKILL"]);
  });

  it("never signals a command that has exited", async () => {
    const sent: NodeJS.Signals[] = [];
    let exited = false;
    const clock = grace();
    const stop = stopper(
      (s) => sent.push(s),
      () => exited,
      clock.wait,
    );
    stop("SIGTERM");
    exited = true;
    clock.elapse();
    stop("SIGINT");
    await Promise.resolve();
    expect(sent).toEqual(["SIGTERM"]);
  });
});

const dead = "bazhen-test-real:bz-real-111-aaaaaa";
const live = "bazhen-test-real:bz-real-222-bbbbbb";
const inUse = "bazhen-test-real:bz-real-333-cccccc";
const unlabelled = "bazhen-test-real:bz-real-444-dddddd";
const foreign = "postgres:bz-real-555-eeeeee";
const elsewhere = "bazhen-test-real:bz-real-666-ffffff";
const labels: Record<string, string> = {
  [dead]: `111\t${HOST}`,
  [live]: `222\t${HOST}`,
  [inUse]: `333\t${HOST}`,
  [unlabelled]: "\t",
  [foreign]: `555\t${HOST}`,
  [elsewhere]: "666\tdevcontainer",
  "bz-real-111-aaaaaa-api": `111\t${HOST}`,
  "bz-real-111-aaaaaa-e2e": `111\t${HOST}`,
  "bz-real-222-bbbbbb-api": `222\t${HOST}`,
  "bz-real-777-gggggg-e2e": "777\tdevcontainer",
  "postgres-db": `111\t${HOST}`,
};
/** Every container the labels match, and its state. */
const containers = [
  "bz-real-111-aaaaaa-api\texited",
  "bz-real-111-aaaaaa-e2e\trunning",
  "bz-real-222-bbbbbb-api\texited",
  "bz-real-777-gggggg-e2e\texited",
  "postgres-db\texited",
];

/**
 * A container CLI as Docker or Podman answers the sweep. Podman refuses `status=dead` and the
 * `.Label` template function, lists an image under `localhost/`, and calls a missing image "not
 * known"; it answers a ref with or without that prefix.
 */
const cli =
  (dialect: "docker" | "podman") =>
  (args: readonly string[]): Answer => {
    const last = (args.at(-1) ?? "").replace("localhost/", "");
    if (dialect === "podman" && args.includes("status=dead")) {
      return result(125, "", "Error: unknown container state: dead: invalid argument");
    }
    if (dialect === "podman" && args.some((a) => a.includes(".Label "))) {
      return result(125, "", "Error: template: ps:1:24: can't evaluate field Label");
    }
    const prefix = dialect === "podman" ? "localhost/" : "";
    const listed = Object.keys(labels).filter((ref) => ref.includes(":"));
    if (verb(args) === "image ls")
      return result(
        0,
        listed
          .map((r) => `${r.startsWith("postgres") ? "docker.io/library/" : prefix}${r}\n`)
          .join(""),
      );
    if (args[1] === "inspect") return result(0, `${labels[last] ?? ""}\n`);
    if (args[0] === "ps" && args.includes("--quiet")) {
      return result(0, last.endsWith(`=${inUse}`) ? "f00d\n" : "");
    }
    if (args[0] === "ps") return result(0, `${containers.join("\n")}\n`);
    return result(0);
  };
const host = cli("docker");

const isList = (c: string[]) => verb(c) === "image ls" || (c[0] === "ps" && !c.includes("--quiet"));

describe("make test-real's sweep of runs that died", () => {
  it("asks docker only for what this script labelled on this host", async () => {
    const fake = fakeHost(host, { alive: [222] });
    await sweep(fake.host);
    const lists = fake.calls.filter(isList);
    expect(lists).toHaveLength(2);
    for (const list of lists) {
      expect(list).toEqual(
        expect.arrayContaining([
          "label=org.bazhen.test-real.owner-pid",
          `label=org.bazhen.test-real.host=${HOST}`,
        ]),
      );
    }
    expect(fake.calls.find((c) => verb(c) === "image ls")).toContain("reference=bazhen-test-real");
  });

  it("removes only a labelled image of this host whose owner is gone and that no container uses", async () => {
    const fake = fakeHost(host, { alive: [222] });
    await sweep(fake.host);
    expect(fake.calls.filter((c) => verb(c) === "image rm")).toEqual([["image", "rm", dead]]);
  });

  it("removes the stopped containers of this host's gone runs, before judging their images", async () => {
    const fake = fakeHost(host, { alive: [222] });
    await sweep(fake.host);
    const removals = fake.calls.filter(isRemoval);
    expect(removals).toEqual([
      ["rm", "bz-real-111-aaaaaa-api"],
      ["image", "rm", dead],
    ]);
  });

  it("removes only the context dirs of runs that are gone, never its own", async () => {
    const dirs = [
      "/tmp/bz-real-111-xxxxxx",
      "/tmp/bz-real-222-yyyyyy",
      `/tmp/bz-real-${OWN_PID}-zzzzzz`,
    ];
    const fake = fakeHost(host, { alive: [222], dirs });
    await sweep(fake.host);
    expect(fake.removed).toEqual(["/tmp/bz-real-111-xxxxxx"]);
  });

  it("leaves a gone run's container that is still running, which only its own --rm removes", async () => {
    const fake = fakeHost(host, { alive: [222] });
    await sweep(fake.host);
    expect(fake.calls.filter((c) => c[0] === "rm").map((c) => c[1])).toEqual([
      "bz-real-111-aaaaaa-api",
    ]);
  });

  it("removes the same leftovers under Podman, which words its lists and errors its own way", async () => {
    quietly();
    const fake = fakeHost(cli("podman"), { alive: [222] });
    await sweep(fake.host);
    expect(fake.calls.filter(isRemoval)).toEqual([
      ["rm", "bz-real-111-aaaaaa-api"],
      ["image", "rm", `localhost/${dead}`],
    ]);
  });

  it("reads no owner from a name this script didn't make", () => {
    expect(ownerOf("bz-real-WDZqbF")).toBeUndefined();
    expect(ownerOf("bz-real-1-abcdef")).toBeUndefined();
  });
});
