/**
 * `args` with what may carry the user's own text replaced: the value of each `-e NAME=VALUE`, a
 * terminal's environment, and every key `send-keys` would type.
 */
export function redacted(args: readonly string[]): string[] {
  let command = 0;
  return args.map((arg, i) => {
    if (arg === ";") command = i + 1;
    if (args[i - 1] === "-e") return arg.replace(/=.*$/s, "=…");
    const keys = args[command] === "send-keys" && i > command && !arg.startsWith("-");
    return keys && args[i - 1] !== "-t" ? "…" : arg;
  });
}
