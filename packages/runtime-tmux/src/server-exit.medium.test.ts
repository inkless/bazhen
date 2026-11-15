import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { newId, type RuntimeRef } from "@bazhen/core";
import { fakeTmux, removeFakes } from "./testing/fake-tmux.ts";

afterEach(removeFakes);

/**
 * A `tmux` whose server is going away: every command gets what a client prints when the server
 * accepts its connection and closes it unanswered, as one does once it is shutting down. Only
 * the first `list-panes` is answered, with `FAKE_PANE`, when there is one. Each command's name
 * is logged.
 */
const DYING_SERVER = `#!/bin/sh
for word in "$@"; do case "$word" in -*|/*) ;; *) echo "$word" >> "$FAKE_DIR/log"; break ;; esac; done
case "$*" in
*" list-panes "*)
  if [ -n "$FAKE_PANE" ] && [ ! -e "$FAKE_DIR/answered" ]; then
    : > "$FAKE_DIR/answered"
    printf '%s\\n' "$FAKE_PANE"
    exit 0
  fi ;;
esac
echo "server exited unexpectedly" >&2
exit 1
`;

/**
 * A ref on a server whose pid names a process that has exited and been reaped, so `ps` finds
 * nothing there. Were the pid taken by another process before `ps` reads it, the verdict stays
 * `gone` unless that process looks like tmux, and then close throws `TerminalUnconfirmed`:
 * reuse can only fail these tests, never pass them.
 */
function refOnExitedServer(): RuntimeRef {
  const { pid } = spawnSync("/bin/sh", ["-c", ":"]);
  return {
    terminalId: newId("term"),
    runtime: "tmux",
    locator: {
      socket: "",
      session: "bz",
      serverPid: String(pid),
      serverStart: "1",
      sessionId: "$1",
      paneId: "%1",
      panePid: String(pid),
      generation: "1",
    },
  };
}

/** The `list-panes` row tmux prints for `ref`'s live shell pane. */
function paneRow({ terminalId, locator }: RuntimeRef): string {
  const location = ["session", "serverPid", "serverStart", "sessionId", "paneId", "panePid"].map(
    (key) => locator[key] ?? "",
  );
  return [terminalId, "shell", "", "", "", ...location, locator["generation"], "0", "", ""].join(
    "\t",
  );
}

const commandsIn = (root: string) => {
  const log = join(root, "log");
  return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
};

describe("closing a terminal while its tmux server exits", () => {
  it("closes a terminal whose server drops the connection unanswered, once ps finds it gone", async () => {
    const { runtime } = fakeTmux(DYING_SERVER);
    await expect(runtime.close(refOnExitedServer())).resolves.toBeUndefined();
  });

  it("closes a terminal whose server goes away between finding its pane and killing it", async () => {
    const ref = refOnExitedServer();
    const { runtime, root } = fakeTmux(DYING_SERVER, { env: { FAKE_PANE: paneRow(ref) } });
    await expect(runtime.close(ref)).resolves.toBeUndefined();
    expect(commandsIn(root).slice(0, 2)).toEqual(["list-panes", "kill-session"]);
  });
});
