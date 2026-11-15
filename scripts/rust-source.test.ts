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
});
