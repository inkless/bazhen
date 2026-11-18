import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { newId } from "@bazhen/core";
import type { ExitStatus } from "@bazhen/protocol";
import { fakeTmux, removeFakes } from "./testing/fake-tmux.ts";

afterEach(() => {
  vi.useRealTimers();
  removeFakes();
});

/** A `tmux` whose every `list-panes` prints `FAKE_PANE`, logging a line for each. */
const ONE_PANE = `#!/bin/sh
case "$*" in
*" list-panes "*) echo >> "$FAKE_DIR/listed"; printf '%s\\n' "$FAKE_PANE" ;;
*) exit 1 ;;
esac
`;

/** How many times the fake in `root` has listed its panes. */
const listingsIn = (root: string) =>
  existsSync(join(root, "listed")) ? readFileSync(join(root, "listed"), "utf8").length : 0;

/** The `list-panes` row of a shell pane that has died with neither a status nor a signal. */
const deadOfUnknownCause = () =>
  [newId("term"), "shell", "", "", "", "bz", "100", "1", "$1", "%1", "101", "1", "1", "", ""].join(
    "\t",
  );

describe("a tmux pane dead of unknown cause", () => {
  it("is reported by no process check until its grace runs out, then reported unknown", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { runtime, root } = fakeTmux(ONE_PANE, {
      env: { FAKE_PANE: deadOfUnknownCause() },
      processPollMs: 10,
    });
    const reported: (ExitStatus | null)[] = [];
    const stop = runtime.onProcess((_ref, exit) => reported.push(exit));
    await expect.poll(() => listingsIn(root)).toBeGreaterThanOrEqual(3);
    const withinGrace = [...reported];
    vi.setSystemTime(Date.now() + 2_000);
    await expect.poll(() => reported.length).toBeGreaterThan(withinGrace.length);
    stop();
    expect([withinGrace, reported[0]]).toEqual([[], { type: "unknown" }]);
  });
});
