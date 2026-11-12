import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { newId } from "@bazhen/core";

const client = fileURLToPath(new URL("hook-client.ts", import.meta.url));
let server: Server | undefined;
let dir = "";
afterEach(() => {
  server?.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Runs the hook client for `event` as a harness would, and resolves with how it exited. */
function run(event: string, env: Record<string, string>) {
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", client, event], {
    env: { PATH: process.env["PATH"] ?? "", ...env },
  });
  child.stdin.end("{}");
  let stderr = "";
  child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
  return new Promise<{ code: number | null; stderr: string }>((resolve) =>
    child.on("exit", (code) => resolve({ code, stderr })),
  );
}

/** A daemon socket that answers every hook with `body` and `status`. */
function listen(
  socket: string,
  body = JSON.stringify({ exitCode: 2, stdout: "", stderr: "mail", offered: [] }),
  status = 200,
) {
  server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.statusCode = status;
      res.end(body);
    });
  });
  server.listen(socket);
}

describe("hook client", () => {
  it("does nothing outside a Bazhen agent", async () => {
    expect(await run("Stop", {})).toEqual({ code: 0, stderr: "" });
  });

  it("keeps the waiter trying until the daemon's socket answers, then wakes the session", async () => {
    dir = mkdtempSync(join(tmpdir(), "bz-hook-"));
    const socket = join(dir, "bazhen.sock");
    const waiting = run("wait", { BAZHEN_AGENT_ID: newId("agent"), BAZHEN_SOCKET: socket });
    // Nothing listens yet, as while the daemon restarts; the waiter must not give up.
    setTimeout(() => listen(socket), 1500);
    expect(await waiting).toEqual({ code: 2, stderr: "mail" });
  });

  it("fails open on a reply that isn't the daemon's JSON", async () => {
    dir = mkdtempSync(join(tmpdir(), "bz-hook-"));
    const socket = join(dir, "bazhen.sock");
    listen(socket, "Internal Server Error", 500);
    await new Promise((r) => server?.once("listening", r));
    expect(
      await run("PermissionRequest", { BAZHEN_AGENT_ID: newId("agent"), BAZHEN_SOCKET: socket }),
    ).toEqual({
      code: 0,
      stderr: "",
    });
  });
});
