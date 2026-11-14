// What falsify reads from cargo-mutants and nextest when it judges new Rust tests by mutating the
// code the branch changed (scripts/falsify.ts). Every parser throws on output it doesn't
// recognise, so a run that went wrong never reads as "no mutants" or "nothing failed".

export type Mutant = { name: string; file: string; patch: string };
export type LineSpan = { file: string; start: number; end: number };
export type RustTest = { file: string; title: string };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

function entries(listing: unknown): Record<string, unknown>[] {
  if (!Array.isArray(listing)) throw new Error("not a cargo-mutants listing: not an array");
  return listing.map((entry: unknown) => {
    if (
      !isObject(entry) ||
      typeof entry["name"] !== "string" ||
      typeof entry["file"] !== "string"
    ) {
      throw new Error("not a cargo-mutants listing: a mutant has no name or file");
    }
    return entry;
  });
}

/**
 * The mutants of `cargo mutants --list --json --diff`, each with a patch `git apply` takes: the
 * listing's own diff names the mutant where a file name belongs.
 */
export function parseMutants(listing: unknown): Mutant[] {
  return entries(listing).map((entry) => {
    const name = String(entry["name"]);
    const file = String(entry["file"]);
    const diff = entry["diff"];
    const body =
      typeof diff === "string" ? /^--- [^\n]*\n\+\+\+ [^\n]*\n(@@[\s\S]*)$/.exec(diff) : null;
    if (body?.[1] === undefined)
      throw new Error(`not a cargo-mutants listing: ${name} has no diff`);
    return { name, file, patch: `--- a/${file}\n+++ b/${file}\n${body[1]}` };
  });
}

/**
 * The libtest name prefix of each test binary in a `cargo nextest list --message-format json`
 * report (`<package>::<binary name>`), mapped to the target falsify names its tests by: the binary
 * id less any `::bin/<name>`. A prefix two targets share maps to neither, so a result is never
 * credited to a test it may not belong to.
 */
export function libtestTargets(report: unknown): Map<string, string> {
  const suites = isObject(report) ? report["rust-suites"] : undefined;
  if (!isObject(suites)) throw new Error("not a nextest list report: no rust-suites");
  const targets = new Map<string, string | undefined>();
  for (const [binary, suite] of Object.entries(suites)) {
    const pkg = isObject(suite) ? suite["package-name"] : undefined;
    const name = isObject(suite) ? suite["binary-name"] : undefined;
    if (typeof pkg !== "string" || typeof name !== "string") {
      throw new Error(`not a nextest list report: ${binary} has no package or binary name`);
    }
    const prefix = `${pkg}::${name}`;
    const target = binary.replace(/::bin\/.*$/, "");
    targets.set(prefix, targets.has(prefix) && targets.get(prefix) !== target ? undefined : target);
  }
  return new Map([...targets].filter((entry): entry is [string, string] => entry[1] !== undefined));
}

const PANIC = /\bpanicked at /;
const LOCATION = /([\w./-]+\.rs):(\d+):\d+/g;

export type TestEvent = { test: string; event: string; stdout: string };

/**
 * Each test's result in the output of a nextest `--message-format libtest-json-plus` run, the test
 * named `<target> <test path>`. Suite events carry no name, and a result from a binary whose prefix
 * maps to no target is dropped.
 */
export function testEvents(output: string, targets: Map<string, string>): TestEvent[] {
  const events: TestEvent[] = [];
  for (const line of output.split("\n")) {
    if (!line.startsWith("{")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(parsed) || typeof parsed["name"] !== "string") continue;
    const name = parsed["name"];
    const split = name.indexOf("$");
    const target = split < 0 ? undefined : targets.get(name.slice(0, split));
    if (target === undefined || typeof parsed["event"] !== "string") continue;
    const stdout = typeof parsed["stdout"] === "string" ? parsed["stdout"] : "";
    events.push({ test: `${target} ${name.slice(split + 1)}`, event: parsed["event"], stdout });
  }
  return events;
}

/** Where a line of a mutated file was before the mutant, or undefined for a line the mutant wrote. */
export type Unmutate = (file: string, line: number) => number | undefined;

const HUNK = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm;

/**
 * Maps a line of the file `patch` mutates back to the line it was before: a mutant that replaces
 * a function's body moves every later line, and product spans are read from the unmutated file.
 * A line inside a hunk is the mutant's own.
 */
export function unmutate(patch: string, file: string): Unmutate {
  const hunks = [...patch.matchAll(HUNK)].map(([, oldCount, newStart, newCount]) => ({
    oldCount: Number(oldCount ?? 1),
    newStart: Number(newStart),
    newCount: Number(newCount ?? 1),
  }));
  return (at, line) => {
    if (at !== file) return line;
    let shift = 0;
    for (const h of hunks) {
      if (line < h.newStart) break;
      if (line < h.newStart + h.newCount) return undefined;
      shift += h.oldCount - h.newCount;
    }
    return line + shift;
  };
}

const INTEGRATION_TEST = /^crates\/[^/]+\/tests\//;

/**
 * Whether a line starts at column 0 and isn't part of the item above it: rustfmt indents an
 * item's body, and puts at column 0 only its closing brace and a wrapped signature's `)`, `where`
 * and opening `{`.
 */
const startsAnItem = (line: string) => /^[^\s)]/.test(line) && !/^(?:where\b|\{)/.test(line);

/**
 * The test code in a Rust file: all of a file in a crate's `tests/`, and elsewhere each top-level
 * item under a bare `#[cfg(test)]`. rustfmt, which the gates enforce, indents everything inside a
 * top-level item, so the item ends at the next line that starts at column 0: its own closing
 * brace, or the next item when it fits on one line. A test module nested in another item isn't
 * found, which only ever costs a kill.
 */
export function testCode(file: string, source: string): LineSpan[] {
  const lines = source.split("\n");
  if (INTEGRATION_TEST.test(file)) return [{ file, start: 1, end: lines.length }];
  const spans: LineSpan[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i] !== "#[cfg(test)]") continue;
    let item = i + 1;
    while (lines[item]?.startsWith("#[") === true) item += 1;
    if (lines[item] === undefined) break;
    let next = item + 1;
    while (next < lines.length && !startsAnItem(lines[next] ?? "")) next += 1;
    if (next === lines.length) break;
    // Its own closing brace, whatever follows it on the line, or else the next item.
    const end = lines[next]?.startsWith("}") === true ? next : next - 1;
    spans.push({ file, start: i + 1, end: end + 1 });
    i = end;
  }
  return spans;
}

/**
 * The product functions marked `#[track_caller]` in a file: a panic in one names its caller's
 * line, so a test's line that calls one is not the test's own assertion.
 */
export function trackCallers(source: string, tests: LineSpan[]): string[] {
  const names: string[] = [];
  const lines = source.split("\n");
  lines.forEach((line, i) => {
    if (line.trim() !== "#[track_caller]") return;
    if (tests.some((s) => i + 1 >= s.start && i + 1 <= s.end)) return;
    const fn = lines
      .slice(i + 1, i + 6)
      .map((next) => /\bfn\s+(\w+)/.exec(next)?.[1])
      .find((name) => name !== undefined);
    if (fn !== undefined) names.push(fn);
  });
  return names;
}

/** Where a test's failure may point for it to be the test's own: a line of test code. */
export type InTestCode = (file: string, line: number) => boolean;

/**
 * Whether a place in the source `sources` holds (the workspace's Rust files, unmutated), read
 * back through `original` from the mutated tree, is a line of test code that calls no product
 * `#[track_caller]` function.
 */
export function inTestCode(sources: Map<string, string>): (original: Unmutate) => InTestCode {
  const files = new Map(
    [...sources].map(([file, source]) => [
      file,
      { lines: source.split("\n"), tests: testCode(file, source) },
    ]),
  );
  const callers = [...sources].flatMap(([file, source]) =>
    trackCallers(source, files.get(file)?.tests ?? []),
  );
  const callsOne = (text: string) =>
    callers.some((name) => new RegExp(`\\b${name}\\s*\\(`).test(text));
  return (original) => (file, at) => {
    const code = files.get(file);
    const line = original(file, at);
    if (code === undefined || line === undefined) return false;
    return (
      code.tests.some((s) => line >= s.start && line <= s.end) &&
      !callsOne(code.lines[line - 1] ?? "")
    );
  };
}

/**
 * Whether a result is a failure on the test's own assertion: it failed, it panicked, and every
 * place its output names is test code. That rules out a crash, a timeout, and a panic raised
 * anywhere else: in product code, whether or not cargo-mutants lists it (an overflow the mutant
 * caused, a `-> !` function, an initialiser), in the standard library or in a dependency;
 * proptest reports each of these from inside the test, with the place it came from.
 */
export function failedOnAssertion(result: TestEvent, isTestCode: InTestCode): boolean {
  if (result.event !== "failed" || !PANIC.test(result.stdout)) return false;
  const places = [...result.stdout.matchAll(LOCATION)];
  return places.length > 0 && places.every(([, file = "", at]) => isTestCode(file, Number(at)));
}

const RUST_PATH = /^\w+(?:::\w+)*$/;
const TARGET = /^[\w-]+(?:::[\w-]+)?$/;

/** Whether a test's target and path are plain enough to name in a nextest filter expression. */
export const filterable = (test: RustTest): boolean =>
  TARGET.test(test.file) && RUST_PATH.test(test.title);

/**
 * The nextest filter expression that selects exactly `tests`, each by its target (a crate's
 * library and binaries share one) and its full path. The target is one pattern for the library
 * and its binaries together, not one for each: nextest refuses a whole filter when any
 * `binary_id` in it matches no binary, as a separate `bin/*` does for a crate without one, and
 * for every integration test. A target `filterable` accepts holds nothing a regex reads as syntax.
 */
export function nextestFilter(tests: RustTest[]): string {
  return tests
    .map((t) => `(binary_id(/^${t.file}(::bin\\/.*)?$/) & test(=${t.title}))`)
    .join(" | ");
}
