import { afterEach, describe, expect, it } from "vitest";
import { tmuxVersion, type TmuxServer } from "@bazhen/host-guard";
import { attachClient, testServer, tmuxOut } from "./helpers.ts";

// These pin tmux behaviour the runtime is built around. A pin that holds only before some tmux
// release says so, and asserts the fixed behaviour from that release on, so it holds on every
// version a runner or developer may have installed. If one starts failing after a tmux upgrade,
// the defect's boundary has moved: re-verify it, move the boundary, and say so in the commit.
const servers: TmuxServer[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.killServer();
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

// Fixed in 3.5 (tmux GitHub issue 3776): 3.4 writes a focus report to a dead pane's freed event.
const deadPaneFocusCrashes = major < 3 || (major === 3 && minor < 5);

/** A pane that may ask for focus reports and exits on the next line typed, as a killed TUI does. */
function focusPane(label: string, request: string): TmuxServer {
  const server = freshServer(label);
  tmux(server, "set-option", "-g", "remain-on-exit", "on");
  tmux(server, "new-session", "-d", "-s", "f", "sh", "-c", `printf '${request}'; read x`);
  return server;
}

const FOCUS_ON = "\\033[?1004h";

const attach = (server: TmuxServer) => attachClient(server, "f");

/** Whether a client shows the pane's session: false once none does, or the server is gone. */
const shown = (server: TmuxServer) =>
  server.alive() && tmuxOut(server, "list-clients", "-t", "f").trim() !== "";

/** Whether the server is gone, or a client attaching to the pane got in. */
const settledAttach = (server: TmuxServer) => !server.alive() || shown(server);

async function exitPane(server: TmuxServer) {
  tmux(server, "send-keys", "-t", "f", "Enter");
  await expect
    .poll(() => tmuxOut(server, "display-message", "-p", "-t", "f", "#{pane_dead}").trim(), {
      timeout: 5_000,
    })
    .toBe("1");
}

describe("tmux dead-pane focus defect", () => {
  it("kills the server below tmux 3.5 when the last client leaves a dead pane", async () => {
    const server = focusPane("defect-focus-leave", FOCUS_ON);
    const client = attach(server);
    await expect.poll(() => shown(server), { timeout: 5_000 }).toBe(true);
    await exitPane(server);
    client.hangUp();
    await expect.poll(() => shown(server), { timeout: 5_000 }).toBe(false);
    expect(server.alive()).toBe(!deadPaneFocusCrashes);
  });

  it("kills the server below tmux 3.5 when a client attaches to a dead pane", async () => {
    const server = focusPane("defect-focus-attach", FOCUS_ON);
    await exitPane(server);
    const client = attach(server);
    await expect.poll(() => settledAttach(server), { timeout: 5_000 }).toBe(true);
    client.hangUp();
    expect(server.alive()).toBe(!deadPaneFocusCrashes);
  });

  it("survives on every version when the dead pane never asked for focus reports", async () => {
    const server = focusPane("defect-focus-none", "");
    const first = attach(server);
    await expect.poll(() => shown(server), { timeout: 5_000 }).toBe(true);
    await exitPane(server);
    first.hangUp();
    await expect.poll(() => shown(server), { timeout: 5_000 }).toBe(false);
    const again = attach(server);
    await expect.poll(() => settledAttach(server), { timeout: 5_000 }).toBe(true);
    again.hangUp();
    await expect.poll(() => shown(server), { timeout: 5_000 }).toBe(false);
    expect(server.alive()).toBe(true);
  });
});
