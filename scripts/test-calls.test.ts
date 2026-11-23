import { describe, expect, it } from "vitest";
import { codeTokens, testCalls, type TestCall } from "./test-calls.ts";

const lines = (...text: string[]) => `${text.join("\n")}\n`;

const calls = (source: string): TestCall[] => {
  const found = testCalls(source);
  if (typeof found === "string") throw new Error(`unreadable: ${found}`);
  return found;
};

/** The titles of the source's test calls, or why it can't be read. */
const titles = (source: string) => {
  const found = testCalls(source);
  return typeof found === "string" ? found : found.map((t) => t.title);
};

const body = (source: string) => calls(source)[0]?.body;

describe("testCalls", () => {
  it("reads the title of each it and test call, in a describe or not", () => {
    const source = lines(
      'import { describe, expect, it, test } from "vitest";',
      'describe("outer", () => {',
      "  it('single', () => {});",
      '  describe("inner", () => {',
      '    test("double", async () => {});',
      "  });",
      "});",
      "it(`backtick`, () => expect(1).toBe(1));",
    );
    expect(titles(source)).toEqual(["single", "double", "backtick"]);
  });

  it("reads a title the formatter wrapped onto the line after a chain's call", () => {
    const source = lines(
      "it.runIf(process.platform === 'linux')(",
      '  "keeps the shell\'s integration when the condition is long enough to wrap",',
      "  async () => {",
      "    expect(1).toBe(1);",
      "  },",
      ");",
      "it.skipIf(!ok)(",
      '  "skips",',
      "  () => {},",
      ");",
    );
    expect(titles(source)).toEqual([
      "keeps the shell's integration when the condition is long enough to wrap",
      "skips",
    ]);
  });

  it("reads modifiers and each, as a call or a tagged template", () => {
    const source = lines(
      'it.only("only", () => {});',
      'test.concurrent.skip("concurrent", () => {});',
      'it.each([1, 2])("adds %i", (n) => {});',
      "it.each`",
      "  a    | b",
      "  ${1} | ${2}",
      '`("tabled $a", ({ a }) => {});',
      'it.for([[1, 2]])("for %i", ([a]) => {});',
    );
    expect(titles(source)).toEqual(["only", "concurrent", "adds %i", "tabled $a", "for %i"]);
  });

  it("unescapes the title as the language does", () => {
    expect(titles(String.raw`it('doesn\'t say \"no\" \u00e9', () => {});`)).toEqual([
      `doesn't say "no" é`,
    ]);
  });

  it("leaves the title of a call whose first argument isn't a literal undefined, keeping its tokens", () => {
    const [named, interpolated] = calls(lines("it(name, () => {});", "it(`adds ${n}`, () => {});"));
    expect([named?.title, named?.titleTokens, interpolated?.title]).toEqual([
      undefined,
      '["name"]',
      undefined,
    ]);
  });

  it("finds no test in a string, a comment, a template or a regex", () => {
    const source = lines(
      "const fixture = 'it(\"fixture\", f)';",
      '// it("commented", () => {});',
      '/* test("blocked", () => {}); */',
      'const template = `it("templated", () => {}) ${"it(\\"nested\\")"}`;',
      'const pattern = /it\\("matched"\\)/;',
      'it("real", () => {});',
    );
    expect(titles(source)).toEqual(["real"]);
  });

  it("takes no member, declaration or method named it or test for a test", () => {
    const source = lines(
      'const ok = /x/.test("abc");',
      'const maybe = pattern?.test("abc");',
      "function test(name: string) {}",
      "class C {",
      '  test(name = "x") {',
      "    return name;",
      "  }",
      '  it(name = "y"): string {',
      "    return name;",
      "  }",
      "}",
      "it();",
    );
    expect(calls(source)).toEqual([]);
  });

  it("reads a regex after an operator and a division after an operand", () => {
    const source = lines(
      "const a = x / 2 / y;",
      "const b = (x) / 2;",
      "const c = [/[)}`'\"]/g, /\\//];",
      "const d = obj.default / 2;",
      'it("after them", () => expect(a / b).toBe(c.length));',
    );
    expect(titles(source)).toEqual(["after them"]);
  });

  it("reads a template's nested braces, backticks and interpolations as part of the call", () => {
    const source = lines(
      'it("renders", () => {',
      "  expect(render()).toBe(`{ ${`inner ${{ a: 1 }.a}`} }`);",
      "  expect(`)`).toBe(`}`);",
      "});",
      'it("after", () => {});',
    );
    expect(titles(source)).toEqual(["renders", "after"]);
    expect(body(source)).toMatch(/"`\)`".*"`\}`"/);
  });

  it("gives the same body to a call laid out, commented or trailing-commaed differently, title aside", () => {
    const [a, b, c] = calls(
      lines(
        'it("a", () => { expect(v).toBe(1); });',
        "it(",
        "  'b',",
        "  () => {",
        "    // why",
        "    expect(v).toBe(1);",
        "  },",
        ");",
        'it("c", () => { expect(v).toBe(2); });',
      ),
    );
    expect([a?.body === b?.body, a?.body === c?.body]).toEqual([true, false]);
  });

  it("gives a different body to a call whose options, chain or template text changed", () => {
    const plain = body('it("t", () => {});');
    expect([
      body('it("t", { retry: 2 }, () => {});'),
      body('it.skip("t", () => {});'),
      body('it("t", async () => {});'),
    ]).not.toContain(plain);
    expect(body('it("t", () => `a\n b`);')).not.toBe(body('it("t", () => `a\n  b`);'));
  });

  it("reads a title after type arguments in the chain, nested or not", () => {
    const source = lines(
      "it.each<[Key, string]>([[a, b]])(",
      '  "sends %s",',
      "  (key, sent) => {},",
      ");",
      'test.for<Array<Map<string, { a: number }>>>([])("maps %s", () => {});',
      "it.each<Row>`",
      "  a",
      "  ${1}",
      '`("tabled $a", () => {});',
    );
    expect(titles(source)).toEqual(["sends %s", "maps %s", "tabled $a"]);
  });

  it("takes a test chain that reaches no call as one whose title can't be read, and another name's property as none", () => {
    expect(
      calls(
        lines(
          "const each = it.each;",
          "const less = test < limit;",
          "write(test.path, test.text);",
        ),
      ),
    ).toEqual([
      { title: undefined, titleTokens: '["it",".","each"]', body: '["it",".","each"]' },
      { title: undefined, titleTokens: '["test"]', body: '["test"]' },
    ]);
  });

  it("reads a division after a contextual keyword, a non-null assertion or an optional member", () => {
    const source = lines(
      "const a = number / 2;",
      "const b = type /= 2;",
      "const c = x! / 2;",
      "const d = obj?.default / 2;",
      "const e = !/x/.test(s) && (a, !/y/.test(s));",
      'it("after them", () => expect(of / 2).toBe(1));',
    );
    expect(titles(source)).toEqual(["after them"]);
  });

  it("says why a source can't be read: an unterminated literal, or brackets that don't balance", () => {
    expect([
      testCalls('it("open, () => {});'),
      testCalls("it(`open, () => {});"),
      testCalls('it("t", () => {);'),
      testCalls('it("t", () => {'),
    ]).toEqual([
      expect.stringMatching(/^an unterminated literal/),
      expect.stringMatching(/^an unterminated literal/),
      'brackets that don\'t balance (a stray ")")',
      "brackets left open at its end",
    ]);
  });
});

describe("codeTokens", () => {
  it("reads the same tokens through a change of comments or layout", () => {
    expect(codeTokens("const v = 2; // two\n")).toEqual(codeTokens("/* v */ const  v=\n  2;"));
  });

  it("reads a changed string as a changed token", () => {
    expect(codeTokens('const v = "a b";')).not.toEqual(codeTokens('const v = "a  b";'));
  });

  it("says why it can't read a source with an unterminated literal", () => {
    expect(codeTokens('const v = "a;')).toBe("an unterminated literal at offset 10");
  });
});
