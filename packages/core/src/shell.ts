/**
 * `argv` as one line that bash, zsh and fish all read back as `argv`. A word is left bare only
 * when no shell treats any of it specially; zsh expands a leading `=` and old fish a leading `%`.
 * Otherwise it is single-quoted, with each `'` and `\` written outside the quotes, because fish
 * reads `\'` and `\\` inside single quotes as escapes where the others don't.
 */
export function shellCommand(argv: readonly string[]): string {
  return argv
    .map((w) =>
      /^[\w@+:,./-][\w@%+=:,./-]*$/.test(w) ? w : `'${w.replaceAll(/['\\]/g, (c) => `'\\${c}'`)}'`,
    )
    .join(" ");
}
