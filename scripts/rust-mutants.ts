// What falsify reads from cargo-mutants and nextest when it judges new Rust tests by mutating the
// code the branch changed (scripts/falsify.ts). Every parser throws on output it doesn't
// recognise, so a run that went wrong never reads as "no mutants" or "nothing failed".

export type Mutant = { name: string; file: string; patch: string };
export type LineSpan = { file: string; start: number; end: number };
export type RustTest = { file: string; title: string };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

function lineSpan(file: string, span: unknown, what: string): LineSpan {
  const start = isObject(span) && isObject(span["start"]) ? span["start"]["line"] : undefined;
  const end = isObject(span) && isObject(span["end"]) ? span["end"]["line"] : undefined;
  if (typeof start !== "number" || typeof end !== "number") {
    throw new Error(`not a cargo-mutants listing: ${what} has no span`);
  }
  return { file, start, end };
}

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
 * The lines of every function cargo-mutants would mutate in a full `--list --json`: the product
 * code. Tests are never in it, since cargo-mutants skips `#[cfg(test)]` code and `#[test]` fns.
 */
export function productSpans(listing: unknown): LineSpan[] {
  const spans = new Map<string, LineSpan>();
  for (const entry of entries(listing)) {
    const fn = entry["function"];
    if (fn === null || fn === undefined) continue;
    const span = lineSpan(
      String(entry["file"]),
      isObject(fn) ? fn["span"] : undefined,
      "a function",
    );
    spans.set(`${span.file}:${span.start}:${span.end}`, span);
  }
  return [...spans.values()];
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

/**
 * Whether a result is a failure on the test's own assertion: it failed, it panicked, and its
 * output names no line of product code. That rules out a crash, a timeout, and a panic product
 * code raised (an overflow the mutant caused), which proptest also reports from inside the test.
 */
export function failedOnAssertion(result: TestEvent, product: LineSpan[]): boolean {
  if (result.event !== "failed" || !PANIC.test(result.stdout)) return false;
  return ![...result.stdout.matchAll(LOCATION)].some(([, file, line]) =>
    product.some((s) => s.file === file && Number(line) >= s.start && Number(line) <= s.end),
  );
}

const RUST_PATH = /^\w+(?:::\w+)*$/;
const TARGET = /^[\w-]+(?:::[\w-]+)?$/;

/** Whether a test's target and path are plain enough to name in a nextest filter expression. */
export const filterable = (test: RustTest): boolean =>
  TARGET.test(test.file) && RUST_PATH.test(test.title);

/**
 * The nextest filter expression that selects exactly `tests`, each by its target (a crate's
 * library and binaries share one) and its full path.
 */
export function nextestFilter(tests: RustTest[]): string {
  return tests
    .map((t) => `((binary_id(=${t.file}) | binary_id(${t.file}::bin/*)) & test(=${t.title}))`)
    .join(" | ");
}
