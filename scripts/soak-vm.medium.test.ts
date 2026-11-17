// scripts/soak-vm.sh's refusals that come before it touches libvirt, ssh or sudo. Each run has a
// PATH whose virsh, ssh, sudo and the rest only record that they were called, so a regression that
// gets past a refusal fails here instead of acting on the host.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("soak-vm.sh", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "bz-soak-vm-"));
const bin = join(dir, "bin");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const which = (name: string) =>
  spawnSync("bash", ["-c", `command -v ${name}`], { encoding: "utf8" }).stdout.trim();
const bash = which("bash");

mkdirSync(bin);
for (const tool of ["cat", "awk"]) symlinkSync(which(tool), join(bin, tool));
const STAND_INS = [
  "virsh",
  "virt-install",
  "ssh",
  "scp",
  "sudo",
  "sg",
  "curl",
  "git",
  "id",
  "uname",
];
for (const tool of STAND_INS) {
  writeFileSync(join(bin, tool), `#!/bin/sh\necho ${tool} >> "$CALLS"\nexit 1\n`, { mode: 0o755 });
}

let runs = 0;
/** The script run with `args`, and the stand-ins it called. */
function run(...args: string[]) {
  const calls = join(dir, `calls-${(runs += 1)}`);
  const result = spawnSync(bash, [script, ...args], {
    encoding: "utf8",
    env: { PATH: bin, HOME: dir, CALLS: calls },
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    calls: existsSync(calls) ? readFileSync(calls, "utf8").split("\n").filter(Boolean) : [],
  };
}

const refused = (message: string) => ({
  status: 1,
  stderr: expect.stringContaining(message),
  calls: [],
});

// The script drives libvirt on a Linux host, with bash features macOS's bash 3.2 lacks.
describe.runIf(process.platform === "linux")("soak-vm.sh", () => {
  it("parses as bash", () => {
    expect(spawnSync(bash, ["-n", script], { encoding: "utf8" })).toMatchObject({
      status: 0,
      stderr: "",
    });
  });

  it("prints its usage for help, and fails with it for no command or an unknown one", () => {
    expect(run("help")).toMatchObject({
      status: 0,
      stdout: expect.stringContaining("usage: pnpm soak:vm"),
      calls: [],
    });
    expect(run()).toMatchObject(refused("usage: pnpm soak:vm"));
    expect(run("frobnicate")).toMatchObject(refused("unknown command 'frobnicate'"));
  });

  it("refuses an option the command doesn't take", () => {
    expect(run("start", "--commit", "abc1234")).toMatchObject(
      refused("start takes no option '--commit'"),
    );
    expect(run("destroy", "--yes")).toMatchObject(refused("destroy takes no option '--yes'"));
    expect(run("collect", "--hours", "1")).toMatchObject(
      refused("collect takes no option '--hours'"),
    );
  });

  it.each(["0", "0.0", "-1", "abc", "24h", "1e3", "1."])("refuses --hours %j", (hours) => {
    expect(run("start", "--hours", hours)).toMatchObject(
      refused("--hours takes a positive number"),
    );
  });

  it.each(["main", "abc", "ABC1234", "abc1234; true", "a".repeat(41)])(
    "refuses --commit %j",
    (commit) => {
      expect(run("create", "--commit", commit)).toMatchObject(refused("--commit takes a hex sha"));
    },
  );

  it("reaches the host's tools once its arguments are good, so the stand-ins can tell", () => {
    expect(run("status")).toMatchObject({ status: 1, calls: ["uname"] });
  });
});
