import { describe, expect, it } from "vitest";
import { originList, originsProblem } from "./origins.ts";

describe("external origins", () => {
  it("admits https origins, and plain HTTP to this machine", () => {
    expect(
      originsProblem(
        ["https://bazhen.example.com", "https://b.example.com:8443", "http://localhost:7901"],
        false,
      ),
    ).toBeNull();
  });

  it.each([
    ["a path", "https://bazhen.example.com/x"],
    ["no scheme", "bazhen.example.com"],
    ["a scheme that isn't web", "ftp://bazhen.example.com"],
    ["a trailing slash", "https://bazhen.example.com/"],
  ])("refuses an origin with %s", (_what, origin) => {
    expect(originsProblem([origin], false)).toContain("must be an origin");
  });

  it("refuses plain HTTP to another host unless allowed", () => {
    expect([
      originsProblem(["http://bazhen.example.com"], false),
      originsProblem(["http://bazhen.example.com"], true),
    ]).toEqual([
      "http://bazhen.example.com is plain HTTP to another host; use https, or set web.allow_insecure_origins",
      null,
    ]);
  });

  it("reads a comma-separated list, ignoring spaces and empty entries", () => {
    expect(originList(" https://a.example.com, ,https://b.example.com ")).toEqual([
      "https://a.example.com",
      "https://b.example.com",
    ]);
    expect(originList(undefined)).toEqual([]);
  });
});
