import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { RoleProblem } from "@bazhen/protocol";
import { describe, expect, it } from "vitest";
import { builtinRoles, Roles } from "./roles.ts";

const tempDir = () => mkdtempSync(join(tmpdir(), "bz-roles-"));

describe("the shipped roles", () => {
  it("all parse, and grant as the fleet's roles do: coordinator down to lead, lead to worker", () => {
    const rules = builtinRoles().map((r) => [r.key, r.grants, r.singlePerTask, r.maxActiveTasks]);
    expect(rules).toEqual([
      ["coordinator", ["lead", "worker", "reviewer"], true, null],
      ["lead", ["worker", "reviewer"], true, null],
      ["worker", [], false, 1],
      ["reviewer", [], false, null],
    ]);
  });
});

describe("the roles in force", () => {
  it("are the built-ins when the user has no roles directory", () => {
    const roles = new Roles(join(tempDir(), "missing"));
    expect(roles.current().book.roles.map((r) => r.source)).toEqual(Array(4).fill("builtin"));
  });

  it("picks up a new file, an edit and a removal at the next use, with no restart", () => {
    const dir = tempDir();
    const roles = new Roles(dir, builtinRoles(), () => {});
    const worker = join(dir, "worker.md");
    writeFileSync(worker, "---\ntitle: Builder\n---\nBuild it.\n");
    expect(roles.current().book.get("worker")?.title).toBe("Builder");
    writeFileSync(worker, "---\ntitle: Maker of things\n---\nBuild it.\n");
    expect(roles.current().book.get("worker")?.title).toBe("Maker of things");
    rmSync(worker);
    expect(roles.current().book.get("worker")?.source).toBe("builtin");
  });

  it("reports a bad file once, skips it, and keeps the built-in of its key", () => {
    const dir = tempDir();
    const reported: RoleProblem[] = [];
    const roles = new Roles(dir, builtinRoles(), (p) => reported.push(p));
    writeFileSync(join(dir, "lead.md"), "---\ntitle: Lead\ngrants: [ghost]\n---\nLead.\n");
    const first = roles.current();
    roles.current();
    expect(first.book.get("lead")?.source).toBe("builtin");
    expect(reported).toEqual([
      { file: join(basename(dir), "lead.md"), problem: "grants ghost, which no role defines" },
    ]);
    expect(first.problems).toEqual(reported);
  });

  it("refuses what isn't a regular file without waiting on it, and reads a symlinked one", () => {
    const dir = tempDir();
    const target = join(tempDir(), "mine.md");
    writeFileSync(target, "---\ntitle: Mine\n---\nMine.\n");
    symlinkSync(target, join(dir, "mine.md"));
    symlinkSync("/dev/zero", join(dir, "zero.md"));
    execFileSync("mkfifo", [join(dir, "fifo.md")]);
    const { book, problems } = new Roles(dir, builtinRoles(), () => {}).current();
    expect(book.get("mine")?.title).toBe("Mine");
    expect(problems.map((p) => [p.file, p.problem])).toEqual([
      [join(basename(dir), "fifo.md"), "it isn't a regular file"],
      [join(basename(dir), "zero.md"), "it isn't a regular file"],
    ]);
  });

  it("refuses a file longer than a role file is", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "big.md"), `---\ntitle: Big\n---\n${"x".repeat(70 * 1024)}\n`);
    const { problems } = new Roles(dir, builtinRoles(), () => {}).current();
    expect(problems.map((p) => p.problem)).toEqual([
      "it is over 65536 bytes, longer than a role file is",
    ]);
  });
});
