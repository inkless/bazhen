import { describe, expect, it, vi } from "vitest";
import {
  type Effects,
  EQUIVALENTS,
  type Equivalent,
  GROUPS,
  type MutantRun,
  equivalentFaults,
  failures,
  groupFilters,
  groupOf,
  main,
  narrowed,
  narrowingFaults,
  nextestSummary,
  parseArgs,
  parseOutcomes,
  partitionFaults,
  refusalUnderTest,
  report,
  rustLiteral,
  selections,
  type Verdict,
  withoutEquivalents,
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

/**
 * Effects for `main` that spawn nothing: a run inside a sandbox on Linux, with `list` as the
 * listing and a mutate and judge that record their calls.
 */
function stubbed(list: Effects["list"], run: Partial<MutantRun> = {}) {
  const mutate = vi.fn<Effects["mutate"]>(async () => ({
    outcomes: [],
    log: () => "",
    diffFile: (o) => `diff/${o.name}`,
    ...run,
  }));
  const judge = vi.fn<Effects["judge"]>(async () => true);
  return {
    sandboxed: () => true,
    list,
    platform: "linux" as const,
    equivalents: [],
    mutate,
    judge,
  };
}

/**
 * A crate of `names` in rest, and a macOS mutant that partitions only into the macos group, so a
 * main without one stops at its partition check: under falsify, the base's main runs these
 * tests with the real cargo-mutants.
 */
function restCrate(names: string[], more: [string, string[]][] = []) {
  const mac = at("macos.rs", "replace parent -> Option<Pid> with None");
  return listingOf(
    new Map([
      ["", [mac, ...names]],
      [groupFilters("macos")[0]!.join(" "), [mac]],
      [groupFilters("rest")[0]!.join(" "), names],
      ...more,
    ]),
  );
}

/** A listing that holds, for each selection in `listings`, its names, and nothing for any other. */
const listingOf = (listings: ReadonlyMap<string, string[]>) => (filters: readonly string[]) =>
  listings.get(filters.join(" ")) ?? [];

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

  it("puts code compiled only on macOS in a group of its own, out of rest", () => {
    expect(groupOf(at("macos.rs", "replace parent -> Option<Pid> with None"))).toBe("macos");
    const [rest] = groupFilters("rest");
    expect(rest).toEqual(
      expect.arrayContaining(["--exclude", "crates/bazhen-holder/src/macos.rs"]),
    );
  });
});

describe("groupFilters", () => {
  it("selects lifecycle as its files and, apart, its server functions by name", () => {
    const [files = [], byName = []] = groupFilters("lifecycle");
    expect(files.slice(0, 2)).toEqual(["--file", "crates/bazhen-holder/src/socket.rs"]);
    const pattern = byName[byName.indexOf("--re") + 1];
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

const loc = (file: string, mutant: string, where = "10:5") =>
  `crates/bazhen-holder/src/${file}:${where}: ${mutant}`;

describe("the classified equivalents", () => {
  const one: Equivalent = {
    re: "^crates/bazhen-holder/src/ring\\.rs:\\d+:\\d+: replace Ring::end -> u64 with [01]$",
    count: 2,
    why: "a reason",
  };

  it("leaves out of every selection of every group each equivalent, and gives each a reason", () => {
    const leftOut = (["signal", "lifecycle", "rest", "macos"] as const).flatMap((group) =>
      groupFilters(group).map((filters) => EQUIVALENTS.every((e) => filters.includes(e.re))),
    );
    expect(leftOut.every(Boolean)).toBe(true);
    expect(EQUIVALENTS.map((e) => e.why)).not.toContain("");
    expect(Math.min(...EQUIVALENTS.map((e) => e.count))).toBeGreaterThan(0);
  });

  it("names a mutant by its function and mutation wherever the line is", () => {
    const name = (line: number) =>
      loc("holder.rs", "replace | with ^ in Holder<O>::master_interest", `${line}:27`);
    const [master] = EQUIVALENTS.filter((e) => new RegExp(e.re).test(name(197)));
    expect(new RegExp(master!.re).test(name(240))).toBe(true);
    expect(
      new RegExp(master!.re).test(
        loc("holder.rs", "replace | with & in Holder<O>::master_interest"),
      ),
    ).toBe(false);
  });

  it("tells two mutants of one kind in a function apart by their column", () => {
    const first = loc("conn.rs", "replace + with * in Connection::requeue_exited", "532:30");
    const second = loc("conn.rs", "replace + with * in Connection::requeue_exited", "539:61");
    expect(withoutEquivalents([first, second], EQUIVALENTS)).toEqual([second]);
  });

  it("takes out of a listing the mutants they name, and no other", () => {
    const kept = loc("ring.rs", "replace Ring::end -> u64 with 2");
    const left = [
      loc("ring.rs", "replace Ring::end -> u64 with 0"),
      loc("ring.rs", "replace Ring::end -> u64 with 1"),
    ];
    expect(withoutEquivalents([...left, kept], [one])).toEqual([kept]);
  });

  it("names an equivalent that now names more or fewer mutants than it was classed for", () => {
    const names = [loc("ring.rs", "replace Ring::end -> u64 with 0")];
    expect(equivalentFaults(names, [one])).toEqual([
      `the equivalent ${one.re} names 1 mutants, not the 2 it was classed for`,
    ]);
    expect(
      equivalentFaults([...names, loc("ring.rs", "replace Ring::end -> u64 with 1")], [one]),
    ).toEqual([]);
  });
});

describe("partitionFaults", () => {
  const all = [at("guard.rs", "a"), at("socket.rs", "b"), at("ring.rs", "c")];

  it("finds nothing wrong with listings that partition the mutants as groupOf does", () => {
    expect(
      partitionFaults(all, {
        signal: [all[0]!],
        lifecycle: [all[1]!],
        rest: [all[2]!],
        macos: [],
      }),
    ).toEqual([]);
  });

  it("names a mutant in no group, one in two, and one in the wrong group", () => {
    expect(
      partitionFaults(all, {
        signal: [all[0]!, all[2]!],
        lifecycle: [all[0]!],
        rest: [],
        macos: [],
      }),
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

describe("report, of a run narrowed by --only", () => {
  it("lists each mutant caught with what failed on it", () => {
    const name = at("ring.rs", "replace Ring::end -> u64 with 0");
    const outcomes = parseOutcomes({ outcomes: [outcome("CaughtMutant", name)] });
    const caught = new Map([[name, ["bazhen-holder ring::tests::wraps", "ring.rs:9:5: boom"]]]);
    expect(report("rest", outcomes, new Map(), new Map(), caught)).toEqual([
      "holder-mutants: rest: 1 mutants, 6.5 s of build and Rust tests each",
      `caught\t${name}`,
      "\tbazhen-holder ring::tests::wraps",
      "\tring.rs:9:5: boom",
      "holder-mutants: rest: caught 1",
    ]);
  });

  it("says so when it finds no failing test for a mutant caught, rather than name none", () => {
    const name = at("ring.rs", "replace Ring::end -> u64 with 0");
    const outcomes = parseOutcomes({ outcomes: [outcome("CaughtMutant", name)] });
    expect(report("rest", outcomes, new Map(), new Map(), new Map([[name, []]]))).toContain(
      "\t(no failing test found)",
    );
  });
});

describe("failures", () => {
  it("names each test nextest says failed once, then where each panicked and why", () => {
    const log = [
      "        PASS [   0.010s] (  1/230) bazhen-holder ring::tests::keeps",
      "        FAIL [   0.004s] (  2/230) bazhen-holder ring::tests::wraps",
      "──── STDERR:             bazhen-holder ring::tests::wraps",
      "",
      "thread 'ring::tests::wraps' panicked at crates/bazhen-holder/src/ring.rs:120:9:",
      "assertion `left == right` failed",
      "  left: 1",
      "     TIMEOUT [  60.001s] bazhen-holder::binary socket::rebinds",
      "     Summary [  61.000s] 230 tests run: 228 passed, 1 failed, 1 timed out, 0 skipped",
      "        FAIL [   0.004s] bazhen-holder ring::tests::wraps",
    ].join("\n");
    expect(failures(log)).toEqual([
      "bazhen-holder ring::tests::wraps",
      "bazhen-holder::binary socket::rebinds",
      "crates/bazhen-holder/src/ring.rs:120:9: assertion `left == right` failed",
    ]);
  });

  it("reads a log nextest wrote in colour", () => {
    const esc = String.fromCharCode(0x1b);
    const log = `        ${esc}[31;1mFAIL${esc}[0m [   0.004s] ${esc}[35;1mbazhen-holder${esc}[0m ring::tests::wraps\n`;
    expect(failures(log)).toEqual(["bazhen-holder ring::tests::wraps"]);
  });

  it("finds nothing in a log where every test passed", () => {
    expect(failures("        PASS [   0.010s] bazhen-holder ring::tests::keeps\n")).toEqual([]);
  });
});

describe("narrowing a group to some of its mutants", () => {
  const names = [
    at("process.rs", "replace procargs2_split -> Option<(Vec<&[u8]>, &[u8])> with None"),
    at("ring.rs", "replace += with -= in Ring::push"),
    at("start.rs", "delete ! in run"),
  ];

  it("matches each name whole and nothing else, whatever regex syntax it holds", () => {
    const pattern = new RegExp(`^(?:${names.map(rustLiteral).join("|")})$`);
    expect(names.map((n) => pattern.test(n))).toEqual([true, true, true]);
    expect(pattern.test(`${names[1]} `)).toBe(false);
    expect(pattern.test(names[1]!.replace("+=", "x="))).toBe(false);
  });

  it("replaces a selection's --re, which would widen it, and its files by the names' own, keeping its exclusions", () => {
    expect(
      narrowed(
        ["--file", "a.rs", "--exclude", "b.rs", "--re", "^old", "--exclude-re", "skip"],
        [names[2]!, names[1]!, at("start.rs", "replace run with ()")],
      ),
    ).toEqual([
      "--exclude",
      "b.rs",
      "--exclude-re",
      "skip",
      "--file",
      "crates/bazhen-holder/src/start.rs",
      "--file",
      "crates/bazhen-holder/src/ring.rs",
      "--re",
      `^(?:${[names[2]!, names[1]!, at("start.rs", "replace run with ()")].map(rustLiteral).join("|")})$`,
    ]);
  });

  it("finds a mutant listed beyond the names, as a struct-field deletion is, and a name not listed", () => {
    const deletion = at("ring.rs", "delete field end from struct Ring expression in Ring::new");
    expect(narrowingFaults(names, names)).toEqual([]);
    expect(narrowingFaults(names.slice(1), [...names.slice(0, 2), deletion])).toEqual([
      `${names[0]} is listed though --only doesn't name it: cargo-mutants lists a struct-field deletion whatever --re says, so name it in --only too`,
      `${deletion} is listed though --only doesn't name it: cargo-mutants lists a struct-field deletion whatever --re says, so name it in --only too`,
      `${names[2]} is named but not listed`,
    ]);
  });

  it("narrows each of a group's selections to what it lists of the names, and drops a selection with none", () => {
    const flush = at("conn.rs", "replace Connection::flush with ()");
    const [files = "", inServer = ""] = groupFilters("lifecycle").map((f) => f.join(" "));
    const listings = new Map([
      [files, [at("socket.rs", "replace Socket::rebind with ()")]],
      [inServer, [flush]],
    ]);
    const [byName, ...others] = selections("lifecycle", /Connection::flush/, listingOf(listings));
    expect(others).toEqual([]);
    expect(byName).toEqual(narrowed(groupFilters("lifecycle")[1]!, [flush]));
    expect(byName).toEqual(expect.arrayContaining(["--file", "crates/bazhen-holder/src/conn.rs"]));
  });

  it("leaves the group's selections as they are without --only", () => {
    expect(selections("rest", undefined, () => [])).toEqual(groupFilters("rest"));
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

  it("takes --only as a regex of mutant names, and refuses it with none", () => {
    expect(parseArgs(["--group", "rest", "--only", "ring\\.rs:1[0-9]:"]).only).toEqual(
      /ring\.rs:1[0-9]:/,
    );
    expect(() => parseArgs(["--group", "rest", "--only"])).toThrow("--only takes");
  });
});

describe("main", () => {
  it("refuses off a sandbox before it lists or builds anything", async () => {
    const effects = { ...stubbed(vi.fn(() => [])), sandboxed: () => false };
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await main(["--group", "signal"], effects)).toBe(1);
    expect(effects.list).not.toHaveBeenCalled();
    expect(effects.mutate).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("refusing to run here"));
    error.mockRestore();
  });

  it("stops before mutating when an equivalent no longer names the mutants it was classed for", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const gone: Equivalent = { re: "^nothing$", count: 1, why: "a reason" };
    const effects = {
      ...stubbed(restCrate([at("ring.rs", "replace Ring::end -> u64 with 0")])),
      equivalents: [gone],
    };

    expect(await main(["--group", "rest"], effects)).toBe(1);
    expect(effects.mutate).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("names 0 mutants, not the 1"));
    error.mockRestore();
  });

  it("stops before mutating when the groups don't partition what cargo-mutants lists", async () => {
    const stray = at("ring.rs", "replace Ring::end -> u64 with 0");
    const effects = stubbed(unfilteredOnly([stray]));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await main(["--group", "signal"], effects)).toBe(1);
    expect(effects.mutate).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining(`${stray} is in no group`));
    error.mockRestore();
  });

  it("refuses the macOS group anywhere its code isn't compiled, before it lists anything", async () => {
    const effects = stubbed(vi.fn(() => []));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await main(["--group", "macos"], effects)).toBe(1);
    expect(effects.list).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("compiled only on darwin"));
    error.mockRestore();
  });

  it("stops before mutating when --only names no mutant of the group", async () => {
    const effects = stubbed(restCrate([at("ring.rs", "replace Ring::end -> u64 with 0")]));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await main(["--group", "rest", "--only", "nothing"], effects)).toBe(1);
    expect(effects.mutate).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("names no mutant of rest"));
    error.mockRestore();
  });

  it("stops before mutating when a narrowed selection lists a mutant --only doesn't name", async () => {
    const named = at("ring.rs", "replace Ring::end -> u64 with 0");
    const deletion = at("ring.rs", "delete field end from struct Ring expression in Ring::new");
    const narrowedListing = narrowed(groupFilters("rest")[0]!, [named]).join(" ");
    const effects = stubbed(restCrate([named], [[narrowedListing, [named, deletion]]]));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await main(["--group", "rest", "--only", "Ring::end"], effects)).toBe(1);
    expect(effects.mutate).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining(`${deletion} is listed though --only doesn't name it`),
    );
    error.mockRestore();
  });

  it("mutates through the runner it is given, and judges each mutant missed by the holder suite", async () => {
    const caughtName = at("ring.rs", "replace Ring::end -> u64 with 0");
    const missedName = at("ring.rs", "replace Ring::start -> u64 with 0");
    const summary = "Summary [   1.000s] 2 tests run: 2 passed, 0 skipped";
    const effects = stubbed(restCrate([caughtName, missedName]), {
      outcomes: parseOutcomes({
        outcomes: [
          baseline(),
          outcome("CaughtMutant", caughtName),
          outcome("MissedMutant", missedName),
        ],
      }),
      log: () => summary,
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await main(["--group", "rest", "--shard", "1/9"], effects)).toBe(0);
    expect(effects.mutate.mock.calls).toEqual([[groupFilters("rest")[0], "1/9", 2]]);
    expect(effects.judge.mock.calls).toEqual([
      ["crates/bazhen-holder/src/ring.rs", `diff/${missedName}`],
    ]);
    expect(log.mock.calls.map(([line]) => line)).toEqual([
      "holder-mutants: rest: 2 mutants, 6.5 s of build and Rust tests each",
      `suite\t${missedName}\t${summary}`,
      "holder-mutants: rest: caught 1, suite 1",
    ]);
    log.mockRestore();
  });

  it("narrowed by --only, mutates just the names and prints what failed on each caught", async () => {
    const named = at("ring.rs", "replace Ring::end -> u64 with 0");
    const other = at("ring.rs", "replace Ring::start -> u64 with 0");
    const narrowedFilters = narrowed(groupFilters("rest")[0]!, [named]);
    const effects = stubbed(restCrate([named, other], [[narrowedFilters.join(" "), [named]]]), {
      outcomes: parseOutcomes({ outcomes: [outcome("CaughtMutant", named)] }),
      log: () => "        FAIL [   0.004s] bazhen-holder ring::tests::ends\n",
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await main(["--group", "rest", "--only", "Ring::end"], effects)).toBe(0);
    expect(effects.mutate.mock.calls).toEqual([[narrowedFilters, undefined, 2]]);
    expect(log.mock.calls.map(([line]) => line)).toContain("\tbazhen-holder ring::tests::ends");
    log.mockRestore();
  });
});

describe("refusalUnderTest", () => {
  it("refuses a real run of mutants inside a test run, and allows one outside", () => {
    expect(refusalUnderTest({ VITEST: "true" })).toContain("under a test");
    expect(refusalUnderTest({})).toBeUndefined();
  });

  it("is in force in this very test run", () => {
    expect(refusalUnderTest(process.env)).toContain("under a test");
  });
});
