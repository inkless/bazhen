import { describe, expect, it } from "vitest";
import {
  allowedSignalFailures,
  chokepointReaches,
  isSignallingSource,
  isSignallingTest,
  rawSignalCalls,
} from "./signal-paths.ts";

const calls = (file: string, text: string) => rawSignalCalls(file, text).map((c) => c.call);

describe("raw signal calls in Rust", () => {
  it("finds each way of sending one, imports and aliases included", () => {
    const source = [
      "use rustix::process::{kill_process as k, kill_process_group};",
      "rustix::process::kill_current_process_group(Signal::KILL);",
      "rustix::process::pidfd_send_signal(&fd, Signal::KILL);",
      "unsafe { libc::kill(pid, libc::SIGKILL) };",
      "unsafe { libc::killpg(pgid, libc::SIGKILL) };",
      "nix::sys::signal::kill(pid, None);",
      "unsafe { libc::tgkill(tgid, tid, libc::SIGKILL) };",
      "unsafe { libc::syscall(libc::SYS_tkill, tid, 9) };",
      "unsafe { nix::libc::r#kill(pid, 9) };",
    ].join("\n");
    expect(calls("a.rs", source)).toEqual([
      "kill_process",
      "kill_process_group",
      "kill_current_process_group",
      "pidfd_send_signal",
      "libc::kill",
      "killpg",
      "signal::kill",
      "tgkill",
      "SYS_tkill",
      "libc::r#kill",
    ]);
  });

  it("finds an import of a kill, a glob or a rename from libc or a signal module, however nested", () => {
    const source = [
      "use libc::*;",
      "use std::io::*;",
      "use nix::{sys::signal::{kill, Signal}, unistd::Pid};",
      "use nix::unistd::*;",
      "use nix::sys::{signal::*, wait::*};",
      "use rustix::process as p;",
      "use nix::{sys::signal::*};",
      "use libc_print::*;",
      "use nix::{",
      "    sys::{signal::{self as s}, wait},",
      "};",
      "use libc::{c_int, pid_t};",
      "use nix::libc as c;",
      "use nix::sys::signal::{Signal, SigSet};",
      "use nix::libc::*;",
      "use tokio::signal::unix::{signal, SignalKind};",
      "use crate::a::signal::*;",
      "use nix::sys::{signal::{r#kill}};",
      "extern crate libc as c2;",
      "use tokio::signal as ts;",
    ].join("\n");
    expect(rawSignalCalls("a.rs", source).map((c) => c.line)).toEqual([
      1, 3, 5, 7, 9, 13, 15, 17, 18, 19, 20,
    ]);
  });

  it("finds a re-export of libc or a signal module, which another file could import from", () => {
    const source = [
      "pub use nix::sys::signal;",
      "pub(crate) use libc;",
      "pub(in crate::a) use nix::sys::signal::Signal;",
      "pub use std::io;",
      "use nix::sys::signal;",
    ].join("\n");
    expect(rawSignalCalls("a.rs", source).map((c) => c.line)).toEqual([1, 2, 3]);
  });

  it("gives the line each is on", () => {
    expect(rawSignalCalls("a.rs", "fn f() {}\n\nkill_process(p, s);")).toEqual([
      { line: 3, call: "kill_process" },
    ]);
  });

  it("ignores one in a comment or a string, and the signal-0 probe", () => {
    const source = [
      "// kill_process(pid, Signal::KILL)",
      "/* libc::kill(-1, 9) */",
      'let s = "kill_process_group(pid)";',
      'let r = r#"libc::killpg(1, 9)"#;',
      "test_kill_process(pid).is_ok();",
      "child.kill();",
    ].join("\n");
    expect(calls("a.rs", source)).toEqual([]);
  });
});

describe("chokepointReaches", () => {
  it("finds each glob use and each kill named other than as a method, by line", () => {
    const source = [
      "use super::*;",
      "use crate::{a::{b, *}, c};",
      "use std::process::Command;",
      "kill(p, 9);",
      "super::kill(p, 9);",
      "let k = r#kill;",
      "child.kill();",
      "child . r#kill();",
      "// kill(p, 9)",
      '"kill(p, 9)";',
      "let killed = kill_switch;",
      "test_kill_process(p);",
      "Signal::KILL;",
    ].join("\n");
    expect(chokepointReaches(source)).toEqual([
      { line: 1, call: "use super::*" },
      { line: 2, call: "use crate::{a::{b, *}, c}" },
      { line: 4, call: "a bare `kill`" },
      { line: 5, call: "a bare `kill`" },
      { line: 6, call: "a bare `kill`" },
    ]);
  });
});

describe("raw signal calls in TypeScript", () => {
  it("finds process.kill however it is reached", () => {
    const source = [
      "process.kill(pid, 'SIGKILL');",
      "globalThis.process.kill(1);",
      "process?.kill(2);",
      "const { kill } = process;",
      'import { kill as k } from "node:process";',
    ].join("\n");
    expect(calls("a.ts", source)).toHaveLength(5);
  });

  it("ignores one in a comment, a string or a template, but not a child's kill beside them", () => {
    const source = [
      "// process.kill(-1)",
      "/* process.kill(-1) */",
      "const a = 'process.kill(-1, \"SIGKILL\");';",
      "const b = `process.kill(${pid})`;",
      "// child.kill('SIGTERM')",
      "const c = 'pty.kill()'; child.kill();",
    ].join("\n");
    expect(calls("a.ts", source)).toEqual(["child.kill"]);
  });

  it("reads a template's substitutions as code, nested ones included", () => {
    const source = [
      'const a = `${child.kill("SIGKILL")}`;',
      "const b = `x ${`y ${proc.kill()}`} z`;",
      "const c = `${{ timeout: 1 }.timeout} ${spawn(cmd, [], { timeout: 1 })}`;",
      "const d = `${'}'}`; process.kill(pid);",
      "const e = `${ { a: 1 }.a + child.kill() }`;",
    ].join("\n");
    expect(rawSignalCalls("a.ts", source).map((c) => c.line)).toEqual([1, 2, 3, 4, 5]);
  });

  it("reads past a regular expression holding a quote, and not a division as one", () => {
    const source = [
      'const re = /"/; child.kill();',
      "const re2 = /'[/']/g.test(s); process.kill(pid);",
      "const r = total / count; child.kill(); const s = x / y;",
      "const q = (a) / 2; process.abort(); const w = arr[0] / 3;",
      "if (ok) return /'/.test(s); child.kill();",
    ].join("\n");
    expect(rawSignalCalls("a.ts", source).map((c) => c.line)).toEqual([1, 2, 3, 4, 5]);
    expect(calls("a.ts", 'const re = /process.kill("x")/; const s = "child.kill()";')).toEqual([]);
  });

  it("reads a / after a postfix !, ++ or --, or a member named like a keyword, as division", () => {
    const source = [
      "const a = n! / 2; child.kill(); const b = m / 3;",
      "const c = i++ / 2; child.kill(); const d = m / 3;",
      "const e = i-- / 2; child.kill(); const f = m / 3;",
      "const g = list[0]!! / 2; child.kill(); const h = m / 3;",
      "const k = x.in / 2; child.kill(); const l = m / 3;",
      "const o = map ?. delete / 2; child.kill(); const q = m / 3;",
    ].join("\n");
    expect(rawSignalCalls("a.ts", source).map((c) => c.line)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("tells a regular expression after a prefix !, a lone + or - or a keyword from a division after a postfix one", () => {
    const source = [
      "if (!/'/.test(s)) child.kill();",
      "return !/'/.test(s) && child.kill();",
      "const a = b + +/'/.source; child.kill();",
      "const c = -/'/.lastIndex; child.kill();",
      "const d = i++ + /'/.source; child.kill();",
      "const e = typeof /'/; child.kill();",
      "if (!/'/.test(s)) n = i++ / 2; child.kill(); m = j / 3;",
    ].join("\n");
    expect(rawSignalCalls("a.ts", source).map((c) => c.line)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(calls("a.ts", "const a = !/process.kill(1)/.test(s);")).toEqual([]);
  });

  it("ends a quote at its line, so an apostrophe in JSX text hides no code", () => {
    const source = [
      "const a = <p>Don't stop</p>; child.kill();",
      "child.kill();",
      "const b = <p>it's here, and 'quoted'</p>; child.kill();",
      "const c = <p>' opens</p>; child.kill();",
      'const d = <p>" opens</p>; child.kill();',
      "const e = 'x';",
    ].join("\n");
    expect(rawSignalCalls("a.tsx", source).map((c) => c.line)).toEqual([1, 2, 3, 4, 5]);
  });

  it("reads a quote closed on its line, or continued past it, as a string, and one left open as code", () => {
    const source = [
      'const a = "it\'s child.kill()"; child.kill();',
      "const b = 'say \"child.kill()\"'; child.kill();",
      "const c = 'one \\",
      "child.kill()'; child.kill();",
      "const d = 'one \\\r\nchild.kill()'; child.kill();",
      "const e = '\\'child.kill()'; child.kill();",
      "const f = 'open; child.kill();",
    ].join("\n");
    expect(rawSignalCalls("a.ts", source).map((c) => c.line)).toEqual([1, 2, 4, 6, 7, 8]);
  });

  it("finds process._kill, and a re-export of process's kill", () => {
    const source = [
      "process._kill(pid, 9);",
      'export { kill } from "node:process";',
      'export { abort as die } from "process";',
      'export { kill } from "./mine.ts";',
    ].join("\n");
    expect(rawSignalCalls("a.ts", source).map((c) => c.line)).toEqual([1, 2, 3]);
  });

  it("finds process re-exported whole, or exported under a name of this file's", () => {
    const source = [
      'export * from "node:process";',
      'export * as nsp from "process";',
      'export { default } from "node:process";',
      'export { pid, default as dp } from "process";',
      "export const p3 = process;",
      "export let p4 = globalThis.process;",
      "const p5 = process;",
      "export { p5 };",
      "export { p5 as p6, other };",
      "export default process;",
      "export = globalThis.process;",
      "export default p5;",
      'export * from "./mine.ts";',
      'export type * from "node:process";',
      'export { pid as id } from "node:process";',
      "export const p7 = process.pid;",
      "export default process.env;",
      "export { other };",
    ].join("\n");
    expect(rawSignalCalls("a.ts", source).map((c) => c.line)).toEqual([
      1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12,
    ]);
  });

  it("reads process imported by the name default, or beside named imports, as an alias", () => {
    const source = [
      'import { default as p1 } from "node:process";',
      'import p2, { pid } from "process";',
      'import p3, * as p4 from "node:process";',
      "p1.abort();",
      "p2._kill(1, 9);",
      "p3.abort();",
      'p4["abort"]();',
      "const p5 = p1;",
      "p5.abort();",
      "pid.abort;",
    ].join("\n");
    expect(rawSignalCalls("a.ts", source).map((c) => c.line)).toEqual([4, 5, 6, 7, 9]);
  });

  it("finds process.abort however it is reached", () => {
    const source = [
      "process.abort();",
      "globalThis.process?.abort();",
      'process["abort"]();',
      "const { abort } = process;",
      'import { abort } from "node:process";',
      'import proc from "node:process";',
      "proc.abort();",
    ].join("\n");
    expect(rawSignalCalls("a.ts", source).map((c) => c.line)).toEqual([1, 2, 3, 4, 5, 7]);
  });

  it("finds a kill on any object, since text can't tell a child's from another's", () => {
    const source = [
      "child.kill('SIGTERM');",
      "this.child?.kill();",
      "spawn(cmd).kill();",
      'pty["kill"]("SIGHUP");',
      "handles[0]?.['kill']();",
      "const { kill } = child;",
      "({ pid, kill: stop } = proc);",
      "const k = child.kill.bind(child);",
      "child . kill ();",
    ].join("\n");
    expect(rawSignalCalls("a.ts", source).map((c) => c.line)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("counts process.kill once, not again as a member named kill, as it does a child's", () => {
    expect(
      calls("a.ts", "process.kill(pid);\nglobalThis.process?.kill(1);\nchild.kill();"),
    ).toEqual(["process.kill", "process?.kill", "child.kill"]);
  });

  it("ignores what only names kill: a definition, a key, a function, a longer name", () => {
    const source = [
      "class Fake { kill(signal) { return true; } }",
      "const pty = { kill: () => undefined };",
      "interface OwnChild { kill(signal?: NodeJS.Signals): boolean }",
      "kill(proof);",
      "if (child.killed) done();",
      "server.killServer();",
      "const names = ['kill'];",
      "return ['kill'];",
      "child.kill();",
    ].join("\n");
    expect(rawSignalCalls("a.ts", source).map((c) => c.line)).toEqual([9]);
  });

  it("reads no other kind of file", () => {
    expect(calls("README.md", "process.kill(-1)")).toEqual([]);
  });
});

describe("kills Node sends for a process start's options", () => {
  it("finds a timeout, killSignal or signal passed to each child_process start", () => {
    const heads = [
      ...["spawn", "spawnSync", "execFile", "execFileSync", "fork"].map((s) => `${s}(cmd, args,`),
      ...["exec", "execSync"].map((s) => `${s}(cmd,`),
    ];
    const starts = heads.flatMap((head) => [
      `${head} { timeout: 1_000 });`,
      `${head} { env, killSignal: "SIGKILL" });`,
      `${head} { stdio: "ignore", signal: abort.signal });`,
    ]);
    expect(starts.filter((source) => calls("a.ts", source).length !== 1)).toEqual([]);
  });

  it("names the option and the start", () => {
    expect(calls("a.ts", "execFile(file, args, { env, timeout }, (error, stdout) => {});")).toEqual(
      ["timeout option of execFile"],
    );
  });

  it("finds one through a promisify, an import alias or a child_process namespace", () => {
    const source = [
      'import { execFile as ef, spawn } from "node:child_process";',
      'import * as cp from "child_process";',
      'import childProcess from "node:child_process";',
      "const run = promisify(execFile);",
      "const go = util.promisify(cp.exec);",
      'await run("ps", args, { timeout: TIMEOUT_MS });',
      'await go("ls", { timeout: 1 });',
      "ef(cmd, [], { timeout: 1 });",
      "cp.spawnSync(cmd, [], { timeout: 1 });",
      "childProcess.fork(mod, [], { signal });",
    ].join("\n");
    expect(rawSignalCalls("a.ts", source).map((c) => c.line)).toEqual([6, 7, 8, 9, 10]);
  });

  it("finds a killSignal anywhere, as nothing else uses that name", () => {
    expect(calls("a.ts", 'const opts = { killSignal: "SIGKILL" };')).toEqual(["killSignal"]);
  });

  it("ignores the same keys anywhere but a child_process start's arguments", () => {
    const source = [
      "await expect.poll(() => seen, { timeout: 2_000 }).toBe(true);",
      "await vi.waitFor(check, { timeout: 2_000 });",
      'describe("hook client", { timeout: 30_000 }, () => {});',
      "/x/.exec(text, { timeout: 1 });",
      "pattern.exec(text);",
      "await client.close({ signal: AbortSignal.timeout(closeMs) });",
      'server.run(["list-sessions"], { timeout: 500 });',
      "const run = (event, timeout) => ({ type: 'command', timeout });",
      'run("wait", 86_400);',
      'execFile("ps", ["-A"], (error, signal) => done(signal));',
      "execFile(cmd, [], { env: limits.timeout, cwd: opts.signal }, done);",
      'const s = "spawn(cmd, [], { timeout: 1 })";',
      "// execFile(cmd, [], { timeout: 1 })",
      "await once(ws, 'open', { signal: AbortSignal.timeout(1) });",
      "execFile(cmd, [], { timeout: 1 });",
    ].join("\n");
    expect(calls("a.ts", source)).toEqual(["timeout option of execFile"]);
  });

  it("reads a start's arguments to its own closing paren, past parens in strings", () => {
    const source = [
      'execFile("sh", ["-c", "echo )"], { env });',
      "const later = { timeout: 1 };",
      "spawn(cmd, [f(x), g(y)],",
      "  { timeout: 1 });",
    ].join("\n");
    expect(rawSignalCalls("a.ts", source).map((c) => c.line)).toEqual([4]);
  });

  it("finds a timeout set by a getter or a method", () => {
    expect(calls("a.ts", "spawn(cmd, args, { get timeout() { return 1; } });")).toEqual([
      "timeout option of spawn",
    ]);
  });
});

const unread = (start: string) => `options of ${start} not written inline`;
const unreadAt = (line: number, start: string) => ({ line, call: unread(start), unread: true });

describe("a start's options the scan can't read", () => {
  it("finds options passed through a constant, which could hold a timeout", () => {
    const source = ["const OPTS = { timeout: 5_000 };", "execFileSync(cmd, args, OPTS);"];
    expect(rawSignalCalls("a.ts", source.join("\n"))).toEqual([unreadAt(2, "execFileSync")]);
  });

  it("finds them at the options slot of each start, however the start is named", () => {
    const flagged: [string, string][] = [
      ["spawn(cmd, args, opts);", "spawn"],
      ["spawnSync(cmd, args, opts);", "spawnSync"],
      ["execFile(cmd, args, opts, done);", "execFile"],
      ["execFileSync(cmd, args, opts);", "execFileSync"],
      ["fork(mod, args, opts);", "fork"],
      ["exec(cmd, opts, done);", "exec"],
      ["execSync(cmd, opts);", "execSync"],
      ['import { execFile as ef } from "node:child_process";\nef(cmd, [], opts);', "execFile"],
      ['import * as cp from "child_process";\ncp.spawn(cmd, args, opts);', "spawn"],
      ['const run = promisify(execFile);\nawait run("ps", ps, options);', "execFile"],
    ];
    expect(flagged.map(([source]) => calls("a.ts", source))).toEqual(
      flagged.map(([, start]) => [unread(start)]),
    );
  });

  it("finds a second argument that may be the options, as Node reads any that isn't an array", () => {
    const flagged = [
      "spawn(cmd, args);",
      "spawnSync(cmd, opts);",
      "execFile(cmd, opts, (error, stdout) => {});",
      "execFile(cmd, opts, function (error) {});",
      "fork(mod, opts);",
    ];
    expect(flagged.map((source) => calls("a.ts", source))).toEqual(
      flagged.map((source) => [unread(source.slice(0, source.indexOf("(")))]),
    );
  });

  it("finds a second argument that may be the options, before a callback of undefined or null", () => {
    expect(calls("a.ts", "execFile(file, opts, undefined);\nexecFile(file, opts, null);")).toEqual([
      unread("execFile"),
      unread("execFile"),
    ]);
  });

  it("finds arguments spread from a value at or before the options, which may hold them", () => {
    const source = [
      "spawn(...a);",
      "execFile(...callArgs, done);",
      "execSync(...x);",
      "spawn(cmd, ...rest);",
      "execFile(cmd, args, ...rest);",
      "exec(cmd, ...rest);",
      "execFile(cmd, [], {}, ...callbacks);",
      "exec(cmd, {}, ...callbacks);",
      "spawn(cmd, [...args], {});",
    ].join("\n");
    expect(rawSignalCalls("a.ts", source)).toEqual([
      unreadAt(1, "spawn"),
      unreadAt(2, "execFile"),
      unreadAt(3, "execSync"),
      unreadAt(4, "spawn"),
      unreadAt(5, "execFile"),
      unreadAt(6, "exec"),
    ]);
  });

  it("finds a key it can't read as a name: computed or quoted, a getter's or a method's too", () => {
    const source = [
      "spawn(cmd, args, {",
      "  get [K]() { return 1; },",
      "  async [k]() {},",
      "  *[k]() {},",
      "  async *[k]() {},",
      '  "timeout": 5,',
      '  get "timeout"() { return 1; },',
      "  'killSignal': \"SIGKILL\",",
      "  [`signal`]: s,",
      '  stdio: "inherit",',
      "  getStdio: 1,",
      "});",
    ].join("\n");
    expect(rawSignalCalls("a.ts", source).map((c) => c.line)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("finds a callback in a variable, which text can't tell from the options", () => {
    expect(calls("a.ts", "execFile(cmd, args, done);")).toEqual([unread("execFile")]);
  });

  it("finds any expression that isn't a literal object", () => {
    const flagged = [
      "spawn(cmd, args, this.options);",
      "spawn(cmd, args, options());",
      "spawn(cmd, args, quiet ? QUIET : LOUD);",
      'spawn(cmd, args, { stdio: "inherit" } as SpawnOptions);',
      "spawn(cmd, args, Object.assign({}, base));",
      "spawn(cmd, args, `${opts}`);",
      "spawn(cmd, args, [opts][0]);",
      "spawn(cmd, args, x ? opts : () => undefined);",
      "const child = ok ? spawn(cmd, args, opts) : null;",
    ];
    expect(flagged.map((source) => calls("a.ts", source))).toEqual(
      flagged.map(() => [unread("spawn")]),
    );
  });

  it("finds a spread or a computed key in a literal object, each where it is", () => {
    const source = [
      "spawn(cmd, args, {",
      "  ...base,",
      '  stdio: "inherit",',
      "  [key]: value,",
      "});",
    ].join("\n");
    expect(rawSignalCalls("a.ts", source)).toEqual([unreadAt(2, "spawn"), unreadAt(4, "spawn")]);
  });

  it("reads literals, and a spread inside an option's own value, and finds only the rest", () => {
    const source = [
      'spawn(cmd, args, { env: { ...process.env, A: "1" }, stdio: ["pipe", log, log] });',
      "spawn(cmd, [...args, file]);",
      'spawn("sh", ["-c", line], {});',
      "spawnSync(cmd, [], undefined);",
      "spawnSync(cmd, [], null);",
      "execFile(cmd, [], { env }, done);",
      'execFile("ps", ["-A"], (error, stdout) => done(stdout));',
      'execFile("ps", ["-A"], function (error, stdout) {});',
      'execFile("ps", ["-A"], async (error): Promise<void> => {});',
      "exec(cmd, (error) => done(error));",
      "exec(cmd, { cwd }, async function (error) {});",
      'execSync("true");',
      'spawnSync("pnpm", installArgs(mode), { stdio: "inherit" });',
      "pattern.exec(text, opts);",
      "server.run(args, opts);",
      "spawn(cmd, args, opts);",
    ].join("\n");
    expect(rawSignalCalls("a.ts", source)).toEqual([unreadAt(16, "spawn")]);
  });

  it("skips a declaration named for a start, whose parameters are no options, not a call", () => {
    const source = [
      "const run = promisify(execFile);",
      "const spawner = {",
      "  spawn(argv, size, env): PtyProcess {",
      "    return proc;",
      "  },",
      "  fork(a, b, c) {",
      "    return a;",
      "  },",
      "};",
      "interface PtySpawner {",
      "  spawn(",
      "    argv: readonly [string, ...string[]],",
      "    size: Size,",
      "    env: Readonly<Record<string, string>>,",
      "  ): PtyProcess;",
      "  exec(command: string, options: Options): void;",
      "}",
      "class Server {",
      "  private async spawn(file, args, opts): Promise<void> {}",
      "  run(args: readonly string[], opts: TmuxOptions = {}): Promise<string> {",
      "    return run(bin, args, { timeout: 1 });",
      "  }",
      "  static execSync(cmd, opts) {}",
      "  *spawnSync(cmd, args, opts) {}",
      "}",
      "function execFile(file, args, opts) {}",
      "export async function execFileSync(file, args, opts): Promise<void> {}",
      "execFileSync(file, args, opts);",
    ].join("\n");
    expect(rawSignalCalls("a.ts", source)).toEqual([
      { line: 21, call: "timeout option of execFile" },
      unreadAt(28, "execFileSync"),
    ]);
  });

  it("names options it can't read at a start whose timeout is allowed", () => {
    const base = "scripts/falsify-base.ts";
    const call = [
      'spawnSync("pnpm", installArgs(mode), {',
      "  ...extra,",
      "  timeout: INSTALL_TIMEOUT_MS,",
      "});",
    ].join("\n");
    expect(rawSignalCalls(base, call)).toEqual([unreadAt(2, "spawnSync")]);
  });
});

const unfollowed = (line: number, start: string) => ({
  line,
  call: `${start} used other than in a call`,
  unfollowed: true,
});
const loaded = (line: number) => ({
  line,
  call: "child_process named outside an import",
  unfollowed: true,
});

describe("starts the scan can't follow to a call", () => {
  const imports = [
    'import { execFile, spawn as sp } from "node:child_process";',
    'import cp, { fork } from "child_process";',
    'import * as ns from "node:child_process";',
    'import { promisify } from "node:util";',
    "const run = promisify(execFile);",
  ];
  const at = (lines: string[]) => rawSignalCalls("a.ts", [...imports, ...lines].join("\n"));

  it("finds a start imported by name, used as anything but a call", () => {
    expect(
      at([
        'execFile.call(null, "ls", [], { timeout: 1 });',
        'execFile.apply(null, ["ls", [], { timeout: 1 }]);',
        'Reflect.apply(sp, null, ["ls"]);',
        "const ef = execFile;",
        "const seams = { spawn: sp };",
        "const more = { fork };",
        'promisify(execFile)("ls", [], { timeout: 1 });',
        "const again = run;",
        "execFile`ls`;",
        "export default sp;",
        "export { fork };",
      ]),
    ).toEqual([
      unfollowed(6, "execFile"),
      unfollowed(7, "execFile"),
      unfollowed(8, "sp (spawn)"),
      unfollowed(9, "execFile"),
      unfollowed(10, "sp (spawn)"),
      unfollowed(11, "fork"),
      unfollowed(12, "execFile"),
      unfollowed(13, "run (execFile)"),
      unfollowed(14, "execFile"),
      unfollowed(15, "sp (spawn)"),
      unfollowed(16, "fork"),
    ]);
  });

  it("finds child_process imported whole, used as anything but a call of a member", () => {
    expect(
      at([
        "const c = cp;",
        'ns["spawn"]("ls", [], { timeout: 1 });',
        "const s = ns.spawn;",
        'cp.execFile.call(null, "ls");',
        "const { exec } = ns;",
        "const seams = { ...cp };",
        "const starts = [...[sp]];",
        "ns.default.execFile(cmd, [], { timeout: 1 });",
      ]),
    ).toEqual([
      unfollowed(6, "cp"),
      unfollowed(7, "ns"),
      unfollowed(8, "ns.spawn"),
      unfollowed(9, "cp.execFile"),
      unfollowed(10, "ns"),
      unfollowed(11, "cp"),
      unfollowed(12, "sp (spawn)"),
      unfollowed(13, "ns.default"),
    ]);
  });

  it("finds a promisified start that is exported, as other files call it unread", () => {
    const source = [
      'import { execFile } from "node:child_process";',
      'import * as cp from "node:child_process";',
      "export const run = promisify(execFile);",
      "export let go = util.promisify(cp.execFile);",
      "export var ex = promisify(execFile);",
      'run("ps", [], { timeout: 1 });',
    ].join("\n");
    expect(rawSignalCalls("a.ts", source).map((c) => [c.line, c.call])).toEqual([
      [3, "run (execFile) used other than in a call"],
      [4, "go (execFile) used other than in a call"],
      [5, "ex (execFile) used other than in a call"],
      [6, "timeout option of execFile"],
    ]);
  });

  it("reads child_process imported by the name default as imported whole", () => {
    const source = [
      'import { default as cp } from "node:child_process";',
      'import { "default" as qp, spawn } from "child_process";',
      "cp.execFile(cmd, [], { timeout: 1 });",
      "qp.spawn(cmd, [], { timeout: 1 });",
      "const c = cp;",
    ].join("\n");
    expect(rawSignalCalls("a.ts", source).map((c) => [c.line, c.call])).toEqual([
      [3, "timeout option of execFile"],
      [4, "timeout option of spawn"],
      [5, "cp used other than in a call"],
    ]);
  });

  it("reads a member's, a field's or a key's name as no mention, but a shorthand key as one", () => {
    expect(
      at([
        "interface Seams {",
        "  readonly env: E;",
        "  readonly execFile?: typeof execFile;",
        "  fork: Fork",
        "  run(file: string): Promise<void>;",
        "}",
        "class Real {",
        "  private execFile: typeof execFile;",
        "  public sp!: Sp;",
        "  declare readonly fork?: Fork;",
        "  accessor execFile: Run;",
        "  start() {}",
        "  fork: Fork;",
        "}",
        "function seam(execFile: Run, sp?: Fork) {}",
        "const names = {",
        "  cp: 1,",
        "  ns: 2,",
        "  execFile,",
        "};",
      ]),
    ).toEqual([unfollowed(24, "execFile")]);
  });

  it("finds a start chosen by a conditional, or compared by a case, though a : follows it", () => {
    expect(
      at([
        "const f = ok ? execFile : sp;",
        "const g = ok ?",
        "  fork : run;",
        "switch (x) { case execFile: break; }",
        "const h = ok ? a ?? cp : ns;",
        "const i = ok ? useFake && execFile : b;",
        "const j = ok ? () => execFile : b;",
        "const k = ok ? !fork : b;",
        "const l = ok ? <Fn>sp : b;",
        "const m = ok ? x || cp : b;",
      ]),
    ).toEqual([
      unfollowed(6, "execFile"),
      unfollowed(6, "sp (spawn)"),
      unfollowed(8, "fork"),
      unfollowed(8, "run (execFile)"),
      unfollowed(9, "execFile"),
      unfollowed(10, "cp"),
      unfollowed(10, "ns"),
      unfollowed(11, "execFile"),
      unfollowed(12, "execFile"),
      unfollowed(13, "fork"),
      unfollowed(14, "sp (spawn)"),
      unfollowed(15, "cp"),
    ]);
  });

  it("finds a promisify of a start that the scan doesn't bind", () => {
    expect(
      at(["const twice = promisify(run);", 'twice("ls", [], { timeout: 1 });']).map((c) => c.line),
    ).toEqual([6]);
  });

  it("finds child_process loaded, or named, outside an import it reads", () => {
    const source = [
      'const { spawn } = require("child_process");',
      'const m = await import("node:child_process");',
      "const n = await import(`child_process`);",
      'export { exec } from "child_process";',
      'export * from "node:child_process";',
      'createRequire(import.meta.url)("child_process");',
      'import cp = require("node:child_process");',
      "const r = require;",
      'r("child_process").execFile("ls", [], { timeout: 1 });',
    ].join("\n");
    expect(rawSignalCalls("a.ts", source)).toEqual([
      loaded(1),
      loaded(2),
      loaded(3),
      loaded(4),
      loaded(5),
      loaded(6),
      loaded(7),
      loaded(9),
    ]);
  });

  it("reads calls with type arguments or ?., an import beside a default, and import type", () => {
    expect(
      at([
        "sp<ChildProcess>(cmd, [], { timeout: 1 });",
        "sp?.(cmd, [], { timeout: 1 });",
        "run(cmd, [], { timeout: 1 });",
        "ns.spawn(cmd, [], { timeout: 1 });",
        "cp?.spawn(cmd, [], { timeout: 1 });",
        "cp.fork<Message>(mod, [], { timeout: 1 });",
        "fork(mod, [], { timeout: 1 });",
        "type Run = typeof execFile;",
        "type Start = typeof cp.spawn;",
        'import type { ChildProcess } from "node:child_process";',
        'import { type SpawnOptions, execFileSync } from "child_process";',
        'import type * as types from "node:child_process";',
        "const names = { spawn: 1, execFile: 2, fork: 3 };",
        "pty.spawn(argv, size, env);",
        "const kind = cp.ChildProcess;",
        "const text = \"import { spawn } from 'child_process'\";",
        "// const ef = execFile;",
      ]).map((c) => [c.line, c.call]),
    ).toEqual([
      [6, "timeout option of spawn"],
      [7, "timeout option of spawn"],
      [8, "timeout option of execFile"],
      [9, "timeout option of spawn"],
      [10, "timeout option of spawn"],
      [11, "timeout option of fork"],
      [12, "timeout option of fork"],
    ]);
  });

  it("reads a start's options in a call whose result is spread", () => {
    expect(calls("a.ts", "f(...execFileSync(cmd, [], { timeout: 1 }));")).toEqual([
      "timeout option of execFileSync",
    ]);
  });

  it("reads a start's options in a call with type arguments or ?.", () => {
    expect(at(["sp<ChildProcess>(cmd, args, OPTS);", "cp?.spawn(cmd, args, OPTS);"])).toEqual([
      unreadAt(6, "spawn"),
      unreadAt(7, "spawn"),
    ]);
  });

  it("reads a start imported under a quoted name", () => {
    const source = [
      'import { "execFile" as ef } from "node:child_process";',
      "const alias = ef;",
      "ef(cmd, [], { timeout: 1 });",
    ].join("\n");
    expect(rawSignalCalls("a.ts", source).map((c) => [c.line, c.call])).toEqual([
      [2, "ef (execFile) used other than in a call"],
      [3, "timeout option of execFile"],
    ]);
  });

  it("finds a start imported under a name opening with $, called or not", () => {
    const source = [
      'import { spawn as $sp } from "node:child_process";',
      "const alias = $sp;",
      "$sp(cmd, [], { timeout: 1 });",
    ].join("\n");
    expect(rawSignalCalls("a.ts", source).map((c) => [c.line, c.call])).toEqual([
      [2, "$sp (spawn) used other than in a call"],
      [3, "timeout option of spawn"],
    ]);
  });

  it("finds a start imported only as a type, used as a value", () => {
    const source = [
      'import type * as types from "node:child_process";',
      'import type { spawn as sp } from "node:child_process";',
      "const t = types;",
      "const s = sp;",
    ].join("\n");
    expect(rawSignalCalls("a.ts", source).map((c) => c.line)).toEqual([3, 4]);
  });

  it("finds only the starts a file imports, not a start's name it binds to something else", () => {
    const source = [
      'import { execFile } from "node:child_process";',
      "const spawn = makeSpawner();",
      "register(spawn, { fork }, execFile);",
    ].join("\n");
    expect(rawSignalCalls("a.ts", source)).toEqual([unfollowed(3, "execFile")]);
  });

  it("lets the checks' start list name child_process as data where it's allowed, and nowhere else", () => {
    const list = "scripts/child-process.ts";
    const names =
      'export const CHILD_PROCESS_MODULES = ["child_process", "node:child_process"] as const;';
    expect(rawSignalCalls(list, names)).toEqual([]);
    expect(allowedSignalFailures(list, names)).toEqual([]);
    expect(isSignallingSource(list, names)).toBe(false);
    expect(rawSignalCalls(list, `${names}\nconst m = require("child_process");`)).toEqual([
      loaded(2),
    ]);
    expect(rawSignalCalls("a.ts", names)).toEqual([loaded(1), loaded(1)]);
  });

  it("counts an unfollowed start, or child_process loaded, as a signalling source", () => {
    expect(isSignallingSource("a.ts", `${imports[0]}\nconst ef = execFile;`)).toBe(true);
    expect(isSignallingSource("a.ts", 'const cp = require("child_process");')).toBe(true);
    expect(isSignallingSource("a.ts", `${imports[0]}\nexecFile("ls", ["-A"]);`)).toBe(false);
  });
});

describe("kills by a process started to send them", () => {
  it("finds a kill program run directly, by a shell, or through systemctl", () => {
    expect(calls("a.rs", 'Command::new("kill").args(["-TERM", &group]);')).toEqual([
      'a kill by "kill"',
    ]);
    expect(calls("a.ts", 'spawn("/usr/bin/pkill", ["-f", "x"]);')).toEqual([
      'a kill by "/usr/bin/pkill"',
    ]);
    expect(calls("a.ts", 'spawn("sh", ["-c", "sleep 1; kill -TERM -$pid"]);')).toEqual([
      'a kill by "sleep 1; kill -TERM -$pid"',
    ]);
    expect(calls("a.ts", 'spawn("sh", ["-c", "killall node"]);')).toEqual([
      'a kill by "killall node"',
    ]);
    expect(calls("a.ts", 'output("systemctl", ["--user", "kill", unit]);')).toEqual([
      "systemctl kill",
    ]);
  });

  it("lets a shell end itself, its own last job, or a pid in a plain variable, and a word in prose", () => {
    const source = [
      'Command::new("sh").args(["-c", "kill -s TERM $$"]);',
      'let s = r#"sh -c "kill -s $s \\$\\$""#;',
      "let t = \"trap 'kill $! 2>/dev/null; exit 0' TERM\";",
      'let u = "kill -TERM \\"$pid\\" && kill -0 ${child}";',
      'let v = "kill -0 \\"$pid\\"; kill -s TERM -- ${child}";',
      'let p = "the kill guard refuses a group it did not start";',
      'let q = "resumes the thread after a kill -9, with no TUI to do it";',
      'vi.spyOn(process, "kill");',
    ].join("\n");
    expect(calls("a.rs", source)).toEqual([]);
    expect(calls("a.ts", 'vi.spyOn(process, "kill");')).toEqual([]);
  });

  it("lets through a quoted own target, a redirection with its target, and prose with an apostrophe", () => {
    const shells = [
      'for s in INT HUP TERM USR1; do sh -c "kill -s $s \\$\\$"; echo "$s=$?"; done > "$0"',
      'kill -TERM "$pid" 2>&1',
      "kill $pid > /dev/null",
      "kill -s TERM -- '$pid' 2> /dev/null",
      "kill -0 ${child} >&2; kill $! &> /dev/null",
      "time kill -TERM $pid",
      "the terminal's processes outlived their kill; exiting without them",
      "resumes the agent's thread itself after a kill -9, with no TUI to do it",
      "the holder kill guard",
      'a word that starts with "`" and ends the line',
      "echo $(date and an open substitution",
      "pid=$(cat /tmp/pid); kill $pid",
      "`date` checkSkills and skillFailures",
      'sh -c "kill -TERM \\"$pid\\""',
      'if [ -n "$(pgrep x)" ]; then kill $pid; fi',
      'sh -c "echo \\"done\\"; kill -s TERM \\$\\$"',
      "PROMPT_COMMAND+=$'\\n''__after=$?'",
      "kill $pid \\\n  2> /dev/null",
    ];
    expect(
      shells.filter(
        (shell) => calls("a.ts", `spawn("sh", ["-c", ${JSON.stringify(shell)}]);`).length,
      ),
    ).toEqual([]);
  });

  it("fails closed on a kill program cut by quotes, or an operand in quotes or a substitution", () => {
    const shells = [
      "time kill > x -9 -1",
      "time pkill node",
      "coproc killall node",
      'x pkill "$(pgrep -f y)"',
      "coproc kill > x -9 -1",
      "time -p kill > x -9 -1",
      "kill > x -9 -1",
      "kill $pid >| x -1",
      "kill $pid >& x -1",
      "kill $pid &> x -1",
      "kill $pid 2> x -1",
      "kill $pid '>' -1",
      "kill $pid '#' -1",
      "time kill $((-1))",
      "time kill $(printf -- -1)",
      "time kill '-1'",
      'coproc kill "-1"',
      "kill $pid '-1'",
      "kill $pid $(echo -1)",
      'kill $pid "$(echo -1)"',
      "kill $pid `echo -1`",
      "kill -9 $e'-1'",
      "k''ill -9 -1",
      '"k"ill -9 -1',
      "pk''ill node",
      "'kill' -9 -1",
      'x; "env" kill -9 -1',
      "echo $(kill -9 -1)",
      'echo "$(kill -9 -1)"',
      "echo `kill -9 -1`",
    ];
    expect(
      shells.filter(
        (shell) => !calls("a.ts", `spawn("sh", ["-c", ${JSON.stringify(shell)}]);`).length,
      ),
    ).toEqual([]);
  });

  it("fails closed on a line it can't parse: an unterminated substitution, or an unclosed quote either way", () => {
    const shells = [
      "kill $pid $(echo -1",
      "kill $pid $((1",
      "kill $pid `echo -1",
      'kill $pid "`echo -1"',
      "kill $pid '-1",
      "kill' -9 -1",
      "echo x'kill -9 -1",
      'echo "x; kill -9 -1',
      "it's a kill -9 -1",
    ];
    expect(
      shells.filter(
        (shell) => !calls("a.ts", `spawn("sh", ["-c", ${JSON.stringify(shell)}]);`).length,
      ),
    ).toEqual([]);
  });

  it("counts a whole-file entry once, so its own count holds", () => {
    expect(allowedSignalFailures("scripts/signal-paths.test.ts", "const a = 1;\n")).toEqual([]);
  });

  it("lets a fixture file name command-line kills, but not send a signal itself", () => {
    const source = [
      "child.kill();",
      "spawn(cmd, [], { timeout: 1 });",
      'const s = "kill -9 -1";',
      "process.kill(pid);",
    ].join("\n");
    for (const file of ["scripts/signal-paths.test.ts", "scripts/signal-paths.ts"])
      expect(rawSignalCalls(file, source).map((c) => c.line)).toEqual([1, 2, 2, 4]);
  });

  it("finds a kill a fixture file runs, or child_process it loads, as no fixture", () => {
    const source = [
      'execSync("kill -9 -1");',
      'spawnSync("sh", ["-c", "kill -9 -1"]);',
      'x.run("pkill node");',
      'const cp = require("child_process");',
      'const p = await import("node:child_process");',
      'export { exec } from "child_process";',
      'const s = "kill -9 -1"; execSync(s);',
      'const t = "kill -9 -1";',
      "const u = `kill -9 ${pid}`;",
      'const v = ["child_process"];',
      'expect(calls("a.ts", \'execSync("kill -9 -1")\')).toEqual([]);',
    ].join("\n");
    for (const file of ["scripts/signal-paths.test.ts", "scripts/signal-paths.ts"])
      expect(rawSignalCalls(file, source).map((c) => c.line)).toEqual([1, 1, 2, 2, 3, 4, 5, 6, 7]);
  });

  it("finds a start called inside a fixture's span, and lets one outside it be", () => {
    const fixture = [
      'execFileSync("oxlint", []);',
      "const FIXTURE = [",
      "  'child.kill();',",
      '  execSync("true"),',
      '].join("\\n");',
    ].join("\n");
    expect(
      rawSignalCalls("scripts/lint-plugin.medium.test.ts", fixture).map((c) => c.line),
    ).toEqual([4]);
  });

  it("allows a start's timeout, and no other option at that call", () => {
    const base = "scripts/falsify-base.ts";
    const call = [
      'spawnSync("pnpm", installArgs(mode), {',
      '  killSignal: "SIGKILL",',
      "  signal: abort.signal,",
      "  timeout: INSTALL_TIMEOUT_MS,",
      "});",
    ].join("\n");
    expect(rawSignalCalls(base, call).map((c) => c.line)).toEqual([2, 3]);
  });

  it("allows host-guard's cap its own scope's systemctl kill, and nothing else there", () => {
    const cap = "packages/host-guard/src/cap.ts";
    const own = 'output("systemctl", ["--user", "kill", `--signal=${signal}`, unit]);';
    expect(calls(cap, own)).toEqual([]);
    expect(calls(cap, `${own}\noutput("systemctl", ["--user", "kill", other]);`)).toEqual([
      "systemctl kill",
    ]);
    expect(calls(cap, "process.kill(pid);")).toEqual(["process.kill"]);
  });

  it("fails closed on a shell kill: one past --, a redirect or a comment, by path, nested, or second", () => {
    const shells = [
      "kill -- -1",
      "kill -KILL -- -1",
      "kill -s TERM -- -$pid",
      "kill -s KILL -1",
      "kill -n 9 -1",
      "kill -9 -1 2>/dev/null",
      "kill -KILL -1 2>&1",
      "kill -9 -1 </dev/null",
      "kill -9 -1 # x",
      "/bin/kill -9 -1",
      "/usr/bin/kill -KILL -1",
      'sh -c "kill -9 -1"',
      "bash -c 'kill -s KILL 0'",
      "kill -0 $$ && kill 0",
      "kill -TERM -{pid}",
      "kill -9 {}",
      "kill -9",
      "pgrep x | xargs kill",
      "xargs -n 1 kill",
      "xargs -P 4 kill -9",
      "killall5 -9",
      "skill -KILL u",
      "loginctl terminate-user $USER",
      "fuser -k 8080/tcp",
      "fuser --kill 8080/tcp",
      "sudo -u root kill -9 -1",
      "timeout -s KILL 5 kill -9 -1",
      "env -u HOME kill -9 -1",
      "flock /tmp/l kill -9 -1",
      "sudo -u me pkill node",
      "env -i A=1 kill -9 -1",
      "kill\t-9\t-1",
      "kill $!; kill 0",
      "kill 0",
      "kill -- -$pid",
      "kill $((pid))",
    ];
    expect(
      shells.map((shell) => calls("a.ts", `spawn("sh", ["-c", ${JSON.stringify(shell)}]);`).length),
    ).toEqual(shells.map(() => 1));
  });

  it("fails closed on an escape, a here-string, a joined word, an ANSI-C quote or a substituted program", () => {
    const shells = [
      "sh <<< kill\\ -9\\ -1",
      "sh <<<kill",
      'bash <<< "kill -9 -1"',
      "/bin/kill $pid \\> -1",
      "kill $pid \\# -1",
      "kill $pid \\; -1",
      "kill $pid \\| -1",
      "kill $pid \\& -1",
      "# setup\nkill -9 -1",
      "kill $pid \\\n-1",
      "ki\\\nll -9 -1",
      'sh -c "kill $pid "-1',
      "sh -c 'kill $PPID '-1",
      "$'k'ill -9 -1",
      '$"k"ill -9 -1',
      "$'\\x6bill' -9 -1",
      "$'\\153ill' -9 -1",
      "kill $pid $'\\x2d1'",
      "ki`:`ll -9 -1",
      "ki$(:)ll -9 -1",
      "$(printf kill) -9 -1",
      '"$(echo kill)" -9 -1',
      "time $(printf pkill) node",
    ];
    expect(
      shells.filter(
        (shell) => !calls("a.ts", `spawn("sh", ["-c", ${JSON.stringify(shell)}]);`).length,
      ),
    ).toEqual([]);
  });

  it("reads a Rust raw string as written, and an escaped one with its escapes", () => {
    expect(calls("a.rs", 'let s = r#"# x\\nkill -9 -1"#;')).toEqual([]);
    expect(calls("a.rs", 'let s = "# x\\nkill -9 -1";')).toHaveLength(1);
  });

  it("reads a Rust raw string as a command line too", () => {
    expect(calls("a.rs", 'let s = r#"sh -c "kill -9 -1""#;')).toHaveLength(1);
  });

  it("finds a kill program handed to a launcher, or a kill verb, as separate arguments", () => {
    const argvs = [
      '"env", "kill", "-9", pid',
      '"sudo", "kill", "-9", pid',
      '"timeout", "5", "kill", pid',
      '"/usr/bin/setsid", "kill", pid',
      '"busybox", "kill", "-9", pid',
      '"xargs", "-n", "1", "kill"',
      '"loginctl", "terminate-user", user',
      '"fuser", "-k", port',
    ];
    expect(argvs.map((argv) => calls("a.ts", `spawn("sh", [${argv}]);`).length)).toEqual(
      argvs.map(() => 1),
    );
  });

  it("finds process.kill through an alias of process, by import or constant", () => {
    const source = [
      'import proc from "node:process";',
      'import * as nproc from "node:process";',
      "const p = globalThis.process;",
      'proc.kill(-1, "SIGKILL");',
      "nproc.kill(1);",
      'p["kill"](2);',
      "const s = 'proc.kill(3)';",
    ].join("\n");
    expect(rawSignalCalls("a.ts", source).map((c) => c.line)).toEqual([4, 5, 6]);
  });

  it("finds Rust's kill by a use group or a raw syscall", () => {
    expect(
      calls(
        "a.rs",
        "use nix::sys::signal::{kill, Signal};\nuse libc::{getpid, kill};\nlibc::syscall(libc::SYS_kill, p, 9);\nlibc::sigqueue(p, 9, v);",
      ),
    ).toEqual([
      "use nix::sys::signal::{kill, Signal}",
      "use libc::{getpid, kill}",
      "SYS_kill",
      "sigqueue",
    ]);
  });

  it("finds a computed process['kill'], but not one in a string", () => {
    expect(calls("a.ts", 'process["kill"](pid);\nconst s = \'process["kill"]\';')).toEqual([
      'process["kill"]',
    ]);
  });
});

describe("signalling sources", () => {
  it("counts a file that ends processes through no call the scan reads", () => {
    expect(isSignallingSource("apps/daemon/src/pty/node-pty.ts", "export {};")).toBe(true);
    expect(isSignallingSource("apps/daemon/src/pty/other.ts", "export {};")).toBe(false);
  });

  it("counts a chokepoint, a raw call and a call through a chokepoint", () => {
    expect(isSignallingSource("packages/host-guard/src/signal.ts", "")).toBe(true);
    expect(isSignallingSource("a.rs", "kill_process(p, s);")).toBe(true);
    expect(isSignallingSource("a.ts", "signalGroup(child, 'SIGTERM');")).toBe(true);
    expect(isSignallingSource("a.ts", "rebindHolder(proof);")).toBe(true);
    expect(isSignallingSource("a.ts", "signalOwnChild(child, 'SIGINT');")).toBe(true);
    expect(isSignallingSource("a.ts", "void reset().finally(() => proc.hangUp());")).toBe(true);
    expect(isSignallingSource("a.ts", "const pty = { hangUp: () => undefined };")).toBe(false);
    const scope = 'execFile(file, args, { env, timeout, encoding: "utf8" }, done);';
    expect(rawSignalCalls("packages/host-guard/src/scope.ts", scope)).toEqual([]);
    expect(isSignallingSource("packages/host-guard/src/scope.ts", scope)).toBe(true);
    expect(isSignallingSource("scripts/signal-paths.test.ts", 'const s = "kill -9 -1";')).toBe(
      false,
    );
    expect(isSignallingSource("a.ts", "await rebindHolderSocket(holder);")).toBe(true);
    expect(
      ["startHolderWith", "rebindHolderWith", "killHolderAt", "rebindHolderAt"].filter(
        (name) => !isSignallingSource("a.ts", `${name}(x);`),
      ),
    ).toEqual([]);
    // Its never-ready path kills, so a caller of it is changed only in a sandbox too.
    expect(isSignallingSource("a.ts", "await startHolder({ binary, root, spec, env });")).toBe(
      true,
    );
    expect(isSignallingSource("a.rs", "bazhen_test_signal::signal(pid, Signal::USR1)?;")).toBe(
      true,
    );
    expect(isSignallingSource("a.rs", "self.child.close(self.pty.foreground_group(), now);")).toBe(
      true,
    );
    expect(isSignallingSource("a.rs", "use crate::child::{ChildProcess, Reaper};")).toBe(true);
    expect(isSignallingSource("a.rs", "bazhen_host_guard::kill_holder(&proof)?;")).toBe(true);
    expect(isSignallingSource("a.rs", "if let Some(at) = self.child.close_step(now) {}")).toBe(
      true,
    );
  });

  it("counts what starts or drives a session's end in the holder, and not the engine's Ending", () => {
    const sources = [
      "let session = Session::led_by(pid)?;",
      "self.ending = Some(Ending::start(session, now));",
      "Ok(pids) => self.pass_among(pids, signal),",
      "guard::signal_member(pid, session, signal)",
      "holder.close(now);",
      "holder.signal(body.signal)",
      "holder.respawn(pty, child, spec.generation);",
      "holder.retire(child);",
      "use crate::session::Ending;",
      "use crate::session::{self, Ending, Session};",
      "use bazhen_holder::session::{Session, Sweep};",
    ];
    const unrelated = [
      "match ending { Ending::Newline => {} }",
      "pub enum Ending { Newline, Wrap }",
      "struct Session; let s = Session;",
      "use bazhen_holder_engine::encode::Ending;",
      "use crate::session::{Sweep, member_state};",
    ];
    expect(sources.filter((source) => !isSignallingSource("a.rs", source))).toEqual([]);
    expect(unrelated.filter((source) => isSignallingSource("a.rs", source))).toEqual([]);
  });

  it("doesn't count a file that only mentions one", () => {
    expect(isSignallingSource("a.ts", "// signalGroup(child)\nconst x = 'killHolder';")).toBe(
      false,
    );
    expect(
      isSignallingSource("a.rs", '// bazhen_test_signal::signal(p)\nlet s = "bazhen_test_signal";'),
    ).toBe(false);
  });
});

describe("signalling tests", () => {
  it("counts a Rust test ignored as signalling, and the holder and soak suites", () => {
    const ignored =
      '#[test]\n#[ignore = "signals processes; runs in pnpm test:real rust"]\nfn t() {}';
    expect(isSignallingTest("crates/x/tests/a.rs", ignored)).toBe(true);
    expect(isSignallingTest("tests/holder/holder.test.ts", "")).toBe(true);
    expect(isSignallingTest("tests/soak/soak.test.ts", "")).toBe(true);
  });

  it("doesn't count a test ignored for another reason, or one quoting the attribute", () => {
    expect(isSignallingTest("a.rs", '#[ignore = "slow"]\nfn t() {}')).toBe(false);
    expect(isSignallingTest("a.rs", '#[ignore = "signals processes"]\nfn t() {}')).toBe(false);
    expect(isSignallingTest("a.rs", "#[ignore]\nfn t() {}")).toBe(false);
    const quoted = 'let a = "x"; let s = "#[ignore = \\"signals processes\\"]";';
    expect(isSignallingTest("a.rs", quoted)).toBe(false);
    expect(isSignallingTest("tests/support/holder-setup.ts", "")).toBe(false);
  });

  it("matches the reason among other strings, by its position", () => {
    const source =
      'const A: &str = "a";\n#[ignore = "signals processes; runs in pnpm test:real rust"]\nfn t() {}';
    expect(isSignallingTest("a.rs", source)).toBe(true);
  });
});
