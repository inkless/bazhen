// Rust source as the checks read it, with comments and literals out of the way. It imports
// nothing, so the gate scripts, which import only Node built-ins, can use it.

const RAW_STRING = /r(#*)"/y;
export const isIdent = (c: string | undefined) => c !== undefined && /\w/.test(c);
export const newlinesIn = (text: string) => text.replaceAll(/[^\n]/g, "");
const charWidth = (text: string, i: number) => ((text.codePointAt(i) ?? 0) > 0xffff ? 2 : 1);

/**
 * Rust source with its comments removed and every string and char literal emptied, so neither a
 * `//` in a string nor an attribute quoted in one changes what the attributes are. Newlines are
 * kept, so a line in the result is the same line in the source. Each string literal becomes
 * `""`, and its contents, a raw string's included, are pushed to `strings` in order, so the nth
 * `""` in the result is `strings[n]`; `raw[n]` says whether it was a raw string, whose contents
 * are its text, with no escapes to take. A `'` opens a char literal, as in Rust's lexer, when
 * the char after it is `\` or the char after that is `'`, and is a lifetime or a label otherwise;
 * those are chars, not UTF-16 units, so `'😀'` is a literal like `'a'`.
 */
export function rustCode(source: string, strings: string[] = [], raw: boolean[] = []): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const c = source[i] ?? "";
    const next = source[i + 1];
    const start = i;
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
    } else if (
      c === "r" &&
      !isIdent(/[bc]/.test(source[i - 1] ?? "") ? source[i - 2] : source[i - 1])
    ) {
      RAW_STRING.lastIndex = i;
      const opener = RAW_STRING.exec(source);
      if (opener === null) {
        out += c;
        i++;
        continue;
      }
      const close = `"${opener[1] ?? ""}`;
      const end = source.indexOf(close, i + opener[0].length);
      i = end === -1 ? source.length : end + close.length;
      strings.push(source.slice(start + opener[0].length, end === -1 ? source.length : end));
      raw.push(true);
      out += `""${newlinesIn(source.slice(start, i))}`;
    } else if (c === '"') {
      i++;
      while (i < source.length && source[i] !== '"') i += source[i] === "\\" ? 2 : 1;
      strings.push(source.slice(start + 1, i));
      raw.push(false);
      i++;
      out += `""${newlinesIn(source.slice(start, i))}`;
    } else if (c === "'" && (next === "\\" || source[i + 1 + charWidth(source, i + 1)] === "'")) {
      i += next === "\\" ? 3 : 1;
      while (i < source.length && source[i] !== "'") i++;
      i++;
      out += "' '";
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
