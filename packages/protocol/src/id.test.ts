import { describe, expect, it } from "vitest";
import { filesHash } from "./id.ts";

describe("filesHash", () => {
  it("is SHA-256 over each file's name and content, NUL-ended, in name order", async () => {
    // printf 'A.json\0{}\0B.json\0[]\0' | sha256sum
    expect(await filesHash({ "B.json": "[]", "A.json": "{}" })).toBe(
      "d369cd33e49c31c1d6c74cf3f2a4646c21f39d4aae5029bccf4c1bb3133166f1",
    );
  });

  it("keeps a name and its content apart", async () => {
    expect(await filesHash({ "A.json": "B.json" })).not.toBe(
      await filesHash({ "A.jsonB.json": "" }),
    );
  });
});
