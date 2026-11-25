import { describe, expect, it } from "vitest";
import { failureDetail } from "../apps/daemon/src/commands.ts";
import { detailFixture } from "./detail-fixtures.ts";

const files = detailFixture();
const cases: readonly { text: string; detail: string }[] = JSON.parse(files["cases.json"] ?? "[]");

describe("the failure detail fixture", () => {
  it("writes only the cases", () => {
    expect(Object.keys(files)).toEqual(["cases.json"]);
  });

  it("records each text's detail as the daemon answers it, some kept whole and some redacted", () => {
    expect(cases.map((c) => c.detail)).toEqual(cases.map((c) => failureDetail(new Error(c.text))));
    expect(cases.some((c) => c.detail === c.text)).toBe(true);
    expect(cases.filter((c) => c.detail.includes("[redacted]")).length).toBeGreaterThan(40);
  });

  it("records the same texts on every run", () => {
    expect(detailFixture()).toEqual(files);
  });
});
