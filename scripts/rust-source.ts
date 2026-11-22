// Rust source as the checks read it, with comments and literals out of the way. It imports
// nothing, so the gate scripts, which import only Node built-ins, can use it.

const WORD = /\p{XID_Continue}+/uy;
const RAW_IDENT = /r#[\p{XID_Start}_]\p{XID_Continue}*/uy;
const RAW_OPENER = /#*"/y;
const RAW_PREFIXES = new Set(["r", "br", "cr"]);
export const isIdent = (c: string | undefined) => c !== undefined && /\w/.test(c);
export const newlinesIn = (text: string) => text.replaceAll(/[^\n]/g, "");
const charWidth = (text: string, i: number) => ((text.codePointAt(i) ?? 0) > 0xffff ? 2 : 1);
const matchAt = (pattern: RegExp, text: string, i: number) => {
  pattern.lastIndex = i;
  return pattern.exec(text)?.[0] ?? "";
};
const isAsciiWordChar = (code: number) =>
  (code >= 0x30 && code <= 0x39) ||
  (code >= 0x41 && code <= 0x5a) ||
  (code >= 0x61 && code <= 0x7a) ||
  code === 0x5f;
/** The `XID_Continue` run at `i`, read without a regex while it stays ASCII. */
const runAt = (text: string, i: number) => {
  let end = i;
  while (isAsciiWordChar(text.charCodeAt(end))) end++;
  return text.charCodeAt(end) >= 0x80 ? matchAt(WORD, text, i) : text.slice(i, end);
};
const wordAt = (text: string, i: number) =>
  (text.startsWith("r#", i) && matchAt(RAW_IDENT, text, i)) || runAt(text, i);

/**
 * Rust source with its comments removed and every string and char literal emptied, so neither a
 * `//` in a string nor an attribute quoted in one changes what the attributes are. Newlines are
 * kept, so a line in the result is the same line in the source. Each string literal becomes
 * `""`, and its contents, a raw string's included, are pushed to `strings` in order, so the nth
 * `""` in the result is `strings[n]`; `raw[n]` says whether it was a raw string, whose contents
 * are its text, with no escapes to take. A `'` opens a char literal, as in Rust's lexer, when
 * the char after it is `\` or the char after that is `'`, and is a lifetime or a label otherwise;
 * those are chars, not UTF-16 units, so `'😀'` is a literal like `'a'`.
 *
 * As in Rust's lexer, a word (an identifier, a raw one, a keyword, or a number with its suffix),
 * a lifetime's or label's name, and a literal's suffix are each taken whole, so an `r` begins a
 * raw string only where it begins a token, never in `'r`, `"a"r` or `r#r`.
 */
export function rustCode(source: string, strings: string[] = [], raw: boolean[] = []): string {
  let out = "";
  let i = 0;
  const suffix = () => {
    const taken = runAt(source, i);
    i += taken.length;
    return taken;
  };
  while (i < source.length) {
    const c = source[i] ?? "";
    const next = source[i + 1];
    const start = i;
    const word = wordAt(source, i);
    if (c === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i++;
    } else if (c === "/" && next === "*") {
      let depth = 1;
      i += 2;
      while (i < source.length && depth > 0) {
        const pair = source.slice(i, i + 2);
        const step = pair === "/*" ? 1 : pair === "*/" ? -1 : 0;
        depth += step;
        i += step === 0 ? 1 : 2;
      }
      out += ` ${newlinesIn(source.slice(start, i))}`;
    } else if (word !== "") {
      i += word.length;
      const opener = RAW_PREFIXES.has(word) ? matchAt(RAW_OPENER, source, i) : "";
      if (opener === "") {
        out += word;
        continue;
      }
      const close = `"${opener.slice(0, -1)}`;
      const end = source.indexOf(close, i + opener.length);
      i = end === -1 ? source.length : end + close.length;
      strings.push(
        source.slice(start + word.length + opener.length, end === -1 ? source.length : end),
      );
      raw.push(true);
      out += `${word.slice(0, -1)}""${newlinesIn(source.slice(start, i))}`;
      out += suffix();
    } else if (c === '"') {
      i++;
      while (i < source.length && source[i] !== '"') i += source[i] === "\\" ? 2 : 1;
      strings.push(source.slice(start + 1, i));
      raw.push(false);
      i++;
      out += `""${newlinesIn(source.slice(start, i))}`;
      out += suffix();
    } else if (c === "'" && (next === "\\" || source[i + 1 + charWidth(source, i + 1)] === "'")) {
      i += next === "\\" ? 3 : 1;
      while (i < source.length && source[i] !== "'") i++;
      i++;
      out += "' '";
      out += suffix();
    } else if (c === "'") {
      const name = wordAt(source, i + 1);
      out += c + name;
      i += 1 + name.length;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/**
 * The index just past the item starting at `start`: past its `{ … }` body, or its `;`. Only `(`
 * and `[` are counted on the way, since a `<` in an item may be a comparison, not a generic.
 */
export function itemEnd(code: string, start: number): number {
  let depth = 0;
  for (let i = start; i < code.length; i++) {
    const c = code[i];
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (c === ";" && depth <= 0) return i + 1;
    else if (c === "{" && depth <= 0) {
      for (let braces = 0; i < code.length; i++) {
        if (code[i] === "{") braces++;
        else if (code[i] === "}" && --braces === 0) return i + 1;
      }
    }
  }
  return code.length;
}
