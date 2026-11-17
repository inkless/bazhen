import { describe, expect, it } from "vitest";
import {
  allowedSignalFailures,
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

  it("finds process._kill, and a re-export of process's kill", () => {
    const source = [
      "process._kill(pid, 9);",
      'export { kill } from "node:process";',
      'export { abort as die } from "process";',
      'export { kill } from "./mine.ts";',
    ].join("\n");
    expect(rawSignalCalls("a.ts", source).map((c) => c.line)).toEqual([1, 2, 3]);
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
    const starts = [
      "spawn",
      "spawnSync",
      "exec",
      "execSync",
      "execFile",
      "execFileSync",
      "fork",
    ].flatMap((start) => [
      `${start}(cmd, args, { timeout: 1_000 });`,
      `${start}(cmd, args, { env, killSignal: "SIGKILL" });`,
      `${start}(cmd, args, { stdio: "ignore", signal: abort.signal });`,
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
      'execFile("ps", args, (error, signal) => done(signal));',
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
      expect(rawSignalCalls(file, source).map((c) => c.line)).toEqual([1, 2, 4]);
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
