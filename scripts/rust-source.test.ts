import { describe, expect, it } from "vitest";
import { rustCode } from "./rust-source.ts";

/** The nth line of the every-form test: a form, then a call it mustn't hide. */
const line = (body: string, n: number) => `m!(${body}); close(${n});`;

describe("rustCode", () => {
  it("removes comments, nested block comments included, keeping their lines", () => {
    expect(rustCode("a // kill(1)\nb /* x /* kill */ y */ c")).toBe("a \nb   c");
  });

  it("empties strings, raw ones included, and hands their contents back in order", () => {
    const strings: string[] = [];
    expect(rustCode('f("wipe(1)", r#"a "q" b"#)', strings)).toBe('f("", "")');
    expect(strings).toEqual(["wipe(1)", 'a "q" b']);
  });

  it("empties a char literal but leaves a lifetime alone", () => {
    expect(rustCode("let c = '\"'; fn f<'a>(x: &'a str) {}")).toBe(
      "let c = ' '; fn f<'a>(x: &'a str) {}",
    );
  });

  it("empties a char literal whatever its char, so no quote after it opens a string", () => {
    const source = [
      String.raw`let a = vec!{'😀','"', close(1), '"'};`,
      String.raw`assert!{['𝔸','"'] != [close(2), '"'], "{}"};`,
      String.raw`m!{'😀''"' close(3) '"'};`,
      String.raw`let c = ['é', b'x', b'"', b'\'', '"']; close(4);`,
      String.raw`let d = ['\'', '\\', '\u{1F600}', '\x41', '\n', '"']; close(5);`,
      String.raw`fn f<'a,'b>(x: &'a str, y: &'static str, z: &'r#a u8) { 'outer: loop { break 'outer; } close(6); }`,
      String.raw`let e = ("q\"t", b"\"", c"x", r"a\", r#"a"b"#, br##"x"#"##, cr"y"); close(7);`,
    ].join("\n");
    const strings: string[] = [];
    const raw: boolean[] = [];
    expect(rustCode(source, strings, raw).split("\n")).toEqual([
      "let a = vec!{' ',' ', close(1), ' '};",
      `assert!{[' ',' '] != [close(2), ' '], ""};`,
      "m!{' '' ' close(3) ' '};",
      "let c = [' ', b' ', b' ', b' ', ' ']; close(4);",
      "let d = [' ', ' ', ' ', ' ', ' ', ' ']; close(5);",
      "fn f<'a,'b>(x: &'a str, y: &'static str, z: &'r#a u8) { 'outer: loop { break 'outer; } close(6); }",
      `let e = ("", b"", c"", "", "", b"", c""); close(7);`,
    ]);
    expect(strings).toEqual([
      "{}",
      String.raw`q\"t`,
      String.raw`\"`,
      "x",
      "a\\",
      'a"b',
      'x"#',
      "y",
    ]);
    expect(raw).toEqual([false, false, false, false, true, true, true, true]);
  });

  it("starts a raw string only where a token starts, never in a lifetime, a suffix or an identifier", () => {
    const quote = String.raw`\" `;
    const cases: [form: string, code: string, literals: [string, boolean][]][] = [
      [String.raw`'r"\" "`, `'r""`, [[quote, false]]],
      [String.raw`'br"\" "`, `'br""`, [[quote, false]]],
      [String.raw`'cr"\" "`, `'cr""`, [[quote, false]]],
      [String.raw`'r#r"\" "`, `'r#r""`, [[quote, false]]],
      [String.raw`'ér"\" "`, `'ér""`, [[quote, false]]],
      [String.raw`'a'r"\" "`, `' 'r""`, [[quote, false]]],
      [String.raw`b'a'r"\" "`, `b' 'r""`, [[quote, false]]],
      [
        String.raw`"a"r"\" "`,
        `""r""`,
        [
          ["a", false],
          [quote, false],
        ],
      ],
      [
        String.raw`b"a"r"\" "`,
        `b""r""`,
        [
          ["a", false],
          [quote, false],
        ],
      ],
      [
        String.raw`c"a"r"\" "`,
        `c""r""`,
        [
          ["a", false],
          [quote, false],
        ],
      ],
      [
        String.raw`r"a"r"\" "`,
        `""r""`,
        [
          ["a", true],
          [quote, false],
        ],
      ],
      [
        String.raw`r#"a"#r"\" "`,
        `""r""`,
        [
          ["a", true],
          [quote, false],
        ],
      ],
      [
        String.raw`"a"ér"\" "`,
        `""ér""`,
        [
          ["a", false],
          [quote, false],
        ],
      ],
      [String.raw`r#r"\" "`, `r#r""`, [[quote, false]]],
      [String.raw`1r"\" "`, `1r""`, [[quote, false]]],
      [String.raw`0xbr"\" "`, `0xbr""`, [[quote, false]]],
      ["'r: loop", "'r: loop", []],
      ["'r#a", "'r#a", []],
      [String.raw`r#"a"b"#`, `""`, [['a"b', true]]],
      [String.raw`br##"x"#"##`, `b""`, [['x"#', true]]],
      [String.raw`cr"y"`, `c""`, [["y", true]]],
    ];
    const strings: string[] = [];
    const raw: boolean[] = [];
    const source = cases.map(([form], n) => line(form, n)).join("\n");
    expect(rustCode(source, strings, raw).split("\n")).toEqual(
      cases.map(([, code], n) => line(code, n)),
    );
    const literals = cases.flatMap(([, , each]) => each);
    expect(strings).toEqual(literals.map(([text]) => text));
    expect(raw).toEqual(literals.map(([, isRaw]) => isRaw));
  });

  it("drops a first line rustc reads as a shebang, and keeps one it reads as an inner attribute", () => {
    const stripped: [form: string, code: string][] = [
      ['#!/** x */[] "', ""],
      ["#!/usr/bin/env run-cargo-script", ""],
      ["#!", ""],
      ["#! /// d\n[a]", "\n[a]"],
      ["#! //! d\n[a]", "\n[a]"],
      ["#!/*! d */[a]", ""],
      ["#! /* unterminated", ""],
      ["#!\u00a0[a]", ""],
      ["#!\u3000[a]", ""],
      ["#!x\r", "\r"],
      ['\ufeff#!/** x */[] "', ""],
    ];
    const kept: [form: string, code: string][] = [
      ["#![a]", "#![a]"],
      ["#! [a]", "#! [a]"],
      ["#!\n[a]", "#!\n[a]"],
      ["#! /* c */ [a]", "#!   [a]"],
      ["#! // c\n[a]", "#! \n[a]"],
      ["#! //// c\n[a]", "#! \n[a]"],
      ["#!/**/[a]", "#! [a]"],
      ["#!/***/[a]", "#! [a]"],
      ["#!/* /** */ */[a]", "#! [a]"],
      ["#!\u200e[a]", "#!\u200e[a]"],
      ["#!\u0085[a]", "#!\u0085[a]"],
      ["\ufeff#![a]", "#![a]"],
      [" #!/** x */[]", " #! []"],
      ["\n#!/** x */[]", "\n#! []"],
    ];
    const cases = [...stripped, ...kept];
    expect(cases.map(([form], n) => rustCode(`${form}\nclose(${n});`))).toEqual(
      cases.map(([, code], n) => `${code}\nclose(${n});`),
    );
  });
});
