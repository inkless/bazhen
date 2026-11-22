import { describe, expect, it } from "vitest";
import { rustCode } from "./rust-source.ts";

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
});
