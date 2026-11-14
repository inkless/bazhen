import { describe, expect, it } from "vitest";
import { GATES, configFailures, gateEnv, outsideConfigs, parseGate } from "./cargo-gate.ts";

describe("gateEnv", () => {
  it("drops every variable that changes the build's flags, tools or test runner", () => {
    const env = gateEnv({
      PATH: "/usr/bin",
      HOME: "/home/u",
      CARGO_TARGET_DIR: "/tmp/target",
      CARGO_HOME: "/home/u/.cargo",
      RUSTFLAGS: "--cap-lints allow",
      CARGO_ENCODED_RUSTFLAGS: "--cap-lints=allow",
      CARGO_ENCODED_RUSTDOCFLAGS: "--cap-lints=allow",
      RUSTDOCFLAGS: "-A x",
      CARGO_BUILD_RUSTFLAGS: "--cap-lints=allow",
      CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUSTFLAGS: "--cap-lints=allow",
      CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUNNER: "true",
      CARGO_ALIAS_CLIPPY: "check",
      CARGO_PROFILE_DEV_OPT_LEVEL: "3",
      RUSTC: "/fake/rustc",
      RUSTC_WRAPPER: "/bin/true",
      RUSTC_WORKSPACE_WRAPPER: "/bin/true",
      RUSTDOC: "/fake/rustdoc",
      RUSTUP_TOOLCHAIN: "nightly",
      CARGO: "/fake/cargo",
      CLIPPY_CONF_DIR: "/tmp",
      CLIPPY_ARGS: "--cap-lints=allow",
      NEXTEST_PROFILE: "lax",
    });
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/u",
      CARGO_TARGET_DIR: "/tmp/target",
      CARGO_HOME: "/home/u/.cargo",
      CARGO_ENCODED_RUSTFLAGS: "",
      CARGO_ENCODED_RUSTDOCFLAGS: "",
    });
  });
});

describe("parseGate", () => {
  it("names each gate, and for test the tests to run", () => {
    expect([
      ...["fmt", "lint", "deny", "test"].map((g) => parseGate([g])),
      parseGate(["test", "refuses_a_cut", "tests::properties::round_trips"]),
    ]).toEqual([
      { gate: "fmt", tests: [] },
      { gate: "lint", tests: [] },
      { gate: "deny", tests: [] },
      { gate: "test", tests: [] },
      { gate: "test", tests: ["refuses_a_cut", "tests::properties::round_trips"] },
    ]);
  });

  it("refuses no gate, an unknown one, an option, or a test name for any gate but test", () => {
    for (const args of [
      [],
      ["build"],
      ["lint", "--cap-lints", "allow"],
      ["lint", "some_test"],
      ["test", "--", "-x"],
      ["test", "ok", "--no-tests=pass"],
      ["test", "-E", "none()"],
    ]) {
      expect(() => parseGate(args)).toThrow(/takes no other arguments/);
    }
  });
});

describe("GATES", () => {
  it("calls each subcommand's own binary, so no cargo alias can stand in for it", () => {
    expect(Object.values(GATES).map((argv) => argv[0])).toEqual([
      "cargo-fmt",
      "cargo-clippy",
      "cargo-deny",
      "cargo-nextest",
    ]);
  });

  it("fails clippy on any warning, and overrides a configured wrapper or compiler", () => {
    expect(GATES.lint.slice(-3)).toEqual(["--", "-D", "warnings"]);
    for (const gate of [GATES.lint, GATES.test]) {
      expect(gate.join(" ")).toContain(
        '--config build.rustc-wrapper="" --config build.rustc="rustc"',
      );
    }
  });
});

describe("outsideConfigs", () => {
  it("lists each parent directory's cargo config and CARGO_HOME's, not the repository's own", () => {
    expect(outsideConfigs("/a/b/repo/", "/home/u/.cargo")).toEqual([
      "/a/b/.cargo/config",
      "/a/b/.cargo/config.toml",
      "/a/.cargo/config",
      "/a/.cargo/config.toml",
      "/.cargo/config",
      "/.cargo/config.toml",
      "/home/u/.cargo/config",
      "/home/u/.cargo/config.toml",
    ]);
  });
});

describe("configFailures", () => {
  const configs: Record<string, string> = {
    "/a/.cargo/config.toml": '[build]\nrustc-wrapper = "/usr/bin/sccache"\n',
    "/b/.cargo/config": '[target.x86_64-unknown-linux-gnu]\nrunner = "true"\n',
    "/c/.cargo/config.toml": '[build]\nrustc = "/fake/rustc"\n',
    "/home/u/.cargo/config.toml": "[net]\ngit-fetch-with-cli = true\n[build]\njobs = 4\n",
  };
  const failures = configFailures(
    [...Object.keys(configs), "/missing/.cargo/config.toml"],
    (p) => configs[p],
  );

  it("names a config that swaps the compiler, wraps it or runs the tests through something else", () => {
    expect(failures.map((f) => f.split(" ")[0])).toEqual([
      "/a/.cargo/config.toml",
      "/b/.cargo/config",
      "/c/.cargo/config.toml",
    ]);
  });
});
