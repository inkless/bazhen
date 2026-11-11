import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { isMain } from "./is-main.ts";

const self = import.meta.filename;
const url = pathToFileURL(self).href;

describe("isMain", () => {
  it("trusts import.meta.main when Node provides it", () => {
    expect([isMain({ main: true, url }, undefined), isMain({ main: false, url }, self)]).toEqual([
      true,
      false,
    ]);
  });

  it("falls back to comparing the entry point with the module path", () => {
    expect([
      isMain({ url }, self),
      isMain({ url }, import.meta.dirname),
      isMain({ url }, undefined),
    ]).toEqual([true, false, false]);
  });
});
