import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setup, teardown } from "./medium-setup.ts";

const KEPT = ["TMPDIR", "TMUX_TMPDIR", "BAZHEN_HOME", "TMUX", "TMUX_PANE"] as const;
const before = new Map(KEPT.map((name) => [name, process.env[name]]));
const siblings: string[] = [];

afterEach(() => {
  teardown();
  for (const [name, value] of before) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  for (const dir of siblings.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the medium suite's temporary directory", () => {
  it("puts every directory a test makes under one run root that teardown removes", () => {
    setup();
    const root = tmpdir();
    expect(root).toMatch(/^\/tmp\/bz-run-[A-Za-z0-9]{6}$/);
    const made = mkdtempSync(join(tmpdir(), "bz-leaky-"));
    writeFileSync(join(made, "file"), "x");

    teardown();

    expect(existsSync(root)).toBe(false);
    expect(existsSync(made)).toBe(false);
  });

  it("removes nothing beside its own run root, and gives TMPDIR back", () => {
    const sibling = mkdtempSync("/tmp/bz-run-sibling-");
    siblings.push(sibling);
    const original = tmpdir();
    setup();

    teardown();

    expect(existsSync(sibling)).toBe(true);
    expect(tmpdir()).toBe(original);
  });
});
