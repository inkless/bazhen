import { describe, expect, it } from "vitest";
import { isSignallingSource, isSignallingTest, rawSignalCalls } from "./signal-paths.ts";

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
    ].join("\n");
    expect(calls("a.rs", source)).toEqual([
      "kill_process",
      "kill_process_group",
      "kill_current_process_group",
      "pidfd_send_signal",
      "libc::kill",
      "killpg",
      "signal::kill",
    ]);
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

  it("ignores one in a comment, a string or a template, and a child's own kill", () => {
    const source = [
      "// process.kill(-1)",
      "/* process.kill(-1) */",
      "const a = 'process.kill(-1, \"SIGKILL\");';",
      "const b = `process.kill(${pid})`;",
      "child.kill('SIGTERM');",
    ].join("\n");
    expect(calls("a.ts", source)).toEqual([]);
  });

  it("reads no other kind of file", () => {
    expect(calls("README.md", "process.kill(-1)")).toEqual([]);
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
      'let p = "the kill guard refuses a group it did not start";',
      'vi.spyOn(process, "kill");',
    ].join("\n");
    expect(calls("a.rs", source)).toEqual([]);
    expect(calls("a.ts", 'vi.spyOn(process, "kill");')).toEqual([]);
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
    ];
    expect(
      shells.map((shell) => calls("a.ts", `spawn("sh", ["-c", ${JSON.stringify(shell)}]);`).length),
    ).toEqual(shells.map(() => 1));
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
  it("counts a chokepoint, a raw call and a call through a chokepoint", () => {
    expect(isSignallingSource("packages/host-guard/src/signal.ts", "")).toBe(true);
    expect(isSignallingSource("a.rs", "kill_process(p, s);")).toBe(true);
    expect(isSignallingSource("a.ts", "signalGroup(child, 'SIGTERM');")).toBe(true);
    expect(isSignallingSource("a.rs", "bazhen_test_signal::signal(pid, Signal::USR1)?;")).toBe(
      true,
    );
    expect(isSignallingSource("a.rs", "self.child.close(self.pty.foreground_group(), now);")).toBe(
      true,
    );
    expect(isSignallingSource("a.rs", "use crate::child::{ChildProcess, Reaper};")).toBe(true);
    expect(isSignallingSource("a.rs", "if let Some(at) = self.child.close_step(now) {}")).toBe(
      true,
    );
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
  it("counts a Rust test ignored as signalling, and the holder suite", () => {
    const ignored =
      '#[test]\n#[ignore = "signals processes; runs in pnpm test:real rust"]\nfn t() {}';
    expect(isSignallingTest("crates/x/tests/a.rs", ignored)).toBe(true);
    expect(isSignallingTest("tests/holder/holder.test.ts", "")).toBe(true);
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
