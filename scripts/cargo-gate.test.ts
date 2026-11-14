import { describe, expect, it } from "vitest";
import { GATES, configFailures, gateEnv, outsideConfigs, parseGate } from "./cargo-gate.ts";

describe("gateEnv", () => {
  it("drops every variable that changes the build's flags, tools or test runner", () => {
    const env = gateEnv({
      PATH: "/usr/bin",
      HOME: "/home/u",
      CARGO_TARGET_DIR: "/tmp/target",
      CARGO_BUILD_TARGET_DIR: "/tmp/build-target",
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
      CARGO_BUILD_TARGET_DIR: "/tmp/build-target",
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
        '--config build.rustc-wrapper="" --config build.rustc-workspace-wrapper="" ' +
          '--config build.rustc="rustc"',
      );
    }
  });

  it("lints and tests every feature, so no code hides behind one", () => {
    expect([GATES.lint, GATES.test].map((gate) => gate.includes("--all-features"))).toEqual([
      true,
      true,
    ]);
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
  const refused: Record<string, string> = {
    "/a/.cargo/config.toml": '[target.x86_64-unknown-linux-gnu]\nrunner = "true"\n',
    "/b/.cargo/config": 'target.x86_64-unknown-linux-gnu.runner = "true"\n',
    "/c/.cargo/config.toml": '[target.\'cfg(unix)\']\n"runner" = ["true"]\n',
    "/d/.cargo/config.toml": 'target = { x86_64-unknown-linux-gnu = { runner = "true" } }\n',
    "/e/.cargo/config.toml": '[build]\nrustdoc = "/fake/rustdoc"\n',
    "/f/.cargo/config.toml": '[env]\nCLIPPY_ARGS = { value = "--cap-lints=allow", force = true }\n',
    "/g/.cargo/config.toml": 'env.CLIPPY_ARGS = "--cap-lints=allow"\n',
    "/i/.cargo/config.toml": '[env.CLIPPY_ARGS]\nvalue = "--cap-lints=allow"\nforce = true\n',
    "/j/.cargo/config.toml": 'include = ["/elsewhere/more.toml"]\n',
  };
  const accepted: Record<string, string> = {
    "/h/.cargo/config.toml": '[build]\nrustc-wrapper = "/usr/bin/sccache"\n',
    "/home/u/.cargo/config.toml":
      '# runner = "true" is off\n[net]\ngit-fetch-with-cli = true # no runner = x\n[build]\njobs = 4\nrustc = "x"\n',
  };
  const configs = { ...refused, ...accepted };
  const failures = configFailures(
    [...Object.keys(configs), "/missing/.cargo/config.toml"],
    (p) => configs[p],
  );

  it("names a config with a runner, a rustdoc, [env] or include, in any TOML spelling", () => {
    expect(failures.map((f) => f.split(" ")[0])).toEqual(Object.keys(refused));
  });
});
