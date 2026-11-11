import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { killServer, serverAlive, testSocket } from "./helpers.ts";

// These pin tmux behaviour the runtime is built around. A pin that holds only before some tmux
// release says so, and asserts the fixed behaviour from that release on, so it holds on every
// version a runner or developer may have installed. If one starts failing after a tmux upgrade,
// the defect's boundary has moved: re-verify it, move the boundary, and say so in the commit.
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

/** `[major, minor]` of the installed tmux, from `tmux 3.6b` or `tmux next-3.9`. */
function tmuxVersion(): [number, number] {
  const out = execFileSync("tmux", ["-V"]).toString().trim();
  const match = /^tmux (?:next-)?(\d+)\.(\d+)/.exec(out);
  if (match === null) throw new Error(`Unrecognised tmux version: ${out}`);
  return [Number(match[1]), Number(match[2])];
}

const [major, minor] = tmuxVersion();

// Verified to crash on 3.4 and 3.6b, and not on 3.8. 3.7 is unverified, so it counts as crashing.
const globalManualCrashes = major < 3 || (major === 3 && minor < 8);

describe("tmux window-size defect", () => {
  it("kills the server below tmux 3.8, and not from 3.8, when window-size manual is set globally", () => {
    const socket = freshServer("defect-global");
    tmux(socket, "set-option", "-g", "window-size", "manual");
    tmux(socket, "new-window", "-d", "cat");
    expect(serverAlive(socket)).toBe(!globalManualCrashes);
  });

  it("survives window-size manual set per window, which the runtime relies on", () => {
    const socket = freshServer("defect-window");
    tmux(socket, "set-option", "-w", "-t", "a:0", "window-size", "manual");
    tmux(socket, "new-window", "-d", "cat");
    expect(serverAlive(socket)).toBe(true);
  });
});
