import { describe, expect, it } from "vitest";
import { LIST, listed, problems, removed } from "./rust-daemon.ts";

const isThere = (file: string) => file !== "tests/api/gone.test.ts";

describe("the Rust daemon's list of api test files", () => {
  it("names one file a line, past blank lines and comments", () => {
    expect(listed("# passes on both\ntests/api/a.test.ts\n\n  tests/api/b.test.ts  \n")).toEqual([
      "tests/api/a.test.ts",
      "tests/api/b.test.ts",
    ]);
  });

  it("refuses a file twice, one that isn't an api test file, and one that isn't there", () => {
    expect(
      problems(
        [
          "tests/api/a.test.ts",
          "tests/api/a.test.ts",
          "tests/api/daemon.ts",
          "tests/integration/x.test.ts",
          "tests/api/gone.test.ts",
        ],
        isThere,
      ),
    ).toEqual([
      `${LIST} names tests/api/a.test.ts twice`,
      `${LIST} names tests/api/daemon.ts, which isn't a tests/api/*.test.ts file`,
      `${LIST} names tests/integration/x.test.ts, which isn't a tests/api/*.test.ts file`,
      `${LIST} names tests/api/gone.test.ts, which doesn't exist`,
    ]);
  });

  it("finds each file the base named that the branch dropped, and none it added", () => {
    expect(removed(["a", "b", "c"], ["a", "c", "d"])).toEqual(["b"]);
    expect(removed([], ["a"])).toEqual([]);
  });
});
