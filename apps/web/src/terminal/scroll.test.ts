import { describe, expect, it } from "vitest";
import { Terminal } from "@xterm/headless";
import { HISTORY_LINES, HOLDER_MAX_HISTORY_LINES, MAX_ROWS } from "@bazhen/protocol/web";
import {
  onAlternateScreen,
  scrollbackFor,
  startSnapshot,
  wheelAction,
  type WheelContext,
  type WheelAction,
} from "./scroll.ts";

const table: ReadonlyArray<readonly [string, WheelContext, WheelAction]> = [
  ["an agent with mouse reporting", { mouseTracking: true, alternate: true, kind: "agent" }, "app"],
  [
    "a shell program with mouse reporting",
    { mouseTracking: true, alternate: true, kind: "shell" },
    "app",
  ],
  [
    "an agent on the normal screen",
    { mouseTracking: false, alternate: false, kind: "agent" },
    "local",
  ],
  [
    "a shell on the normal screen",
    { mouseTracking: false, alternate: false, kind: "shell" },
    "local",
  ],
  [
    "a shell program on the alternate screen",
    { mouseTracking: false, alternate: true, kind: "shell" },
    "arrows",
  ],
  [
    "an agent on the alternate screen",
    { mouseTracking: false, alternate: true, kind: "agent" },
    "swallow",
  ],
];

describe("wheel routing", () => {
  it.each(table)("routes the wheel for %s", (_name, context, action) => {
    expect(wheelAction(context)).toBe(action);
  });
});

async function parsed(vt: string): Promise<Terminal> {
  const term = new Terminal({ cols: 20, rows: 4, allowProposedApi: true });
  await new Promise<void>((done) => term.write(vt, done));
  return term;
}

describe("whether a view is on the alternate screen", () => {
  it("follows the switches in its own bytes, with nothing from the daemon", async () => {
    const term = await parsed("shell\r\n\x1b[?1049hvim");
    const during = onAlternateScreen(term, false);
    await new Promise<void>((done) => term.write("\x1b[?1049l", done));
    expect([during, onAlternateScreen(term, false)]).toEqual([true, false]);
  });

  it("stays on the alternate screen until the view has parsed the bytes that leave it", async () => {
    const term = await parsed("shell\r\n\x1b[?1049hvim");
    const left = new Promise<void>((done) => term.write("\x1b[?1049l", done));
    // Written, not yet parsed: the wheel must still go to the program, whose screen this is.
    const pending = onAlternateScreen(term, false);
    await left;
    expect([pending, onAlternateScreen(term, false)]).toEqual([true, false]);
  });

  it("takes the daemon's word where its bytes never switch", async () => {
    expect(onAlternateScreen(await parsed("tmux keeps this view on its normal screen"), true)).toBe(
      true,
    );
  });
});

describe("a view's scrollback", () => {
  it("keeps the history its terminal keeps, and a screen more", () => {
    expect(scrollbackFor(250)).toBe(250 + MAX_ROWS);
  });

  it("keeps the default history when the daemon doesn't say how much its terminal keeps", () => {
    expect(scrollbackFor(undefined)).toBe(HISTORY_LINES + MAX_ROWS);
  });

  it("keeps no more than any terminal can, whatever a frame asks for", () => {
    expect(scrollbackFor(1_000_000_000)).toBe(HOLDER_MAX_HISTORY_LINES + MAX_ROWS);
  });

  it("is sized to the terminal's depth before the view clears for its snapshot", () => {
    const steps: string[] = [];
    const term = {
      options: {
        set scrollback(lines: number) {
          steps.push(`scrollback ${lines}`);
        },
      },
      reset: () => steps.push("reset"),
    };
    startSnapshot(term, { type: "snapshot_start", historyLines: 250 });
    expect(steps).toEqual([`scrollback ${250 + MAX_ROWS}`, "reset"]);
  });
});
