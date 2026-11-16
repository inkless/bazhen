import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEAD_PANE_WORKAROUND, resetsDeadPanes } from "./index.ts";
import { fakeTmux, removeFakes } from "./testing/fake-tmux.ts";

afterEach(removeFakes);

const RESET_HOOK = `set-hook -g pane-died 'if-shell -F "#{pane_dead}" "send-keys -R"'`;

/**
 * A `tmux` whose own version is `installed` and whose running server's is `serving`, logging the
 * hook commands it is sent, one argument a line.
 */
function onFake(installed: string, serving: string) {
  const script = `#!/bin/sh
case "$*" in
*" -V") echo "tmux ${installed}" ;;
*" display-message -p #{version}") echo "${serving}" ;;
*" list-sessions "*) ;;
*" set-hook "*) for a in "$@"; do echo "$a"; done >> "$FAKE_DIR/sent" ;;
*) exit 1 ;;
esac
`;
  const { runtime, root } = fakeTmux(script);
  const read = (name: string) => readFileSync(join(root, name), "utf8");
  return { runtime, config: () => read("tmux.conf"), sent: () => read("sent") };
}

describe("the dead-pane reset tmux before 3.5 needs", () => {
  it.each([
    [[2, 9], true],
    [[3, 4], true],
    [[3, 5], false],
    [[3, 6], false],
    [[4, 0], false],
  ] as const)("is needed by tmux %j: %s", (version, needed) => {
    expect(resetsDeadPanes(version)).toBe(needed);
  });

  it("is in the config of a server tmux 3.4 starts, and doctor names it", async () => {
    const { runtime, config } = onFake("3.4", "3.4");
    expect(config()).toContain(RESET_HOOK);
    expect((await runtime.health()).workarounds).toEqual([DEAD_PANE_WORKAROUND]);
  });

  it("is removed from the config of a server tmux 3.5 starts, and doctor says nothing", async () => {
    const { runtime, config } = onFake("3.5a", "3.5a");
    expect(config()).toContain("set-hook -gu pane-died");
    expect(config()).not.toContain("send-keys -R");
    expect((await runtime.health()).workarounds).toEqual([]);
  });

  it("goes onto a running 3.4 server by the server's own version, not the installed one", async () => {
    const { runtime, sent } = onFake("3.6b", "3.4");
    await runtime.applyServerSettings();
    expect(sent()).toContain(`pane-died\nif-shell -F "#{pane_dead}" "send-keys -R"\n`);
  });

  it("comes off a running 3.5 server an older daemon gave it to", async () => {
    const { runtime, sent } = onFake("3.4", "3.5a");
    await runtime.applyServerSettings();
    expect(sent()).toContain("-gu\npane-died\n");
    expect(sent()).not.toContain("send-keys -R");
  });
});
