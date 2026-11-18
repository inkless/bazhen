// scripts/soak-vm.sh's refusals, run against stand-ins: every host tool it would act through
// (virsh, ssh, scp, sudo and the rest) is a stub that records its call and answers as the case
// sets it up, so a regression that gets past a refusal fails here instead of acting on the host.

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

const record = 'echo "${0##*/}" >> "$CALLS"';
const STUBS: Record<string, string> = {
  uname: "echo x86_64",
  id: "echo soak libvirt",
  hostname: "echo test-host",
  virsh: `for last; do :; done
case "$*" in
  *" dominfo "*) [ -n "$STUB_DOMAIN" ] ;;
  *" desc "*) printf '%s\\n' "$STUB_DESC" ;;
  *" domstate "*) echo running ;;
  *" vol-info "*) case " $STUB_VOLUMES " in *" $last "*) ;; *) exit 1 ;; esac ;;
  *" vol-delete "*) echo "\${*#*vol-delete }" >> "$DELETED" ;;
  *" domifaddr "*) printf ' Name MAC address Protocol Address\\n---\\n vnet0 52:54:00:00:00:01 ipv4 %s/24\\n' "$STUB_IP" ;;
  *) exit 1 ;;
esac`,
  ssh: `for last; do :; done
case "$last" in
  "true ") exit 0 ;;
  "bash -c "*) printf '%s\n' "$last" >> "$RAN"; exit 0 ;;
  *soak-run*) printf '%s\\n' "$STUB_RUN" ;;
  *) exit 1 ;;
esac`,
};
const FAILING = ["scp", "sudo", "sg", "curl", "git", "virt-install", "ssh-keygen", "cloud-localds"];

mkdirSync(bin);
for (const tool of ["cat", "awk", "sed", "tr", "sha256sum", "mkdir", "rm", "paste", "date"]) {
  symlinkSync(which(tool), join(bin, tool));
}
for (const [tool, body] of Object.entries(STUBS)) {
  writeFileSync(join(bin, tool), `#!/bin/sh\n${record}\n${body}\n`, { mode: 0o755 });
}
for (const tool of FAILING) {
  writeFileSync(join(bin, tool), `#!/bin/sh\n${record}\nexit 1\n`, { mode: 0o755 });
}

const TOKEN = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const runRecord = (profile: string) =>
  `pid=4242\nprofile=${profile}\nhours=24\nout=soak-${profile}-24h\n` +
  `log=soak-${profile}-24h.log\nstarted=1\ncommit=${COMMIT}`;
const GOOD_RUN = runRecord("gate");
/** A run's record as a VM started before profiles had one holds it: its names carry no profile. */
const RECORD_WITHOUT_PROFILE = `pid=4242\nhours=72\nout=soak-72h\nlog=soak-72h.log\nstarted=1\ncommit=${COMMIT}`;

interface Setup {
  /** The instance token on the host, if any. */
  token?: string;
  /** Whether a domain named bazhen-soak exists. */
  domain?: boolean;
  desc?: string;
  ip?: string;
  /** What the VM's ~/soak-run holds. */
  run?: string;
  /** The volumes the pool holds. */
  volumes?: string[];
  /** What is typed at the script's prompts. */
  input?: string;
}

let runs = 0;
/** The script run with `args` against stand-ins set up as `setup` says. */
function run(args: string[], setup: Setup = {}) {
  const home = join(dir, `home-${(runs += 1)}`);
  const calls = join(home, "calls");
  const deleted = join(home, "deleted");
  const ran = join(home, "ran");
  mkdirSync(join(home, ".ssh"), { recursive: true });
  writeFileSync(join(home, ".ssh", "bazhen-soak"), "");
  if (setup.token !== undefined) {
    mkdirSync(join(home, "state", "bazhen-soak"), { recursive: true });
    writeFileSync(join(home, "state", "bazhen-soak", "instance"), `${setup.token}\n`);
  }
  const result = spawnSync(bash, [script, ...args], {
    encoding: "utf8",
    input: setup.input ?? "",
    env: {
      PATH: bin,
      HOME: home,
      XDG_DATA_HOME: join(home, "state"),
      XDG_CACHE_HOME: join(home, "cache"),
      USER: "soak",
      CALLS: calls,
      DELETED: deleted,
      RAN: ran,
      STUB_VOLUMES: (setup.volumes ?? []).join(" "),
      STUB_DOMAIN: setup.domain === true ? "1" : "",
      STUB_DESC: setup.desc ?? "",
      STUB_IP: setup.ip ?? "192.168.122.5",
      STUB_RUN: setup.run ?? "",
    },
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    calls: existsSync(calls) ? readFileSync(calls, "utf8").split("\n").filter(Boolean) : [],
    deleted: existsSync(deleted) ? readFileSync(deleted, "utf8").split("\n").filter(Boolean) : [],
    collected: existsSync(join(home, "bazhen-soak-results")),
    /** Each script run in the VM, with its arguments. */
    ran: existsSync(ran) ? readFileSync(ran, "utf8").split("\n").filter(Boolean) : [],
  };
}

const refused = (message: string) => ({ status: 1, stderr: expect.stringContaining(message) });
const ours = { token: TOKEN, domain: true, desc: `bazhen-soak instance ${TOKEN}` };

const LEFTOVERS = ["bazhen-soak.qcow2", "bazhen-soak-seed.iso"];
// A volume of the pool that is no VM's: destroy must leave it be.
const BASE_VOLUME = "noble-0123456789ab.qcow2";

const BAD_HOURS = ["0", "0.0", "-1", "abc", "24h", "1e3", "1."];
const BAD_COMMITS = ["main", "abc", "ABC1234", "abc1234; true", "a".repeat(41)];
const BAD_RECORDS = [
  { what: "a run directory outside the soak's", run: GOOD_RUN.replaceAll("soak-gate-24h", "../x") },
  { what: "a log not the run's", run: GOOD_RUN.replace("log=soak-gate-24h.log", "log=../.bashrc") },
  { what: "a profile it doesn't run", run: runRecord("smoke") },
  { what: "a commit not a full hex sha", run: GOOD_RUN.replace(COMMIT, "../../tmp") },
  { what: "a pid not a number", run: GOOD_RUN.replace("pid=4242", "pid=1;x") },
];

// The script drives libvirt on a Linux host, with bash features macOS's bash 3.2 lacks.
describe.runIf(process.platform === "linux")("soak-vm.sh", () => {
  it("parses as bash", () => {
    expect(spawnSync(bash, ["-n", script], { encoding: "utf8" })).toMatchObject({
      status: 0,
      stderr: "",
    });
  });

  it("prints its usage for help, and fails with it for no command or an unknown one", () => {
    expect(run(["help"])).toMatchObject({
      status: 0,
      stdout: expect.stringContaining("usage: pnpm soak:vm"),
      calls: [],
    });
    expect(run([])).toMatchObject({ ...refused("usage: pnpm soak:vm"), calls: [] });
    expect(run(["frobnicate"])).toMatchObject({
      ...refused("unknown command 'frobnicate'"),
      calls: [],
    });
  });

  it("refuses an option the command doesn't take", () => {
    expect(run(["start", "--commit", "abc1234"])).toMatchObject({
      ...refused("start takes no option '--commit'"),
      calls: [],
    });
    expect(run(["destroy", "--yes"])).toMatchObject({
      ...refused("destroy takes no option '--yes'"),
      calls: [],
    });
  });

  it.each(BAD_HOURS)("refuses --hours %j", (hours) => {
    expect(run(["start", "--hours", hours])).toMatchObject({
      ...refused("--hours takes a positive number"),
      calls: [],
    });
  });

  it.each(["smoke", "week", "gate;true"])("refuses --profile %j", (profile) => {
    expect(run(["start", "--profile", profile])).toMatchObject({
      ...refused("--profile takes gate or long-life"),
      calls: [],
    });
  });

  it.each([
    [[], "gate"],
    [["--profile", "long-life"], "long-life"],
  ])("start %j starts the %s soak in the VM, named for its profile", (args, profile) => {
    const result = run(["start", ...args, "--hours", "48"], ours);
    expect(result.status).toBe(0);
    const start = result.ran.find((remote) => remote.includes("pnpm soak"));
    expect(start).toMatch(new RegExp(` ${profile} 48 $`));
    expect(start).toContain('pnpm soak --profile "$profile" --hours "$hours"');
  });

  it.each(BAD_COMMITS)("refuses --commit %j", (commit) => {
    expect(run(["create", "--commit", commit])).toMatchObject({
      ...refused("--commit takes a hex sha"),
      calls: [],
    });
  });

  it("refuses a VM with no instance token on this host, before any ssh", () => {
    const result = run(["status"], { domain: true, desc: `bazhen-soak instance ${TOKEN}` });
    expect(result).toMatchObject(refused("has no instance token"));
    expect(result.calls).not.toContain("ssh");
  });

  it("refuses a VM whose domain doesn't carry this host's token, before any ssh", () => {
    const result = run(["status"], { ...ours, desc: "bazhen-soak instance some-other-token" });
    expect(result).toMatchObject(refused("does not carry this script's instance token"));
    expect(result.calls).not.toContain("ssh");
  });

  it("refuses a lease that isn't an IPv4 address, before any ssh", () => {
    const result = run(["status"], { ...ours, ip: "-oProxyCommand=x" });
    expect(result).toMatchObject(refused("not an IPv4 address"));
    expect(result.calls).not.toContain("ssh");
  });

  it("reaches the VM over ssh when the domain carries this host's token", () => {
    expect(run(["status"], ours)).toMatchObject({
      status: 0,
      calls: expect.arrayContaining(["ssh"]),
    });
  });

  it.each(BAD_RECORDS)("collect refuses a run record with $what", ({ run: soakRun }) => {
    const result = run(["collect"], { ...ours, run: soakRun });
    expect(result).toMatchObject({ ...refused("unexpected"), collected: false });
    expect(result.calls).not.toContain("scp");
  });

  it.each([
    ["gate", runRecord("gate")],
    ["long-life", runRecord("long-life")],
    ["profile-less", RECORD_WITHOUT_PROFILE],
  ])("collect copies a well-formed %s run record's files", (_, soakRun) => {
    expect(run(["collect"], { ...ours, run: soakRun })).toMatchObject({
      collected: true,
      calls: expect.arrayContaining(["scp"]),
    });
  });

  describe("destroy with no domain", () => {
    const left = { volumes: [...LEFTOVERS, BASE_VOLUME] };

    it("refuses volumes it has no token for, deleting none and naming the manual command", () => {
      expect(run(["destroy"], { ...left, input: "bazhen-soak\n" })).toMatchObject({
        ...refused("no instance token on this host"),
        stderr: expect.stringContaining("vol-delete --pool default <volume>"),
        deleted: [],
      });
    });

    it("deletes nothing when the typed name is wrong", () => {
      expect(run(["destroy"], { ...left, token: TOKEN, input: "bazhen\n" })).toMatchObject({
        ...refused("not confirmed; nothing changed"),
        deleted: [],
      });
    });

    it("deletes exactly the VM's two volumes when the host has its token and the name is typed", () => {
      expect(run(["destroy"], { ...left, token: TOKEN, input: "bazhen-soak\n" })).toMatchObject({
        status: 0,
        deleted: LEFTOVERS.map((volume) => `--pool default ${volume}`),
      });
    });
  });
});
