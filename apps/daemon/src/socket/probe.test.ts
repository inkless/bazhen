import { describe, expect, it } from "vitest";
import { answerOf } from "./probe.ts";

const failed = (code: string) => Object.assign(new Error(code), { code });

describe("answerOf", () => {
  it("takes the socket for free only where nothing is or nothing listens", () => {
    expect(
      [
        failed("ENOENT"),
        failed("ECONNREFUSED"),
        failed("EAGAIN"),
        failed("ECONNRESET"),
        failed("EACCES"),
        new Error("no code"),
        "not an error",
      ].map((err) => answerOf(err).kind),
    ).toEqual(["nothing", "nothing", "silent", "silent", "silent", "silent", "silent"]);
  });
});
