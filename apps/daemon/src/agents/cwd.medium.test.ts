import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InvalidDirectory, resolveDirectory } from "./cwd.ts";

let home = "";
afterEach(() => {
  chmodSync(home, 0o700);
  rmSync(home, { recursive: true, force: true });
});

function makeHome(): string {
  home = mkdtempSync(join(tmpdir(), "bz-cwd-"));
  mkdirSync(join(home, "project"));
  writeFileSync(join(home, "notes.txt"), "");
  return home;
}

describe("a launch's directory", () => {
  it("reads a leading ~ as the daemon user's home", () => {
    const h = makeHome();
    expect([resolveDirectory("~", h), resolveDirectory("~/project", h)]).toEqual([
      h,
      join(h, "project"),
    ]);
  });

  it("takes an absolute path as it is", () => {
    const h = makeHome();
    expect(resolveDirectory(join(h, "project"), h)).toBe(join(h, "project"));
  });

  it.each([
    ["project", "is not a full path: start it with / or ~/"],
    ["~/missing", "does not exist"],
    ["~/notes.txt", "is not a directory"],
  ])("refuses %s, saying why in words", (requested, why) => {
    const h = makeHome();
    expect(() => resolveDirectory(requested, h)).toThrow(InvalidDirectory);
    expect(() => resolveDirectory(requested, h)).toThrow(why);
  });

  it("passes on a failure that isn't the path's absence, rather than calling it missing", () => {
    const h = makeHome();
    // A home the daemon can't look into: whatever is inside it can't be checked.
    chmodSync(h, 0o000);
    expect(() => resolveDirectory("~/project", h)).toThrow(
      expect.objectContaining({ code: "EACCES" }),
    );
  });
});
