import { describe, expect, it } from "vitest";
import { wheelAction, type WheelContext, type WheelAction } from "./scroll.ts";

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
