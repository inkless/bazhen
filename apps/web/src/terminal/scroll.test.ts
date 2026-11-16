import { describe, expect, it } from "vitest";
import { HISTORY_LINES, HOLDER_MAX_HISTORY_LINES, MAX_ROWS } from "@bazhen/protocol";
import {
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
