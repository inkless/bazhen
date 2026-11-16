import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { RoleBook } from "@bazhen/core";
import { describe, expect, it } from "vitest";
import { builtinRoles } from "../roles/roles.ts";
import { daemonPrompts, Prompts } from "./prompts.ts";

const AGENT = "agent_0190c3b2a1d47a3b8c1d2e3f4a5b6c7d";
const tempDir = () => mkdtempSync(join(tmpdir(), "bz-prompts-"));

describe("an agent's prompt", () => {
  it("is the fleet's instructions alone for an agent in no role, or one whose role has gone", () => {
    let book = new RoleBook(builtinRoles());
    const prompts = new Prompts(
      tempDir(),
      "The fleet.",
      () => book,
      () => {},
    );
    const before = prompts.compose("reviewer").hash;
    book = new RoleBook(builtinRoles().filter((r) => r.key !== "reviewer"));
    expect([prompts.compose(null).text, prompts.compose("reviewer").text]).toEqual([
      "The fleet.",
      "The fleet.",
    ]);
    expect(prompts.compose("reviewer").hash).not.toBe(before);
  });

  it("is written over the last one, leaving no partial file beside it", () => {
    const dir = tempDir();
    const prompts = new Prompts(
      dir,
      "The fleet.",
      () => new RoleBook([]),
      () => {},
    );
    prompts.write(AGENT, "first");
    const path = prompts.write(AGENT, "second");
    expect([readFileSync(path, "utf8"), readdirSync(dir)]).toEqual(["second", [`${AGENT}.md`]]);
  });

  it("leaves no partial file when the rename into place fails", () => {
    const dir = tempDir();
    mkdirSync(join(dir, `${AGENT}.md`, "in-the-way"), { recursive: true });
    const prompts = new Prompts(
      dir,
      "f",
      () => new RoleBook([]),
      () => {},
    );
    expect(() => prompts.write(AGENT, "x")).toThrow(/EISDIR|ENOTEMPTY|EEXIST/);
    expect(readdirSync(dir)).toEqual([`${AGENT}.md`]);
  });

  it("makes its directory private before writing, and takes a remove of a file already gone", () => {
    const made: string[] = [];
    const dir = join(tempDir(), "prompts");
    const ensure = (d: string) => (made.push(d), mkdirSync(d, { recursive: true }));
    const prompts = new Prompts(dir, "f", () => new RoleBook([]), ensure);
    prompts.write(AGENT, "x");
    prompts.remove(AGENT);
    expect([made, readdirSync(dir)]).toEqual([[dir], []]);
    expect(() => prompts.remove(AGENT)).not.toThrow();
  });

  it("is kept by the daemon in a directory only its user can reach", () => {
    const run = tempDir();
    const prompts = daemonPrompts(run, userInfo().uid, "f", () => new RoleBook([]));
    const path = prompts.write(AGENT, "x");
    expect([statSync(join(run, "prompts")).mode & 0o777, statSync(path).mode & 0o777]).toEqual([
      0o700, 0o600,
    ]);
  });
});
