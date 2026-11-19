/**
 * The keys that detach `bazhen terminals attach`, as `--detach-keys` and `attach.detach_keys` in
 * `config.toml` write them: keys separated by commas, each `ctrl-` and a letter or one of
 * `@ [ \ ] ^ _`, or one printable character. The CLI reads the same text
 * (`crates/bazhen-protocol/src/detach_keys.rs`), and `checks.json` holds the two to the same
 * verdicts, so its case folding is ASCII's alone, as Rust's is.
 */

/** The most keys a sequence has: every key but the last is held back while it may be the start. */
export const DETACH_KEYS_MAX = 8;

const ESCAPE = 0x1b;
const CTRL_PUNCTUATION = "@[\\]^_";

const asciiLower = (code: number) => (code >= 0x41 && code <= 0x5a ? code + 0x20 : code);

/** The byte the key `name` sends. */
function key(name: string): number | undefined {
  if (name.length === 1) {
    const code = name.charCodeAt(0);
    return code >= 0x21 && code <= 0x7e && name !== "," ? code : undefined;
  }
  const prefix = Array.from(name.slice(0, 5), (c) =>
    String.fromCharCode(asciiLower(c.charCodeAt(0))),
  );
  if (name.length !== 6 || prefix.join("") !== "ctrl-") return undefined;
  const code = asciiLower(name.charCodeAt(5));
  if (code >= 0x61 && code <= 0x7a) return code - 0x60;
  return CTRL_PUNCTUATION.includes(name.charAt(5)) ? code - 0x40 : undefined;
}

/** The bytes `text` names, or why it names none. */
function keysOf(text: string): { keys: number[] } | { problem: string } {
  if (text === "") return { problem: "name at least one key" };
  const keys: number[] = [];
  for (const name of text.split(",")) {
    if (name === "") return { problem: "a key between commas is missing" };
    const code = key(name);
    if (code === undefined) {
      return {
        problem: `"${name}" isn't a key: name ctrl- with a letter or one of @ [ \\ ] ^ _, or one printable character other than a comma`,
      };
    }
    keys.push(code);
  }
  if (keys.length > DETACH_KEYS_MAX) return { problem: `name at most ${DETACH_KEYS_MAX} keys` };
  if (keys[0] === ESCAPE) {
    return {
      problem: "can't start with ctrl-[: that is Escape, which every arrow key starts with",
    };
  }
  return { keys };
}

const shown = (code: number) =>
  code < 0x20 ? `Ctrl-${String.fromCharCode(code + 0x40)}` : String.fromCharCode(code);

/**
 * The detach sequence `text` names, as a person reads it (`ctrl-],ctrl-]` is `Ctrl-] Ctrl-]`), or
 * why it names none.
 */
export function readDetachKeys(text: string): { shown: string } | { problem: string } {
  const read = keysOf(text);
  return "problem" in read ? read : { shown: read.keys.map(shown).join(" ") };
}
