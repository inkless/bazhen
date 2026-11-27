import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signalOwnChild } from "@bazhen/host-guard";
import { FRESH_MS } from "@bazhen/runtime-holder";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installHookClient, stableHookClient } from "./hook-link.ts";

let dir = "";
let first = "";
let second = "";
beforeEach(() => {
  // Resolved, as the links are compared with what realpath gives: macOS's /tmp is /private/tmp.
  dir = realpathSync(mkdtempSync(join(tmpdir(), "bz-hook-link-")));
  first = join(dir, "first-client");
  second = join(dir, "second-client");
  writeFileSync(first, "");
  writeFileSync(second, "");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const quiet = () => undefined;
const uid = process.getuid?.() ?? 0;

/** Lines a shell printed while it tested `path` over and over, once per moment it was missing. */
async function missesWhile(path: string, act: () => void): Promise<string[]> {
  const probe = spawn("sh", [
    "-c",
    'echo ready; while :; do [ -e "$1" ] || echo missing; done',
    "sh",
    path,
  ]);
  let out = "";
  probe.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
  await expect.poll(() => out).toContain("ready");
  act();
  const closed = new Promise((done) => probe.on("close", done));
  signalOwnChild(probe, "SIGKILL");
  await closed;
  return out.split("\n").filter((line) => line === "missing");
}

/** Points the link from one client to the other, `times` times over; what it warned of. */
function repoint(times: number): string[] {
  const warnings: string[] = [];
  for (let i = 0; i < times; i++)
    stableHookClient(dir, i % 2 === 0 ? second : first, uid, (m) => warnings.push(m));
  return warnings;
}

describe("stable hook link", () => {
  it("names the client through a link the next start points at a moved client", () => {
    const path = stableHookClient(dir, first, uid, quiet);
    const before = realpathSync(path);
    expect([stableHookClient(dir, second, uid, quiet), before, realpathSync(path)]).toEqual([
      path,
      first,
      second,
    ]);
  });

  it("never leaves the link missing while it is pointed somewhere else", async () => {
    stableHookClient(dir, first, uid, quiet);
    let warnings: string[] = [];
    const misses = await missesWhile(join(dir, "bazhen-hook"), () => {
      warnings = repoint(2_000);
    });
    expect([misses, warnings]).toEqual([[], []]);
  });

  it("replaces a half-made link a stopped daemon left behind", () => {
    symlinkSync(first, join(dir, "bazhen-hook.tmp"));
    const path = stableHookClient(dir, second, uid, quiet);
    expect([path, realpathSync(path)]).toEqual([join(dir, "bazhen-hook"), second]);
  });

  it("gives back the client itself, and says so, where no link can be made", () => {
    const warnings: string[] = [];
    const inFile = join(first, "state");
    expect([stableHookClient(inFile, second, uid, (m) => warnings.push(m)), warnings]).toEqual([
      second,
      [expect.stringContaining(second)],
    ]);
  });

  it("links nothing in a directory another user owns, since its owner would choose what runs", () => {
    const warnings: string[] = [];
    const path = stableHookClient(dir, second, uid + 1, (m) => warnings.push(m));
    expect([path, warnings, existsSync(join(dir, "bazhen-hook"))]).toEqual([
      second,
      [expect.stringContaining("owned by uid")],
      false,
    ]);
  });

  it("gives back the client itself where something else already holds the link's name", () => {
    mkdirSync(join(dir, "bazhen-hook", "kept"), { recursive: true });
    const warnings: string[] = [];
    expect([stableHookClient(dir, second, uid, (m) => warnings.push(m)), warnings]).toEqual([
      second,
      [expect.stringContaining(second)],
    ]);
  });
});

const buildOf = (bytes: string) => createHash("sha256").update(bytes).digest("hex").slice(0, 16);
/** What running `path` would run. */
const runs = (path: string) => readFileSync(path, "utf8");

describe("installed hook client", () => {
  let state = "";
  let source = "";
  beforeEach(() => {
    state = join(dir, "state", "hook");
    source = join(dir, "checkout", "bazhen-hook");
    mkdirSync(join(dir, "checkout"));
    writeFileSync(source, "build one", { mode: 0o755 });
  });

  const install = (warn: (message: string) => void = quiet) =>
    installHookClient({ source, dir: state, uid, warn });
  /** Dates every build in `state` back past the fresh window, as a start long before would. */
  const age = () => {
    const then = (Date.now() - 2 * FRESH_MS) / 1000;
    for (const name of readdirSync(state))
      if (/^[0-9a-f]{16}$/.test(name)) utimesSync(join(state, name), then, then);
  };

  it("keeps hooks running once the checkout's client is deleted", async () => {
    const { path, client } = await install();
    rmSync(source);
    expect([path, client, runs(path)]).toEqual([
      join(state, "bazhen-hook"),
      join(state, buildOf("build one"), "bazhen-hook"),
      "build one",
    ]);
  });

  it("points hooks at a rebuilt client and removes the copy nothing names any more", async () => {
    await install();
    age();
    writeFileSync(source, "build two");
    const { path } = await install();
    expect([runs(path), readdirSync(state).toSorted()]).toEqual([
      "build two",
      [buildOf("build two"), "bazhen-hook"].toSorted(),
    ]);
  });

  it("keeps the build another start pointed the link at while this one installed its own", async () => {
    const other = await install();
    writeFileSync(source, "build two");
    const { path } = await installHookClient({
      source,
      dir: state,
      uid,
      warn: quiet,
      beforePrune: () => {
        age();
        stableHookClient(state, other.client, uid, quiet);
      },
    });
    rmSync(source);
    expect(runs(path)).toBe("build one");
  });

  it("keeps a copy hooks were given by its own path while no link can be made", async () => {
    mkdirSync(join(state, "bazhen-hook", "kept"), { recursive: true });
    const before = await install();
    age();
    writeFileSync(source, "build two");
    const after = await install();
    rmSync(source);
    expect([runs(before.path), runs(after.path)]).toEqual(["build one", "build two"]);
  });

  it("installs into a hook directory an older start left open to its group", async () => {
    mkdirSync(state, { recursive: true });
    chmodSync(state, 0o770);
    const warnings: string[] = [];
    const { path } = await install((m) => warnings.push(m));
    rmSync(source);
    expect([runs(path), warnings]).toEqual(["build one", []]);
  });

  it("gives hooks the checkout's client, and says so, where nothing can be installed", async () => {
    const warnings: string[] = [];
    const result = await installHookClient({
      source,
      dir: state,
      uid: uid + 1,
      warn: (m) => warnings.push(m),
    });
    expect([result, warnings.length > 0]).toEqual([{ path: source, client: source }, true]);
  });
});
