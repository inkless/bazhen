import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stableHookClient } from "./hook-link.ts";

let dir = "";
let first = "";
let second = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bz-hook-link-"));
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
  probe.kill("SIGKILL");
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
