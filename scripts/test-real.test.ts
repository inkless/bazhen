import { afterEach, describe, expect, it, vi } from "vitest";
import {
  looksSecret,
  ownerOf,
  parseArgs,
  pins,
  tmuxBuildArgs,
  cpuBudget,
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

describe("pnpm test:real", () => {
  it("runs the suites it is given, once each and in order, or integration, api and e2e", () => {
    expect(parseArgs([]).suites).toEqual(["integration", "api", "e2e"]);
    expect(parseArgs(["falsify", "api", "falsify"]).suites).toEqual(["falsify", "api"]);
  });

  it("judges falsify against main, or the base it is given", () => {
    expect(parseArgs(["falsify"]).base).toBe("origin/main");
    expect(parseArgs(["falsify", "--base", "gz/below"])).toEqual({
      suites: ["falsify"],
      base: "gz/below",
    });
  });

  it("refuses a suite it does not know, or a --base without a ref, rather than running none", () => {
    expect(() => parseArgs(["api", "medium"])).toThrow("unknown suite medium");
    expect(() => parseArgs(["falsify", "--base"])).toThrow("usage");
    expect(() => parseArgs(["--base", "--api"])).toThrow("usage");
  });

  it("builds the image on the repository's own node, pnpm and Playwright pins", () => {
    expect(pins(read(repo))).toEqual({
      NODE_VERSION: "26.13.0",
      PNPM_VERSION: "12.16.1",
      PLAYWRIGHT_VERSION: "1.64.1",
    });
  });

  it("builds the Dockerfile's tmux unless a version and its checksum are both named", () => {
    expect(tmuxBuildArgs({})).toEqual({});
    expect(tmuxBuildArgs({ BZ_TMUX_VERSION: "3.4", BZ_TMUX_SHA256: "ab" })).toEqual({
      TMUX_VERSION: "3.4",
      TMUX_SHA256: "ab",
    });
    expect(() => tmuxBuildArgs({ BZ_TMUX_VERSION: "3.4" })).toThrow("together");
    expect(() => tmuxBuildArgs({ BZ_TMUX_SHA256: "ab" })).toThrow("together");
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

const result = (code: number | null, out = "", err = ""): DockerResult => ({ code, out, err });

/**
 * What a fake host answers one docker command with. A pending call settles when it is stopped,
 * as docker does when a signal reaches it; a wedged one never settles, as on a stuck daemon.
 */
type Answer = DockerResult | "pending" | "wedged";

const never = new Promise<never>(() => {});

/** A host in memory. `answer` decides each docker command's result. */
function fakeHost(
  answer: (args: readonly string[]) => Answer,
  more: { alive?: number[]; dirs?: string[]; prepare?: () => never; timeouts?: boolean } = {},
) {
  const calls: string[][] = [];
  const stopped: NodeJS.Signals[] = [];
  const removed: string[] = [];
  const waiting: string[][] = [];
  const handlers = new Set<(signal: NodeJS.Signals) => void>();
  const host: Host = {
    pid: OWN_PID,
    id: HOST,
    docker(args): DockerCall {
      calls.push([...args]);
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
  };
  const signal = (s: NodeJS.Signals) => {
    for (const handler of handlers) handler(s);
  };
  /** The command most recently left waiting, by its first two words. */
  const waitingOn = () => waiting.at(-1)?.slice(0, 2).join(" ");
  return { host, calls, stopped, removed, handlers, signal, waitingOn };
}

const verb = (args: readonly string[]) => args.slice(0, 2).join(" ");
/** The argument after `flag` in a command, or undefined when the command lacks it. */
const valueAfter = (args: readonly string[] | undefined, flag: string) =>
  args?.[args.indexOf(flag) + 1];
const passing = (): Answer => result(0);
const isIntegration = (args: readonly string[]) =>
  args[0] === "run" && args.includes("test:integration");
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

describe("pnpm test:real cleans up after itself", () => {
  it("names its run, image and containers by its own pid and host, and labels them with both", async () => {
    const fake = fakeHost(passing);
    expect(await run(["api"], fake.host)).toBe(0);
    const build = fake.calls.find((c) => c[0] === "build");
    const suite = fake.calls.find((c) => c[0] === "run");
    expect(build).toEqual(expect.arrayContaining(["--tag", IMAGE, "org.bazhen.test-real=1"]));
    expect(build).toContain(`org.bazhen.test-real.owner-pid=${OWN_PID}`);
    expect(build).toContain(`org.bazhen.test-real.host=${HOST}`);
    expect(suite).toEqual(expect.arrayContaining(["--name", `${RUN}-api`, IMAGE]));
    expect(suite).toContain(`org.bazhen.test-real.owner-pid=${OWN_PID}`);
    expect(suite).toContain(`org.bazhen.test-real.host=${HOST}`);
    expect(ownerOf(RUN)).toBe(OWN_PID);
  });

  it("gives each suite's container a CPU budget, so the run cannot take the machine", async () => {
    const fake = fakeHost(passing);
    expect(await run(["api"], fake.host)).toBe(0);
    const suite = fake.calls.find((c) => c[0] === "run");
    expect(suite).toContain("--cpus");
    expect(Number(valueAfter(suite, "--cpus"))).toBeGreaterThan(0);
  });

  it("removes its image and context when the build fails, and runs no suite", async () => {
    const fake = fakeHost(buildFails);
    expect(await run(["api"], fake.host)).toBe(1);
    expect(fake.calls.some((c) => c[0] === "run")).toBe(false);
    expect(cleanup(fake.calls)).toEqual([["image", "rm", IMAGE]]);
    expect(fake.removed).toEqual([`/tmp/${RUN}`]);
    expect(fake.handlers.size).toBe(0);
  });

  it("removes its containers, image and context when a suite fails, after running the rest", async () => {
    const fake = fakeHost(integrationFails);
    expect(await run(["integration", "api"], fake.host)).toBe(1);
    expect(fake.calls.filter((c) => c[0] === "run")).toHaveLength(2);
    expect(cleanup(fake.calls)).toEqual([
      ["rm", "--force", `${RUN}-integration`, `${RUN}-api`],
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
    expect(fake.stopped).toEqual(["SIGTERM"]);
    expect(fake.calls.filter((c) => c[0] === "run")).toHaveLength(1);
    expect(cleanup(fake.calls)).toEqual([
      ["rm", "--force", `${RUN}-integration`],
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
    expect(fake.calls.some((c) => c[0] === "run")).toBe(false);
    expect(cleanup(fake.calls)).toEqual([["image", "rm", IMAGE]]);
    expect(fake.removed).toEqual([`/tmp/${RUN}`]);
  });

  it("exits 128 + the signal's number when it arrives during a passing run's cleanup", async () => {
    const fake = fakeHost(imageRmHangs);
    const exit = run(["api"], fake.host);
    await expect.poll(fake.waitingOn).toBe("image rm");
    fake.signal("SIGHUP");
    expect(await exit).toBe(129);
    expect(fake.stopped).toEqual(["SIGHUP"]);
  });

  it("abandons the rest of its cleanup on a second signal, and says what it left", async () => {
    const warn = quietly();
    const fake = fakeHost(integrationHangsThenRmWedged);
    const exit = run(["integration"], fake.host);
    await expect.poll(fake.waitingOn).toBe("run --rm");
    fake.signal("SIGTERM");
    await expect.poll(fake.waitingOn).toBe("rm --force");
    fake.signal("SIGINT");
    await expect.poll(() => fake.stopped).toEqual(["SIGTERM", "SIGKILL"]);
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
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`left ${RUN}-api;`));
    warn.mockClear();
    expect(await run(["api"], fakeHost(rmFindsNothing).host)).toBe(0);
    expect(await run(["api"], fakeHost(imageNotKnown).host)).toBe(0);
    expect(warn).not.toHaveBeenCalled();
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

describe("pnpm test:real's stop", () => {
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

describe("pnpm test:real's sweep of runs that died", () => {
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
