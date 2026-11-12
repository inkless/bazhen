import { afterEach, describe, expect, it } from "vitest";
import { tmuxVersion, type TmuxServer } from "@bazhen/host-guard";
import { testServer } from "./helpers.ts";

// These pin tmux behaviour the runtime is built around. A pin that holds only before some tmux
// release says so, and asserts the fixed behaviour from that release on, so it holds on every
// version a runner or developer may have installed. If one starts failing after a tmux upgrade,
// the defect's boundary has moved: re-verify it, move the boundary, and say so in the commit.
const servers: TmuxServer[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.kill();
});

function freshServer(label: string): TmuxServer {
  const server = testServer(label, "/dev/null");
  servers.push(server);
  server.runSync(["new-session", "-d", "-s", "a", "cat"]);
  return server;
}

const tmux = (server: TmuxServer, ...args: string[]) => {
  try {
    server.runSync(args, { stdio: "ignore" });
  } catch {}
};

const [major, minor] = tmuxVersion();

// Verified to crash on 3.4 and 3.6b, and not on 3.8. 3.7 is unverified, so it counts as crashing.
const globalManualCrashes = major < 3 || (major === 3 && minor < 8);

describe("tmux window-size defect", () => {
  it("kills the server below tmux 3.8, and not from 3.8, when window-size manual is set globally", () => {
    const server = freshServer("defect-global");
    tmux(server, "set-option", "-g", "window-size", "manual");
    tmux(server, "new-window", "-d", "cat");
    expect(server.alive()).toBe(!globalManualCrashes);
  });

  it("survives window-size manual set per window, which the runtime relies on", () => {
    const server = freshServer("defect-window");
    tmux(server, "set-option", "-w", "-t", "a:0", "window-size", "manual");
    tmux(server, "new-window", "-d", "cat");
    expect(server.alive()).toBe(true);
  });
});
