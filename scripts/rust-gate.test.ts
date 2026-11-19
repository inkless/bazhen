import { describe, expect, it } from "vitest";
import { PROPTEST_SEED, configFailures, gateEnv, outsideConfigs } from "./rust-gate.ts";

const seed = (given?: string) => gateEnv({ PROPTEST_RNG_SEED: given }).PROPTEST_RNG_SEED;

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
      PROPTEST_CASES: "1",
    });
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/u",
      CARGO_TARGET_DIR: "/tmp/target",
      CARGO_BUILD_TARGET_DIR: "/tmp/build-target",
      CARGO_HOME: "/home/u/.cargo",
      CARGO_ENCODED_RUSTFLAGS: "",
      CARGO_ENCODED_RUSTDOCFLAGS: "",
      PROPTEST_RNG_SEED: "1",
    });
  });

  it("fixes proptest's seed, unless the caller gave one it reads as a seed", () => {
    expect([undefined, "", "random", "-1", "1e3", "18446744073709551616"].map(seed)).toEqual(
      Array(6).fill(PROPTEST_SEED),
    );
    expect([PROPTEST_SEED, seed("42"), seed("18446744073709551615")]).toEqual([
      "1",
      "42",
      "18446744073709551615",
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
    "/k/.cargo/config.toml": '[target.x86_64-unknown-linux-gnu]\nlinker = "/fake/cc"\n',
    "/l/.cargo/config.toml": "[profile.test]\noverflow-checks = false\n",
    "/m/.cargo/config.toml": "profile.dev.debug-assertions = false\n",
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

  it("names a config with a runner, rustdoc, linker, [env], profile or include, in any spelling", () => {
    expect(failures.map((f) => f.split(" ")[0])).toEqual(Object.keys(refused));
  });
});
