import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { thisHost } from "./sandbox.ts";

const dir = mkdtempSync(join(tmpdir(), "bz-sandbox-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("reading the marker", () => {
  // /etc/passwd stands in for root's marker: a file root owns on every Linux and macOS host.
  it("reads a root-owned file's owner", () => {
    expect(thisHost("/etc/passwd")).toEqual({ markerOwner: 0 });
  });

  it("reads a file someone else made as theirs", () => {
    const mine = join(dir, "mine");
    writeFileSync(mine, "");
    expect(thisHost(mine)).toEqual({ markerOwner: process.getuid?.() });
  });

  it("takes neither a link to root's file nor root's directory for the marker", () => {
    const link = join(dir, "link");
    symlinkSync("/etc/passwd", link);
    expect([thisHost(link), thisHost("/etc")]).toEqual([
      { markerOwner: undefined },
      { markerOwner: undefined },
    ]);
  });

  it("reads no marker where there is none", () => {
    expect(thisHost(join(dir, "absent"))).toEqual({ markerOwner: undefined });
  });
});
