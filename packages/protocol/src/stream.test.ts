import { describe, expect, it } from "vitest";
import { StreamClientFrame } from "./stream.ts";

const hello = { type: "hello", protocolVersion: "1.0", mode: "interactive", cols: 120, rows: 40 };

describe("stream frames", () => {
  it("opens with a hello that carries the view's size and whether it may type", () => {
    expect(StreamClientFrame.safeParse(hello).success).toBe(true);
  });

  it("refuses a size no terminal could have", () => {
    expect(StreamClientFrame.safeParse({ ...hello, cols: 0 }).success).toBe(false);
  });

  it("refuses a frame type it doesn't know", () => {
    expect(StreamClientFrame.safeParse({ type: "paste", text: "rm -rf" }).success).toBe(false);
  });
});
