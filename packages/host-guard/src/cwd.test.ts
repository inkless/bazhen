import { describe, expect, it } from "vitest";
import { parseLsofCwds } from "./cwd.ts";

describe("reading lsof's working directories", () => {
  it("takes each pid's directory, a newline inside one included", () => {
    const out = "p101\0fcwd\0n/Users/a b\0\np202\0fcwd\0n/tmp/line\none\0\n";
    expect(parseLsofCwds(out)).toEqual(
      new Map([
        [101, "/Users/a b"],
        [202, "/tmp/line\none"],
      ]),
    );
  });

  it("drops a directory whose pid isn't one, and keeps the first of a pid's", () => {
    const out = "p1\0n/root\0px\0n/x\0p303\0n/first\0n/second\0";
    expect(parseLsofCwds(out)).toEqual(new Map([[303, "/first"]]));
  });

  it("reads nothing from nothing", () => {
    expect(parseLsofCwds("")).toEqual(new Map());
  });
});
