import { describe, expect, it } from "vitest";
import { InvalidTransition } from "./machine.ts";
import { notice } from "./notice.ts";

describe("notice", () => {
  it("closes on a dismissal or a revocation, and refuses either once it is closed", () => {
    expect([notice.next("open", "dismissed"), notice.next("open", "revoked")]).toEqual([
      "closed",
      "closed",
    ]);
    expect(() => notice.next("closed", "dismissed")).toThrow(InvalidTransition);
    expect(() => notice.next("closed", "revoked")).toThrow(InvalidTransition);
  });
});
