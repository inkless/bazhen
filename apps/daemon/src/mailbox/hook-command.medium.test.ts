import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hookCommand } from "./hook-command.ts";

let dir = "";
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("hook command", () => {
  it("runs the client through a shell even when its path has spaces, quotes and $", () => {
    dir = mkdtempSync(join(tmpdir(), "bz-hook-"));
    const odd = join(dir, `it's a "dir" $HOME`);
    mkdirSync(odd);
    const client = join(odd, "client.ts");
    writeFileSync(client, "process.stdout.write(process.argv.slice(2).join(','));\n");
    const out = execFileSync("/bin/sh", ["-c", `${hookCommand(process.execPath, client)} wait`]);
    expect(out.toString()).toBe("wait");
  });
});
