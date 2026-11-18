import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CHILD = JSON.stringify(fileURLToPath(new URL("child.ts", import.meta.url)));

/**
 * Runs, in a Node process of its own, a start of a child that exits before it reads a write far
 * past a socketpair's buffer, so the write is still pending when the pipe breaks. How it ends:
 * an unheard broken pipe ends the process it happens in, so it can't run in this one.
 */
function breakStdin(start: string): Promise<{ code: number | null; out: string; err: string }> {
  const caller = `
    import { execFile } from "node:child_process";
    import { heard } from ${CHILD};
    const child = ${start};
    child.on("close", (code) => console.log("closed", code));
    child.stdin.end("x".repeat(1024 * 1024));
  `;
  return new Promise((done) => {
    execFile(
      process.execPath,
      ["--input-type=module", "-e", caller],
      { encoding: "utf8" },
      (error, out, err) => done({ code: error === null ? 0 : Number(error.code), out, err }),
    );
  });
}

describe("a child that exits before it reads what it was written", () => {
  it("ends by its exit when heard, and ends nothing else", async () => {
    const ran = await breakStdin('heard(execFile("sh", ["-c", "exit 3"]))');
    expect(ran).toMatchObject({ code: 0, out: "closed 3\n" });
  });

  it("ends the process it was started from when unheard, which is what heard prevents", async () => {
    const ran = await breakStdin('execFile("sh", ["-c", "exit 3"])');
    expect(ran.code).toBe(1);
    expect(ran.err).toMatch(/EPIPE/);
  });
});
