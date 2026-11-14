// Runs scripts/cargo-gate.ts as `pnpm` does, with stub cargo-* binaries on PATH that log the
// arguments and flag variables they were started with, so what a gate really hands its tool is
// checked, not only the functions that build it. The gate also reads the cargo configs in the
// repository's real parent directories; one there with a runner or [env] fails these tests too.

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GATES } from "./cargo-gate.ts";

const GATE_SCRIPT = fileURLToPath(new URL("cargo-gate.ts", import.meta.url));

const STUB = `#!/bin/sh
case "$*" in *--version*) exit "\${STUB_VERSION_EXIT:-0}" ;; esac
echo "ARGV: $*" >> "$STUB_LOG"
[ -n "\${RUSTFLAGS+set}" ] && echo "RUSTFLAGS=$RUSTFLAGS" >> "$STUB_LOG"
[ -n "\${CARGO_ENCODED_RUSTFLAGS+set}" ] && echo "CARGO_ENCODED_RUSTFLAGS=$CARGO_ENCODED_RUSTFLAGS" >> "$STUB_LOG"
exit "\${STUB_EXIT:-0}"
`;

let dir: string;
let bin: string;
let log: string;
let home: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bz-cargo-gate-"));
  bin = join(dir, "bin");
  home = join(dir, "cargo-home");
  log = join(dir, "stub.log");
  mkdirSync(bin);
  mkdirSync(home);
  for (const tool of ["cargo-fmt", "cargo-clippy", "cargo-deny", "cargo-nextest"]) {
    writeFileSync(join(bin, tool), STUB);
    chmodSync(join(bin, tool), 0o755);
  }
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function gate(args: string[], env: Record<string, string> = {}) {
  const run = spawnSync(process.execPath, [GATE_SCRIPT, ...args], {
    encoding: "utf8",
    env: { PATH: bin, CARGO_HOME: home, STUB_LOG: log, ...env },
  });
  const logged = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
  return { status: run.status, stderr: run.stderr, logged };
}

describe("cargo-gate.ts", () => {
  it("hands the tool its fixed command, the tests named after it, and no caller's flags", () => {
    const { status, logged } = gate(["test", "tests::a", "b"], {
      RUSTFLAGS: "--cap-lints allow",
      CARGO_ENCODED_RUSTFLAGS: "--cap-lints=allow",
    });
    expect({ status, logged }).toEqual({
      status: 0,
      logged: [
        `ARGV: ${[...GATES.test.slice(1), "tests::a", "b"].join(" ")}`,
        "CARGO_ENCODED_RUSTFLAGS=",
      ],
    });
  });

  it("exits as the tool did", () => {
    expect(gate(["lint"], { STUB_EXIT: "3" }).status).toBe(3);
  });

  it("refuses to lint or test under a config it can't override, and runs nothing", () => {
    writeFileSync(join(home, "config.toml"), '[env]\nCLIPPY_ARGS = "--cap-lints=allow"\n');
    const refused = ["lint", "test"].map((g) => {
      const { status, stderr, logged } = gate([g]);
      return { status, refused: stderr.includes("sets a test runner"), logged };
    });
    expect(refused).toEqual([
      { status: 1, refused: true, logged: [] },
      { status: 1, refused: true, logged: [] },
    ]);
  });

  it("formats and checks dependencies under such a config, since neither compiles", () => {
    writeFileSync(join(home, "config.toml"), '[env]\nCLIPPY_ARGS = "--cap-lints=allow"\n');
    expect(["fmt", "deny"].map((g) => gate([g]).status)).toEqual([0, 0]);
  });

  it("names the install command when a tool is missing", () => {
    rmSync(join(bin, "cargo-deny"));
    const { status, stderr } = gate(["deny"]);
    expect({ status, hint: stderr.includes("cargo install --locked") }).toEqual({
      status: 1,
      hint: true,
    });
  });

  it("names the toolchain when a tool is there but can't run, as a missing component is", () => {
    const { status, stderr, logged } = gate(["lint"], { STUB_VERSION_EXIT: "1" });
    expect({ status, hint: stderr.includes("install rustup"), logged }).toEqual({
      status: 1,
      hint: true,
      logged: [],
    });
  });
});
