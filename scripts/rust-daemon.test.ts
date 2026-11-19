import { describe, expect, it } from "vitest";
import {
  DAEMON_BIN,
  type Git,
  LIST,
  baseList,
  isReport,
  listed,
  main,
  problems,
  removed,
  type Report,
  unrun,
  type World,
} from "./rust-daemon.ts";

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

  it("takes a file git saw renamed, and listed by its new name, as still listed", () => {
    const renamed = new Map([
      ["a", "a2"],
      ["b", "b2"],
    ]);
    expect(removed(["a", "b", "c"], ["a2", "c"], renamed)).toEqual(["b"]);
  });
});

const ok = (stdout = "") => ({ status: 0, stdout });

/** A git that knows `commits`, each with its list's text or none. */
function fakeGit(commits: Record<string, string | undefined>, renames = ""): Git {
  return (args) => {
    const [verb, ...rest] = args;
    const ref =
      verb === "rev-parse"
        ? rest.at(-1)?.replace("^{commit}", "")
        : verb === "ls-tree"
          ? rest[1]
          : rest[0]?.split(":")[0];
    if (verb === "diff") return ok(renames);
    if (ref === undefined || !(ref in commits)) return { status: 128, stdout: "" };
    if (verb === "rev-parse") return ok(ref);
    const list = commits[ref];
    if (verb === "ls-tree") return ok(list === undefined ? "" : `${LIST}\n`);
    if (verb === "show" && list !== undefined) return ok(list);
    return { status: 128, stdout: "" };
  };
}

describe("the base's list", () => {
  it("is what the base commit's list names", () => {
    expect(baseList("main", fakeGit({ main: "tests/api/a.test.ts\n" }))).toEqual([
      "tests/api/a.test.ts",
    ]);
  });

  it("names nothing at a commit from before the list", () => {
    expect(baseList("old", fakeGit({ old: undefined }))).toEqual([]);
  });

  it("is an error, never an empty list, at a ref that isn't a commit", () => {
    expect(baseList("typo", fakeGit({ main: "x\n" }))).toEqual({
      error: "the base typo isn't a commit here: fetch it, or name another",
    });
  });
});

const A = "tests/api/a.test.ts";
const B = "tests/api/b.test.ts";

function report(entries: Record<string, readonly string[]>): Report {
  return {
    testResults: Object.entries(entries).map(([file, statuses]) => ({
      name: `/repo/${file}`,
      assertionResults: statuses.map((status, i) => ({ fullName: `t${i}`, status })),
    })),
  };
}

describe("a listed file's run", () => {
  it("reads vitest's JSON report, and nothing shaped otherwise, as one", () => {
    expect([
      isReport(report({ [A]: ["passed"] })),
      isReport({ testResults: [{ name: A }] }),
      isReport({ testResults: [{ name: A, assertionResults: [{ fullName: "t" }] }] }),
      isReport(null),
    ]).toEqual([true, false, false, false]);
  });

  it("passes when every test of every listed file ran", () => {
    expect(unrun([A, B], report({ [A]: ["passed"], [B]: ["passed", "failed"] }), "/repo")).toEqual(
      [],
    );
  });

  it("fails a file that ran no test, or that vitest never reported", () => {
    expect(unrun([A, B], report({ [A]: [] }), "/repo")).toEqual([
      `${A} ran no test against the Rust daemon`,
      `${B} ran no test against the Rust daemon`,
    ]);
  });

  it("fails each test skipped, to do, or otherwise not run", () => {
    expect(unrun([A], report({ [A]: ["passed", "skipped", "todo", "pending"] }), "/repo")).toEqual([
      `${A} › t1 was skipped: a listed file runs every test it has`,
      `${A} › t2 was todo: a listed file runs every test it has`,
      `${A} › t3 was pending: a listed file runs every test it has`,
    ]);
  });
});

/** `main` with `args` in a world of `git`, a list of `list`, and a run that reports `ran`. */
function mainIn(
  args: string[],
  git: Git,
  ran: { status: number; report?: Report } = { status: 0, report: report({ [A]: ["passed"] }) },
  list = `${A}\n`,
): { code: number; said: string[]; runs: number } {
  const said: string[] = [];
  let runs = 0;
  const world: World = {
    read: () => list,
    exists: (file) => file === A || file === B || file === DAEMON_BIN,
    git,
    run: () => {
      runs += 1;
      return ran;
    },
    error: (line) => said.push(line),
  };
  return { code: main(args, world, "/repo"), said, runs };
}

describe("the ratchet's run", () => {
  it("runs the list and passes when the base's list is no longer", () => {
    expect(mainIn(["--base", "main"], fakeGit({ main: `${A}\n` }))).toEqual({
      code: 0,
      said: [],
      runs: 1,
    });
  });

  it("fails before running anything when the base doesn't resolve", () => {
    expect(mainIn(["--base", "origin/typo"], fakeGit({ main: `${A}\n` }))).toEqual({
      code: 1,
      said: ["the base origin/typo isn't a commit here: fetch it, or name another"],
      runs: 0,
    });
  });

  it("fails a list that lost a line against the base, unless git saw that file renamed", () => {
    const base = fakeGit({ main: `${A}\n${B}\n` });
    expect(mainIn(["--base", "main"], base)).toEqual({
      code: 1,
      said: [`${LIST} lost ${B} against main: a file leaves it only at the cutover`],
      runs: 0,
    });
    const moved = fakeGit(
      { main: `tests/api/old.test.ts\n` },
      `R090\ttests/api/old.test.ts\t${A}\n`,
    );
    expect(mainIn(["--base", "main"], moved).code).toEqual(0);
  });

  it("fails a run that left a listed test unrun, or wrote no report, whatever vitest exited", () => {
    const git = fakeGit({});
    expect(mainIn([], git, { status: 0, report: report({ [A]: ["skipped"] }) })).toEqual({
      code: 1,
      said: [`${A} › t0 was skipped: a listed file runs every test it has`],
      runs: 1,
    });
    expect(mainIn([], git, { status: 0 })).toEqual({
      code: 1,
      said: ["vitest wrote no report"],
      runs: 1,
    });
  });

  it("exits as vitest did when every listed test ran", () => {
    expect(mainIn([], fakeGit({}), { status: 1, report: report({ [A]: ["failed"] }) }).code).toBe(
      1,
    );
  });
});
