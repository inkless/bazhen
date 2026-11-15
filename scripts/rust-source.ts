// Rust source as the checks read it, with comments and literals out of the way. It imports
// nothing, so the gate scripts, which import only Node built-ins, can use it.

const RAW_STRING = /r(#*)"/y;
export const isIdent = (c: string | undefined) => c !== undefined && /\w/.test(c);
export const newlinesIn = (text: string) => text.replaceAll(/[^\n]/g, "");

/**
 * Rust source with its comments removed and every string and char literal emptied, so neither a
 * `//` in a string nor an attribute quoted in one changes what the attributes are. Newlines are
 * kept, so a line in the result is the same line in the source. Each string literal becomes
 * `""`, and its contents, a raw string's included, are pushed to `strings` in order, so the nth
 * `""` in the result is `strings[n]`.
 */
export function rustCode(source: string, strings: string[] = []): string {
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
      const raw = RAW_STRING.exec(source);
      if (raw === null) {
        out += c;
        i++;
        continue;
      }
      const close = `"${raw[1] ?? ""}`;
      const end = source.indexOf(close, i + raw[0].length);
      i = end === -1 ? source.length : end + close.length;
      strings.push(source.slice(start + raw[0].length, end === -1 ? source.length : end));
      out += `""${newlinesIn(source.slice(start, i))}`;
    } else if (c === '"') {
      i++;
      while (i < source.length && source[i] !== '"') i += source[i] === "\\" ? 2 : 1;
      strings.push(source.slice(start + 1, i));
      i++;
      out += `""${newlinesIn(source.slice(start, i))}`;
    } else if (c === "'" && (next === "\\" || source[i + 2] === "'")) {
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
