import { describe, expect, it, vi } from "vitest";
import {
  GROUPS,
  groupFilters,
  groupOf,
  main,
  nextestSummary,
  parseArgs,
  parseOutcomes,
  partitionFaults,
  report,
  type Verdict,
} from "./holder-mutants.ts";

const at = (file: string, what: string) => `crates/bazhen-holder/src/${file}:10:5: ${what}`;

const outcome = (summary: string, name = at("ring.rs", "replace Ring::end -> u64 with 0")) => ({
  scenario: { Mutant: { name, file: "crates/bazhen-holder/src/ring.rs" } },
  summary,
  diff_path: "diff/ring.rs_line_10_col_5.diff",
  log_path: "log/ring.rs_line_10_col_5.log",
  phase_results: [{ duration: 2.5 }, { duration: 4 }],
});
const baseline = (summary = "Success") => ({ scenario: "Baseline", summary });

/** A listing that holds `names` unfiltered and nothing for any group's filters. */
const unfilteredOnly = (names: string[]) => (filters: readonly string[]) =>
  filters.length === 0 ? names : [];

describe("groupOf", () => {
  it("puts every mutant of a file that signals in the signal group", () => {
    expect(GROUPS.signal.files.map((file) => groupOf(at(file, "replace kill with ()")))).toEqual(
      GROUPS.signal.files.map(() => "signal"),
    );
  });

  it("puts a mutant of the server's close or a connection's drop in lifecycle, and the rest of the server in rest", () => {
    expect(
      [
        at("server.rs", "replace Server::close_done -> bool with true"),
        at("conn.rs", "replace Connection::drop_now with ()"),
        at("server.rs", "replace < with <= in evicting_at"),
        at("socket.rs", "replace Socket::rebind with ()"),
        at("server.rs", "replace subscribe with ()"),
        at("conn.rs", "replace Connection::queue_state with ()"),
      ].map(groupOf),
    ).toEqual(["lifecycle", "lifecycle", "lifecycle", "lifecycle", "rest", "rest"]);
  });

  it("doesn't take a server function whose name only starts like a lifecycle one", () => {
    expect(groupOf(at("server.rs", "replace Server::turnover with ()"))).toBe("rest");
  });
});

describe("groupFilters", () => {
  it("selects lifecycle as its files and, apart, its server functions by name", () => {
    const [files, byName = []] = groupFilters("lifecycle");
    expect(files).toEqual(["--file", "crates/bazhen-holder/src/socket.rs"]);
    const pattern = byName.at(-1);
    expect(byName.at(-2)).toBe("--re");
    expect(
      new RegExp(String(pattern)).test(at("conn.rs", "replace Connection::flush with ()")),
    ).toBe(true);
  });

  it("selects lifecycle's functions within their files, as --re lets a field deletion anywhere through", () => {
    const [, byName] = groupFilters("lifecycle");
    expect(byName?.slice(0, 4)).toEqual([
      "--file",
      "crates/bazhen-holder/src/server.rs",
      "--file",
      "crates/bazhen-holder/src/conn.rs",
    ]);
  });

  it("keeps out of rest every file and function another group takes", () => {
    const [rest] = groupFilters("rest");
    expect(rest).toEqual(
      expect.arrayContaining(["--exclude", "crates/bazhen-holder/src/guard.rs"]),
    );
    expect(rest).toEqual(
      expect.arrayContaining(["--exclude", "crates/bazhen-holder/src/socket.rs"]),
    );
    expect(rest).toContain("--exclude-re");
  });
});

describe("partitionFaults", () => {
  const all = [at("guard.rs", "a"), at("socket.rs", "b"), at("ring.rs", "c")];

  it("finds nothing wrong with listings that partition the mutants as groupOf does", () => {
    expect(
      partitionFaults(all, { signal: [all[0]!], lifecycle: [all[1]!], rest: [all[2]!] }),
    ).toEqual([]);
  });

  it("names a mutant in no group, one in two, and one in the wrong group", () => {
    expect(
      partitionFaults(all, { signal: [all[0]!, all[2]!], lifecycle: [all[0]!], rest: [] }),
    ).toEqual([
      `${all[2]} is listed in signal, not rest`,
      `${all[0]} is in signal and lifecycle`,
      `${all[0]} is listed in lifecycle, not signal`,
      `${all[1]} is in no group`,
    ]);
  });
});

describe("parseOutcomes", () => {
  it("reads each mutant's outcome, its diff and how long it took, leaving the baseline out", () => {
    expect(parseOutcomes({ outcomes: [baseline(), outcome("MissedMutant")] })).toEqual([
      {
        name: at("ring.rs", "replace Ring::end -> u64 with 0"),
        file: "crates/bazhen-holder/src/ring.rs",
        summary: "missed",
        diffPath: "diff/ring.rs_line_10_col_5.diff",
        logPath: "log/ring.rs_line_10_col_5.log",
        seconds: 6.5,
      },
    ]);
  });

  it("refuses a run whose baseline failed, which would read as every mutant caught", () => {
    expect(() =>
      parseOutcomes({ outcomes: [baseline("Failure"), outcome("CaughtMutant")] }),
    ).toThrow("the baseline didn't pass");
  });

  it("refuses an outcome it doesn't know, rather than count it as anything", () => {
    expect(() => parseOutcomes({ outcomes: [outcome("Exploded")] })).toThrow("can't read");
    expect(() => parseOutcomes({ results: [] })).toThrow("no outcomes");
  });
});

describe("report", () => {
  it("lists each mutant the Rust tests missed with what the holder suite made of it, then the counts", () => {
    const missed = at("conn.rs", "replace Connection::flush with ()");
    const outcomes = parseOutcomes({
      outcomes: [outcome("CaughtMutant"), outcome("MissedMutant", missed), outcome("Unviable")],
    });
    const verdicts = new Map<string, Verdict>([[missed, "suite"]]);
    const ran = new Map([[missed, "Summary [ 9.1s] 120 tests run: 120 passed, 0 skipped"]]);
    expect(report("lifecycle", outcomes, verdicts, ran)).toEqual([
      "holder-mutants: lifecycle: 3 mutants, 6.5 s of build and Rust tests each",
      `suite\t${missed}\tSummary [ 9.1s] 120 tests run: 120 passed, 0 skipped`,
      "holder-mutants: lifecycle: caught 1, suite 1, unviable 1",
    ]);
  });
});

describe("nextestSummary", () => {
  it("finds the last line where nextest says how many tests it ran and skipped", () => {
    const log = [
      "    Starting 120 tests across 9 binaries (35 tests skipped)",
      "        PASS [   0.010s] bazhen-holder ring::tests::wraps",
      "     Summary [   9.120s] 120 tests run: 120 passed, 35 skipped",
      "",
    ].join("\n");
    expect(nextestSummary(log)).toBe("Summary [   9.120s] 120 tests run: 120 passed, 35 skipped");
  });

  it("says nothing of a log in which nextest never summed up", () => {
    expect(nextestSummary("error: could not compile `bazhen-holder`\n")).toBeNull();
  });
});

describe("parseArgs", () => {
  it("takes a group, a shard and a job count", () => {
    expect(parseArgs(["--group", "signal", "--shard", "0/4", "--jobs", "3"])).toEqual({
      group: "signal",
      shard: "0/4",
      jobs: 3,
    });
  });

  it("refuses a group it doesn't have, and a shard that isn't k/n", () => {
    expect(() => parseArgs(["--group", "everything"])).toThrow("usage");
    expect(() => parseArgs(["--group", "rest", "--shard", "half"])).toThrow("k/n");
  });
});

describe("main", () => {
  it("refuses off a sandbox before it lists or builds anything", async () => {
    const list = vi.fn<(filters: readonly string[]) => string[]>(() => []);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await main(["--group", "signal"], { sandboxed: () => false, list })).toBe(1);
    expect(list).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("refusing to run here"));
    error.mockRestore();
  });

  it("stops before mutating when the groups don't partition what cargo-mutants lists", async () => {
    const stray = at("ring.rs", "replace Ring::end -> u64 with 0");
    const list = vi.fn<(filters: readonly string[]) => string[]>(unfilteredOnly([stray]));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await main(["--group", "signal"], { sandboxed: () => true, list })).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining(`${stray} is in no group`));
    error.mockRestore();
  });
});
