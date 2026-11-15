import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fakeTmux, removeFakes } from "./testing/fake-tmux.ts";

afterEach(removeFakes);

/**
 * A `tmux` that answers `-V` and `list-sessions` and logs each attempt at the settings. It refuses
 * them with a status of its own, or, the first time, hangs until the runtime's timeout stops it
 * and exits 0, as a real client does on SIGTERM, and takes them after that.
 */
const FAKE_TMUX = `#!/bin/sh
case "$*" in
*" -V") echo "tmux 3.5a" ;;
*" list-sessions "*) ;;
*" set-hook "*)
  echo attempt >> "$FAKE_DIR/attempts"
  [ "$FAKE_SETTINGS" = refuse ] && { echo "unknown command" >&2; exit 1; }
  [ -e "$FAKE_DIR/hung" ] && exit 0
  : > "$FAKE_DIR/hung"
  trap 'kill $! 2>/dev/null; exit 0' TERM
  /bin/sleep 30 & wait $! ;;
*) exit 1 ;;
esac
`;

/** A runtime whose every tmux command runs the fake; what it warned of; its settings attempts. */
function onFake(settings: "refuse" | "slow") {
  const warnings: unknown[] = [];
  const { runtime, root } = fakeTmux(FAKE_TMUX, {
    env: { FAKE_SETTINGS: settings },
    onError: (err) => warnings.push(err),
  });
  const log = join(root, "attempts");
  const attempts = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").length - 1 : 0);
  return { runtime, warnings, attempts };
}

describe("tmux server settings at health checks", () => {
  it("warns once of settings a server refuses, and asks it no more", async () => {
    const { runtime, warnings, attempts } = onFake("refuse");
    await runtime.health();
    await runtime.health();
    expect([warnings.length, attempts()]).toEqual([1, 1]);
  });

  it("asks again at the next health check when tmux timed out, though its client exited 0", async () => {
    const { runtime, warnings, attempts } = onFake("slow");
    await runtime.health();
    await runtime.health();
    expect([warnings.length, attempts()]).toEqual([1, 2]);
  }, 15_000);
});
