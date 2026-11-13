import { describe, expect, it } from "vitest";
import {
  newId,
  NoTerminal,
  ProcessState,
  UnsupportedHarness,
  type HarnessAdapter,
  type RuntimeAdapter,
} from "@bazhen/core";
import { FakeRuntime } from "@bazhen/core/testing";
import { LocalEnvironment, loginArgv } from "./index.ts";

const harness: HarnessAdapter = {
  id: "claude-code",
  launchSpec: async () => ({
    argv: ["claude", "--session-id", "s-1"],
    env: { HARNESS_OWN: "1" },
    externalRef: { kind: "claude-session", id: "s-1" },
  }),
};

const environment = (runtime: RuntimeAdapter) =>
  new LocalEnvironment({ id: newId("env"), runtime, harnesses: [harness], socket: "/run/b.sock" });

const launch = (harnessId: "claude-code" | "codex" = "claude-code") => ({
  agentId: newId("agent"),
  terminalId: newId("term"),
  request: { harness: harnessId, project: "p", cwd: "/work" },
  size: { cols: 80, rows: 24 },
});

/** The terminal a launch made; every launch here makes one. */
async function terminalOf(env: LocalEnvironment, l: ReturnType<typeof launch>) {
  const { runtime } = await env.launch(l);
  if (runtime === null) throw new Error("the launch made no terminal");
  return runtime;
}

describe("local environment", () => {
  it("runs the harness's TUI in a terminal tagged with its agent, with Bazhen's variables", async () => {
    const runtime = new FakeRuntime();
    const l = launch();
    expect(runtime.specOf(await terminalOf(environment(runtime), l))).toEqual({
      terminalId: l.terminalId,
      tags: { kind: "agent", agentId: l.agentId },
      argv: ["claude", "--session-id", "s-1"],
      cwd: "/work",
      env: { HARNESS_OWN: "1", BAZHEN_AGENT_ID: l.agentId, BAZHEN_SOCKET: "/run/b.sock" },
      size: { cols: 80, rows: 24 },
      generation: 0,
    });
  });

  it("starts the TUI through the user's login shell, when there is one", async () => {
    const runtime = new FakeRuntime();
    const env = new LocalEnvironment({
      id: newId("env"),
      runtime,
      harnesses: [harness],
      socket: "/run/b.sock",
      loginShell: "/bin/zsh",
    });
    expect(runtime.specOf(await terminalOf(env, launch())).argv).toEqual(
      loginArgv("/bin/zsh", ["claude", "--session-id", "s-1"]),
    );
  });

  it("hands a login shell the TUI's argv as its own arguments, quoting nothing", () => {
    const argv = ["claude", "it's", "a\\b", "$HOME;#{x}"];
    expect(loginArgv("/usr/bin/fish", argv)).toEqual([
      "/usr/bin/fish",
      "-l",
      "-i",
      "-c",
      "exec $argv",
      ...argv,
    ]);
    expect(loginArgv("/bin/bash", argv)).toEqual([
      "/bin/bash",
      "-l",
      "-i",
      "-c",
      'exec "$@"',
      "sh",
      ...argv,
    ]);
  });

  it("names the harness session it launched, in this environment", async () => {
    const env = environment(new FakeRuntime());
    const refs = await env.launch(launch());
    expect(refs.externalRef).toEqual({ environmentId: env.id, kind: "claude-session", id: "s-1" });
  });

  it("refuses to close an agent with no terminal recorded, rather than call it closed", async () => {
    const runtime = new FakeRuntime();
    await expect(environment(runtime).close({ runtime: null, externalRef: null })).rejects.toThrow(
      NoTerminal,
    );
  });

  it("refuses a harness it has no adapter for, rather than emulating it", async () => {
    const runtime = new FakeRuntime();
    await expect(environment(runtime).launch(launch("codex"))).rejects.toThrow(UnsupportedHarness);
    expect((await runtime.health()).state).toBe("not-running");
  });

  it("is reachable while its tmux server runs or none does, and unreachable while it can't be read", async () => {
    const running = new FakeRuntime();
    await environment(running).launch(launch());
    const unreadable = new FakeRuntime();
    await environment(unreadable).launch(launch());
    unreadable.disconnect();
    const runtimes = [running, new FakeRuntime(), unreadable];
    const states = await Promise.all(
      runtimes.map(async (runtime) => (await environment(runtime).health()).state),
    );
    expect(states).toEqual(["reachable", "reachable", "unreachable"]);
  });

  it("lists only agent terminals, by the agent their tags name", async () => {
    const runtime = new FakeRuntime();
    const env = environment(runtime);
    const l = launch();
    const ref = await terminalOf(env, l);
    await runtime.create({
      ...runtime.specOf(ref),
      terminalId: newId("term"),
      tags: { kind: "shell" },
    });
    expect(await env.inventory()).toEqual([{ agentId: l.agentId, ref, dead: false }]);
  });

  it("refuses to respawn a terminal whose process still runs, before the harness resumes anything", async () => {
    const runtime = new FakeRuntime();
    let resumed = 0;
    const resumable: HarnessAdapter = {
      ...harness,
      resumeSpec: async () => {
        resumed++;
        return harness.launchSpec({ harness: "claude-code", project: "p", cwd: "/work" });
      },
    };
    const env = new LocalEnvironment({
      id: newId("env"),
      runtime,
      harnesses: [resumable],
      socket: "/run/b.sock",
    });
    const l = launch();
    const refs = await env.launch(l);
    await expect(
      env.respawn({ agentId: l.agentId, request: l.request, refs, generation: 1 }),
    ).rejects.toThrow(ProcessState);
    expect(resumed).toBe(0);
  });
});
