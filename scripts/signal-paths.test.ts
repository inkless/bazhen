import { describe, expect, it } from "vitest";
import {
  INIT_PID_NAMESPACE,
  type SandboxHost,
  inSignalSandbox,
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

describe("signalling sources", () => {
  it("counts a chokepoint, a raw call and a call through a chokepoint", () => {
    expect(isSignallingSource("packages/host-guard/src/signal.ts", "")).toBe(true);
    expect(isSignallingSource("a.rs", "kill_process(p, s);")).toBe(true);
    expect(isSignallingSource("a.ts", "signalGroup(child, 'SIGTERM');")).toBe(true);
    expect(isSignallingSource("a.rs", "bazhen_test_signal::signal(pid, Signal::USR1)?;")).toBe(
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

const host = (over: Partial<SandboxHost>): SandboxHost => ({
  platform: "linux",
  pidNamespace: INIT_PID_NAMESPACE,
  markerOwner: undefined,
  ...over,
});

describe("the signal sandbox", () => {
  it("is a PID namespace other than the initial one, on Linux", () => {
    expect(inSignalSandbox(host({ pidNamespace: "pid:[4026532999]" }))).toBe(true);
    expect(inSignalSandbox(host({}))).toBe(false);
    expect(inSignalSandbox(host({ pidNamespace: undefined }))).toBe(false);
    expect(inSignalSandbox(host({ platform: "darwin", pidNamespace: "pid:[4026532999]" }))).toBe(
      false,
    );
  });

  it("is a host carrying root's marker, on any platform", () => {
    expect(inSignalSandbox(host({ markerOwner: 0 }))).toBe(true);
    expect(inSignalSandbox(host({ platform: "darwin", markerOwner: 0 }))).toBe(true);
  });

  it("isn't a host whose marker someone else made", () => {
    expect(inSignalSandbox(host({ markerOwner: 1000 }))).toBe(false);
    expect(inSignalSandbox(host({ platform: "darwin", markerOwner: 501 }))).toBe(false);
  });
});
