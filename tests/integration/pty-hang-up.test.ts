import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { PtyProcess } from "@bazhen/core";
import { nodePtySpawner } from "@bazhen/daemon/pty";
import { attachClient, testServer, tmuxOut } from "./helpers.ts";

const server = testServer("pty-hang-up");
afterAll(() => server.killServer());
afterEach(() => {
  vi.restoreAllMocks();
});

const exited = (pty: PtyProcess) => new Promise<number>((resolve) => pty.onExit(resolve));

const SHELL_ENV = { PATH: process.env["PATH"] ?? "/usr/bin:/bin" };

const clients = () => tmuxOut(server, "list-clients", "-F", "#{client_pid}").trim();

describe("the PTY seam's hang-up", () => {
  it("ends a live child by the kernel's hang-up, and sends no signal itself", async () => {
    const pty = nodePtySpawner.spawn(["sh", "-c", "read line"], { cols: 80, rows: 24 }, SHELL_ENV);
    const exit = exited(pty);
    const sent = vi.spyOn(process, "kill").mockImplementation(() => true);
    pty.hangUp();
    expect(sent).not.toHaveBeenCalled();
    await exit;
  });

  it("hangs up a tmux client that has already left, and sends no signal", async () => {
    tmuxOut(server, "new-session", "-d", "-s", "gone", "sleep", "300");
    tmuxOut(server, "new-session", "-d", "-s", "kept", "sleep", "300");
    const client = attachClient(server, "gone");
    const exit = exited(client);
    await expect.poll(clients, { timeout: 5_000 }).not.toBe("");
    tmuxOut(server, "kill-session", "-t", "gone");
    await exit;
    const sent = vi.spyOn(process, "kill").mockImplementation(() => true);
    client.hangUp();
    expect(sent).not.toHaveBeenCalled();
  });
});
