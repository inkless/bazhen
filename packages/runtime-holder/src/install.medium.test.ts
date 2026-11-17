// Installs files named as the holder into temporary directories. Nothing is run.

import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lutimesSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type HolderInstall,
  installHolder,
  pruneHolderBuilds,
  pruneUnusedHolders,
  runningBuilds,
  FRESH_MS,
} from "./install.ts";

const uid = process.getuid?.() ?? 0;
let root = "";
let dir = "";
let source = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bz-holder-install-"));
  dir = join(root, "state", "holder");
  source = join(root, "bazhen-holder");
  writeFileSync(source, "build one", { mode: 0o755 });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const buildOf = (bytes: string) => createHash("sha256").update(bytes).digest("hex").slice(0, 16);
const install = () => installHolder({ source, dir, uid });
const binaryOf = (result: HolderInstall) => {
  if (result.installed === null) throw new Error(result.reason);
  return result.installed.binary;
};
const ls = () => readdirSync(dir).toSorted();

describe("installing the holder", () => {
  it("installs another binary the same way under its own name, and finds it installed again", async () => {
    const first = await installHolder({ source, dir, uid, command: "bazhen-peer" });
    const again = await installHolder({ source, dir, uid, command: "bazhen-peer" });
    const binary = join(dir, buildOf("build one"), "bazhen-peer");
    expect([binaryOf(first), binaryOf(again), statSync(binary).mode & 0o777]).toEqual([
      binary,
      binary,
      0o500,
    ]);
  });

  it("copies the build under its hash, read-only, in a directory only this user can reach", async () => {
    const result = await install();
    const build = buildOf("build one");
    const binary = join(dir, build, "bazhen-holder");
    expect([
      result,
      readFileSync(binary, "utf8"),
      statSync(binary).mode & 0o777,
      statSync(join(dir, build)).mode & 0o777,
      statSync(dir).mode & 0o777,
      ls(),
    ]).toEqual([
      { installed: { binary, build, installDir: dir } },
      "build one",
      0o500,
      0o700,
      0o700,
      [build],
    ]);
  });

  it("reuses an installed build without writing it again", async () => {
    const first = binaryOf(await install());
    const inode = statSync(first).ino;
    const second = binaryOf(await install());
    expect([second, statSync(second).ino, ls()]).toEqual([first, inode, [buildOf("build one")]]);
  });

  it("makes a reused build fresh again, so another start's prune doesn't take it for unused", async () => {
    await install();
    const then = new Date(Date.now() - 2 * FRESH_MS);
    utimesSync(join(dir, buildOf("build one")), then, then);
    await install();
    expect([await pruneHolderBuilds(dir, uid, new Set()), ls()]).toEqual([
      [],
      [buildOf("build one")],
    ]);
  });

  it("installs a new build beside the old one, which a running holder keeps unchanged", async () => {
    const old = binaryOf(await install());
    const inode = statSync(old).ino;
    writeFileSync(source, "build two");
    const next = binaryOf(await install());
    expect([
      next,
      statSync(old).ino,
      readFileSync(old, "utf8"),
      readFileSync(next, "utf8"),
      ls(),
    ]).toEqual([
      join(dir, buildOf("build two"), "bazhen-holder"),
      inode,
      "build one",
      "build two",
      [buildOf("build one"), buildOf("build two")].toSorted(),
    ]);
  });

  it("moves aside what holds the build's name but not its bytes, rather than write over it", async () => {
    const build = buildOf("build one");
    mkdirSync(join(dir, build), { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, build, "bazhen-holder"), "something else", { mode: 0o500 });
    const binary = binaryOf(await install());
    const aside = ls().filter((name) => name.startsWith(`.bad-${build}-`));
    expect([
      readFileSync(binary, "utf8"),
      aside.map((name) => readFileSync(join(dir, name, "bazhen-holder"), "utf8")),
    ]).toEqual(["build one", ["something else"]]);
  });

  it("moves aside an installed build another user may write", async () => {
    const binary = binaryOf(await install());
    chmodSync(binary, 0o520);
    await install();
    expect([
      statSync(binary).mode & 0o777,
      ls().filter((n) => n.startsWith(".bad-")).length,
    ]).toEqual([0o500, 1]);
  });

  it("takes the build another install renamed into place first", async () => {
    let other: HolderInstall | undefined;
    const result = await installHolder(
      { source, dir, uid },
      {
        beforeRename: async () => {
          other = await install();
        },
      },
    );
    expect([result, other, ls()]).toEqual([
      other,
      { installed: expect.objectContaining({ build: buildOf("build one") }) },
      [buildOf("build one")],
    ]);
  });

  it("names the build by what was copied, though a build rewrites the source meanwhile", async () => {
    const result = await installHolder(
      { source, dir, uid },
      { afterCopy: async () => writeFileSync(source, "build two") },
    );
    expect([result, ls()]).toEqual([
      { installed: expect.objectContaining({ build: buildOf("build one") }) },
      [buildOf("build one")],
    ]);
  });

  it("installs once when two installs run together", async () => {
    const results = await Promise.all([install(), install(), install()]);
    expect([new Set(results.map(binaryOf)).size, ls()]).toEqual([1, [buildOf("build one")]]);
  });

  it("says why when nothing is built, and makes nothing", async () => {
    rmSync(source);
    expect([await install(), existsSync(dir)]).toEqual([
      { installed: null, reason: expect.stringContaining("isn't built") },
      false,
    ]);
  });

  it("leaves no copy behind when the copy fails", async () => {
    rmSync(source);
    mkdirSync(source);
    expect([await install(), ls()]).toEqual([
      { installed: null, reason: expect.stringContaining("couldn't be installed") },
      [],
    ]);
  });

  it("refuses a directory someone else could write or redirect, and never repairs it", async () => {
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere, { mode: 0o700 });
    mkdirSync(join(root, "state"));
    symlinkSync(elsewhere, dir);
    const linked = await install();
    rmSync(dir);
    mkdirSync(dir, { mode: 0o700 });
    chmodSync(dir, 0o770);
    const open = await install();
    const mode = statSync(dir).mode & 0o777;
    chmodSync(dir, 0o700);
    const foreign = await installHolder({ source, dir, uid: uid + 1 });
    expect([linked, open, mode, foreign, readdirSync(elsewhere), ls()]).toEqual([
      { installed: null, reason: expect.stringContaining("it is a symlink") },
      { installed: null, reason: expect.stringContaining("other users may write it") },
      0o770,
      { installed: null, reason: expect.stringContaining(`it belongs to uid ${uid}`) },
      [],
      [],
    ]);
  });
});

const OLD = "0000000000000000";
const KEPT = "1111111111111111";
const RUNNING = "2222222222222222";
const SELF = 4242;
/** A build directory named `name`, holding a binary, made `FRESH_MS` and a minute ago. */
function plant(name: string) {
  mkdirSync(join(dir, name), { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, name, "bazhen-holder"), name, { mode: 0o500 });
  age(name);
}
function age(name: string) {
  const past = (Date.now() - FRESH_MS - 60_000) / 1000;
  utimesSync(join(dir, name), past, past);
}
/** A `ps` that lists `lines` after this process, as `pid uid args`. */
const ps =
  (lines: string[], self = `${SELF} ${uid} node daemon.js`) =>
  async () =>
    [self, ...lines].join("\n");
const at = (name: string) => `${dir}/${name}/bazhen-holder`;
const empty = async () => "";
const failing = async (): Promise<string> => {
  throw new Error("ps: timed out");
};

describe("pruning old builds", () => {
  it("removes only builds not kept, and what installs moved aside", async () => {
    plant(OLD);
    plant(KEPT);
    plant(`.bad-${OLD}-01234567`);
    expect([(await pruneHolderBuilds(dir, uid, new Set([KEPT]))).toSorted(), ls()]).toEqual([
      [`.bad-${OLD}-01234567`, OLD].toSorted(),
      [KEPT],
    ]);
  });

  it("leaves a build or an install's temporary directory too young to be done with", async () => {
    for (const name of [OLD, KEPT, ".tmp-0123abcd", ".tmp-89abcdef"]) plant(name);
    utimesSync(join(dir, KEPT), new Date(), new Date());
    utimesSync(join(dir, ".tmp-89abcdef"), new Date(), new Date());
    expect([(await pruneHolderBuilds(dir, uid, new Set())).toSorted(), ls()]).toEqual([
      [".tmp-0123abcd", OLD].toSorted(),
      [".tmp-89abcdef", KEPT].toSorted(),
    ]);
  });

  it("unlinks what was moved aside, whatever it is, and follows no link", async () => {
    const outside = join(root, "outside");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    mkdirSync(outside);
    writeFileSync(join(outside, "keep"), "");
    symlinkSync(outside, join(dir, `.bad-${OLD}-01234567`));
    writeFileSync(join(dir, `.bad-${KEPT}-01234567`), "");
    const removed = await pruneHolderBuilds(dir, uid, new Set());
    expect([removed.toSorted(), ls(), readdirSync(outside)]).toEqual([
      [`.bad-${KEPT}-01234567`, `.bad-${OLD}-01234567`].toSorted(),
      [],
      ["keep"],
    ]);
  });

  it("touches nothing it didn't make, whatever its name", async () => {
    const outside = join(root, "outside");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    mkdirSync(outside);
    writeFileSync(join(outside, "keep"), "");
    const past = (Date.now() - FRESH_MS - 60_000) / 1000;
    for (const name of [OLD, ".tmp-0123abcd"]) {
      symlinkSync(outside, join(dir, name));
      lutimesSync(join(dir, name), past, past);
    }
    for (const name of ["notes", "00000000", `${OLD}0`]) {
      mkdirSync(join(dir, name));
      age(name);
    }
    writeFileSync(join(dir, KEPT), "");
    const before = ls();
    expect([await pruneHolderBuilds(dir, uid, new Set()), ls(), readdirSync(outside)]).toEqual([
      [],
      before,
      ["keep"],
    ]);
  });

  it("removes nothing from a directory it would refuse to install in", async () => {
    plant(OLD);
    chmodSync(dir, 0o770);
    expect([await pruneHolderBuilds(dir, uid, new Set()), ls()]).toEqual([[], [OLD]]);
  });
});

describe("the builds in use", () => {
  it("are those some process of this user runs from the directory", async () => {
    const running = await runningBuilds(
      dir,
      uid,
      ps([
        `  77 ${uid} ${at(RUNNING)}`,
        `78 ${uid + 1} ${at(OLD)}`,
        `79 ${uid} vim ${at(OLD)}`,
        `80 ${uid} /usr/bin/sleep 100`,
        "",
      ]),
      SELF,
    );
    expect(running).toEqual(new Set([RUNNING]));
  });

  it("keep their builds and the one just installed, even with no holder on it", async () => {
    const installed = binaryOf(await install());
    age(buildOf("build one"));
    plant(OLD);
    plant(RUNNING);
    const removed = await pruneUnusedHolders(
      dir,
      uid,
      await install(),
      ps([`77 ${uid} ${at(RUNNING)}`]),
      SELF,
    );
    expect([removed, ls(), existsSync(installed)]).toEqual([
      [OLD],
      [buildOf("build one"), RUNNING].toSorted(),
      true,
    ]);
  });

  it("are unknown when ps fails, or doesn't list this process as this user's, and then nothing is removed", async () => {
    plant(OLD);
    const unlisted = ps([`77 ${uid} ${at(RUNNING)}`], `${SELF} ${uid + 1} node daemon.js`);
    expect([
      await runningBuilds(dir, uid, failing, SELF),
      await runningBuilds(dir, uid, unlisted, SELF),
      await runningBuilds(dir, uid, empty, SELF),
      await pruneUnusedHolders(dir, uid, await install(), failing, SELF),
      await pruneUnusedHolders(dir, uid, await install(), empty, SELF),
      ls(),
    ]).toEqual([null, null, null, [], [], [buildOf("build one"), OLD].toSorted()]);
  });

  it("are unknown under a directory ps can't print as it is, and then nothing is removed", async () => {
    const zoe = join(root, "zoë", "holder");
    mkdirSync(join(zoe, OLD), { recursive: true, mode: 0o700 });
    chmodSync(join(root, "zoë"), 0o700);
    const past = (Date.now() - FRESH_MS - 60_000) / 1000;
    utimesSync(join(zoe, OLD), past, past);
    const listed = ps([`77 ${uid} ?/zo??/holder/${OLD}/bazhen-holder`]);
    expect([
      await runningBuilds(zoe, uid, listed, SELF),
      await pruneUnusedHolders(zoe, uid, { installed: null, reason: "" }, listed, SELF),
      readdirSync(zoe),
    ]).toEqual([null, [], [OLD]]);
  });

  it("are unknown under a directory with a backslash, which BSD's ps doubles", async () => {
    const slashed = join(root, "a\\b", "holder");
    mkdirSync(slashed, { recursive: true, mode: 0o700 });
    const listed = ps([`77 ${uid} ${slashed}/${OLD}/bazhen-holder`]);
    expect(await runningBuilds(slashed, uid, listed, SELF)).toBeNull();
  });

  it("are read from the real ps, which lists this process", async () => {
    expect(await runningBuilds(dir, uid)).toEqual(new Set());
  });
});
