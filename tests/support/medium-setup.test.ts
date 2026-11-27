import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setup, teardown } from "./medium-setup.ts";

const KEPT = ["TMPDIR", "TMUX_TMPDIR", "BAZHEN_HOME", "TMUX", "TMUX_PANE"] as const;
const before = new Map(KEPT.map((name) => [name, process.env[name]]));
const leftover: string[] = [];
// The error node's rmSync gives for a file it can't unlink in a read-only directory. Linux's
// reports the file's EACCES; macOS's drops it and reports the directory it then leaves, not empty.
const UNREMOVABLE = process.platform === "darwin" ? /^ENOTEMPTY\b/ : /^EACCES\b/;

afterEach(() => {
  try {
    teardown();
  } finally {
    for (const [name, value] of before) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    for (const dir of leftover.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("the medium suite's temporary directory", () => {
  it("puts every directory a test makes under one run root, which teardown alone removes", () => {
    const sibling = mkdtempSync("/tmp/bz-run-sibling-");
    leftover.push(sibling);
    const original = tmpdir();

    setup();
    const root = tmpdir();
    expect(root).toMatch(/^\/tmp\/bz-run-[A-Za-z0-9]{6}$/);
    const made = mkdtempSync(join(tmpdir(), "bz-leaky-"));
    writeFileSync(join(made, "file"), "x");

    teardown();

    expect(existsSync(root)).toBe(false);
    expect(existsSync(made)).toBe(false);
    expect(existsSync(sibling)).toBe(true);
    expect(tmpdir()).toBe(original);
  });

  // As root a directory's mode doesn't stop its removal.
  it.skipIf(process.getuid?.() === 0)(
    "still gives TMPDIR back when a directory can't be removed, and says so",
    () => {
      const original = tmpdir();
      setup();
      const root = tmpdir();
      expect(root).toMatch(/^\/tmp\/bz-run-[A-Za-z0-9]{6}$/);
      const locked = join(root, "locked");
      mkdirSync(locked);
      writeFileSync(join(locked, "file"), "x");
      chmodSync(locked, 0o500);
      leftover.push(root);

      try {
        expect(() => teardown()).toThrow(UNREMOVABLE);
        expect(tmpdir()).toBe(original);
      } finally {
        chmodSync(locked, 0o700);
      }
    },
  );
});
