import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { killServer, serverAlive, testSocket } from "./helpers.ts";

// These pin tmux behaviour the runtime is built around. If one starts failing after a tmux
// upgrade, the defect is fixed upstream and the workaround (and the rejection of control mode)
// can be reconsidered.
const sockets: string[] = [];
afterEach(() => {
  while (sockets.length) killServer(sockets.pop()!);
});

function freshServer(label: string): string {
  const socket = testSocket(label);
  sockets.push(socket);
  execFileSync("tmux", ["-L", socket, "-f", "/dev/null", "new-session", "-d", "-s", "a", "cat"]);
  return socket;
}

const tmux = (socket: string, ...args: string[]) => {
  try {
    execFileSync("tmux", ["-L", socket, ...args], { stdio: "ignore" });
  } catch {}
};

describe("tmux window-size defect", () => {
  it("still crashes the server when window-size manual is set globally", () => {
    const socket = freshServer("defect-global");
    tmux(socket, "set-option", "-g", "window-size", "manual");
    tmux(socket, "new-window", "-d", "cat");
    expect(serverAlive(socket)).toBe(false);
  });

  it("survives window-size manual set per window, which the runtime relies on", () => {
    const socket = freshServer("defect-window");
    tmux(socket, "set-option", "-w", "-t", "a:0", "window-size", "manual");
    tmux(socket, "new-window", "-d", "cat");
    expect(serverAlive(socket)).toBe(true);
  });
});
