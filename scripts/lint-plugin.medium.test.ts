import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const repo = fileURLToPath(new URL("..", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "bz-lint-plugin-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** What oxlint reports under `bazhen(host-guard)` or `bazhen(signal-guard)` in `source`, by line. */
function reports(source: string): { line: number; message: string; rule: string }[] {
  const file = join(dir, "fixture.ts");
  writeFileSync(file, source);
  let out = "";
  try {
    execFileSync(
      join(repo, "node_modules/.bin/oxlint"),
      ["-c", join(repo, ".oxlintrc.json"), "-f", "unix", file],
      {
        cwd: repo,
        encoding: "utf8",
      },
    );
  } catch (error) {
    out = String(Reflect.get(Object(error), "stdout"));
  }
  return [
    ...out.matchAll(/fixture\.ts:(\d+):\d+: (.*) \[\w+\/bazhen\(((?:host|signal)-guard)\)\]/g),
  ].map((m) => ({ line: Number(m[1]), message: m[2] ?? "", rule: m[3] ?? "" }));
}

/** The lines oxlint reports under `bazhen(host-guard)` or `bazhen(signal-guard)` in `source`. */
const flagged = (source: string) =>
  reports(source)
    .map((r) => r.line)
    .toSorted((a, b) => a - b);

/** Each line reported in `source`, with whether every report on it is host-guard's unfollowed start. */
const unfollowed = (source: string) => {
  const lines = new Map<number, boolean>();
  for (const { line, message, rule } of reports(source)) {
    const start = rule === "host-guard" && /can read whether it runs tmux/.test(message);
    lines.set(line, (lines.get(line) ?? true) && start);
  }
  return [...lines].toSorted(([a], [b]) => a - b);
};

/** The 1-based lines of `source` from `first` to `first + count - 1`. */
const lines = (first: number, count: number) => Array.from({ length: count }, (_, i) => first + i);

const FIXTURE = [
  'import { execFileSync, execSync, spawn } from "node:child_process";',
  'import { spawn as launch, execFile } from "node:child_process";',
  'import * as cp from "node:child_process";',
  'import { kill } from "node:process";',
  'import { promisify } from "node:util";',
  "declare const pty: { spawn(argv: string[]): void };",
  "declare const z: { literal(v: string): unknown };",
  "declare const describe: (name: string) => void;",
  "const run = promisify(execFile);",
  'const bin = "tmux";',
  'const argv = ["/usr/bin/tmux", "kill-server"];',
  'execFileSync("tmux", ["-L", "default", "kill-server"]);',
  'pty.spawn(["tmux", "attach-session"]);',
  'void run("tmux", ["list-sessions"]);',
  "execSync(`tmux kill-server`);",
  'spawn("tmux -L default kill-server");',
  'process.kill(-1, "SIGKILL");',
  'process["kill"](1, "SIGTERM");',
  'launch("tmux", []);',
  'execFileSync("/usr/bin/tmux", ["kill-server"]);',
  'execFileSync("sh", ["-c", "tmux kill-server"]);',
  'execFileSync("env", ["tmux", "kill-server"]);',
  'execFileSync(bin, ["kill-server"]);',
  'spawn(argv[0] ?? "", []); execFileSync("x", argv);',
  'execFileSync.call(null, "tmux", ["kill-server"]);',
  'cp.execFileSync("tmux", ["kill-server"]);',
  'globalThis.process.kill(1, "SIGTERM");',
  "const { kill: stop } = process;",
  'execFileSync("git", ["status"]);',
  'execFileSync("tmuxinator", []);',
  'z.literal("tmux");',
  'describe("tmux runtime on a private server");',
  "void new Error(`tmux ${bin} failed`);",
  "void [kill, stop];",
  "declare const linuxNotifier: (binary: string) => void;",
  'linuxNotifier("/usr/bin/tmux");',
  'linuxNotifier("/usr/bin/notify-send");',
  "declare const spawnGroup: (command: string, args: string[]) => void;",
  'spawnGroup("tmux", ["kill-server"]);',
  'import proc from "node:process";',
  'import * as nproc from "node:process";',
  'proc.kill(-1, "SIGKILL");',
  'nproc.kill(1, "SIGTERM");',
  "process.abort();",
  'proc["abort"]();',
  "const { abort } = process;",
  'import { abort as die } from "node:process";',
  "const controller = new AbortController(); controller.abort(); void [abort, die];",
  "process._kill(1, 9);",
  'export { kill as end } from "node:process";',
  'export { readFileSync } from "node:fs";',
].join("\n");

describe("the host-guard lint rule", () => {
  it("flags every tmux command and signal outside host-guard, a notifier or a process group pointed at tmux included, and nothing that only names tmux", () => {
    expect(flagged(FIXTURE)).toEqual([
      4, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 36, 39, 42, 43, 44, 45,
      46, 47, 49, 50,
    ]);
  });
});

const IMPORTS = [
  'import { execFile, execFileSync, spawn } from "node:child_process";',
  'import * as cp from "node:child_process";',
  'import cpd, { fork } from "child_process";',
  'import { default as cpx } from "node:child_process";',
  'import type * as cpt from "node:child_process";',
  'import type { spawn as typedSpawn } from "node:child_process";',
  'import { type spawn as inlineTyped } from "node:child_process";',
  'import { spawnGroup, runBounded, TmuxServer } from "@bazhen/host-guard";',
  'import * as hg from "@bazhen/host-guard";',
  'import { runIn } from "../packages/host-guard/src/index.ts";',
  'import { runOwned } from "@bazhen/host-guard/cap";',
  'import { promisify } from "node:util";',
  'import util from "node:util";',
  'import { createRequire } from "node:module";',
  'import type { ChildProcess } from "node:child_process";',
  "declare const require: (id: string) => unknown;",
  "declare const module: { require(id: string): unknown };",
];

/** Each a start, or child_process or host-guard, reached where the rule can't read its argv. */
const UNFOLLOWED = [
  'Reflect.apply(execFile, null, ["tmux", ["kill-server"]]);',
  'void promisify(execFile)("tmux", ["kill-server"]);',
  "export const seams = { spawn };",
  "export const renamed = { run: spawnGroup };",
  "export const relative = [runIn];",
  "export const exportedRun = promisify(execFile);",
  "export const exportedAlias = spawn;",
  "const alias = execFileSync; export const passed = [alias];",
  "export const whole = cp;",
  'export const computed = cp["execFile"];',
  "export const uncalled = cp.spawn;",
  "export const { execSync } = cp;",
  "export const bound = hg.spawnGroup.bind(null);",
  "export const defaulted = [cpd];",
  "export const renamedDefault = [cpx];",
  "export const nested = cpd.default;",
  'export const dynamic = (name: "spawn") => cp[name];',
  "export const subpath = [runOwned];",
  "export const applied = (argv: string[]) => runBounded.apply(null, argv);",
  "export const appliedSpread = (argv: string[]) => execFile.apply(null, [...argv]);",
  "export const spread = (argv: [string]) => spawnGroup(...argv);",
  "export const spreadCall = (argv: [string]) => execFile.call(null, ...argv);",
  "export const spreadMember = (argv: [string]) => cp.execFile(...argv);",
  "export const spreadGuard = (argv: [string]) => hg.spawnGroup(...argv);",
  "import qualified = cp.execFile;",
  "export { fork };",
  "export default runBounded;",
  'require("child_process");',
  'module.require("node:child_process");',
  'createRequire(import.meta.url)("node:child_process");',
  'const req = createRequire(import.meta.url); req("node:child_process");',
  'const r = require; r("child_process");',
  'const r2 = req; r2("child_process");',
  'process.getBuiltinModule("node:child_process");',
  'void import("node:child_process");',
  'const cpName = "node:child_process"; void import(cpName);',
  'export { spawn as launch } from "child_process";',
  'export { spawnGroup as group } from "@bazhen/host-guard";',
  'export * from "node:child_process";',
  'export * as everything from "@bazhen/host-guard";',
  'import cpr = require("node:child_process");',
];

/** Each a start called where the rule reads its argv, or a mention that starts nothing. */
const FOLLOWED = [
  'execFile("git", []);',
  'spawn<string>("git", []);',
  'cp?.spawn("git", []);',
  'execFileSync.call(null, "git", []);',
  'cp.execFile.apply(null, ["git", []]);',
  "type Start = typeof spawn; type Options = cp.SpawnOptions; type Module = typeof cp;",
  'const runner = promisify(execFile); void runner("git", []);',
  'const ef = execFile; ef("git", []);',
  "const keyed = { spawn: 1 }; void keyed.spawn;",
  "export function shadow(spawn: () => void) { return spawn; }",
  'void new TmuxServer("/x"); void new hg.TmuxServer("/x");',
  'spawnGroup("git", []); hg.runBounded("git"); runIn("git");',
  'void cpd.spawn("git"); void fork("x"); void cpr;',
  'export const named = ["child_process", "node:child_process"].includes("node:child_process");',
  'require("node:fs"); void import("node:fs");',
  'export { TmuxServer } from "@bazhen/host-guard";',
  'export type { ChildProcess as Child } from "node:child_process";',
  "export const child: ChildProcess | null = null;",
  "export type Spawned = ReturnType<typeof cpt.spawn>;",
  "export type { typedSpawn, inlineTyped };",
  'export { type spawn as InlineSpawnType } from "node:child_process";',
  'export type { spawn as SpawnType } from "node:child_process";',
  'export type * from "node:child_process";',
  'import type cpTyped = require("node:child_process");',
  "export type Typed = typeof cpTyped;",
  'export const isStart = typeof spawn === "function" && typeof cp === "object";',
  'runBounded.apply(null, ["git"]);',
  "declare const statement: { run(...values: unknown[]): void }; statement.run(...[1, 2]);",
  'const viaUtil = util.promisify(execFile); void viaUtil("git", []);',
];

describe("the host-guard rule's reach", () => {
  it("flags every start or module reached other than by a call it reads, and nothing it can follow", () => {
    const first = IMPORTS.length + 1;
    expect(unfollowed([...IMPORTS, ...UNFOLLOWED, ...FOLLOWED].join("\n"))).toEqual(
      lines(first, UNFOLLOWED.length).map((line) => [line, true]),
    );
  });

  it("reads a start's argv wherever its alias, constant or namespace is declared", () => {
    expect(
      flagged(
        [
          'import { execFile } from "node:child_process";',
          'import { default as cpx } from "node:child_process";',
          'import util from "node:util";',
          'import { runBounded as rb } from "@bazhen/host-guard";',
          'export function early() { lateAlias("tmux", []); execFile(lateBin, []); }',
          'export function chained() { lastAlias("tmux", []); }',
          "const lastAlias = lateAlias;",
          'cpx.execFileSync("tmux", ["kill-server"]);',
          "const lateAlias = execFile;",
          'const lateBin = "tmux";',
          'const viaUtil = util.promisify(execFile); void viaUtil("tmux", []);',
          'rb("tmux", ["kill-server"]);',
        ].join("\n"),
      ),
    ).toEqual([5, 5, 6, 8, 11, 12]);
  });
});
