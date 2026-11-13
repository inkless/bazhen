import { afterAll, describe, expect, it } from "vitest";
import { AgentTerminalExists, filterEnv, newId } from "@bazhen/core";
import { LocalEnvironment } from "@bazhen/env-local";
import { TmuxRuntime } from "@bazhen/runtime-tmux";
import { nodePtySpawner } from "@bazhen/daemon/pty";
import { testServer } from "./helpers.ts";

const server = testServer("guard");
const runtime = new TmuxRuntime({ server, pty: nodePtySpawner, env: filterEnv(process.env).env });
const environment = new LocalEnvironment({
  id: newId("env"),
  runtime,
  socket: "/run/b.sock",
  harnesses: [
    {
      id: "claude-code",
      launchSpec: async (request) => ({
        argv: [...argvFor(request.project)],
        env: {},
        externalRef: null,
      }),
    },
  ],
});
/** The test's program for each project name: one that runs on, and one that exits at once. */
const argvFor = (project: string): [string, ...string[]] =>
  project === "exits" ? ["sh", "-c", "exit 0"] : ["sleep", "300"];

const launch = (agentId: ReturnType<typeof newId<"agent">>, project = "runs") =>
  environment.launch({
    agentId,
    terminalId: newId("term"),
    request: { harness: "claude-code", project, cwd: process.cwd() },
    options: {},
    size: { cols: 80, rows: 24 },
  });

afterAll(() => server.kill());

describe("one terminal per agent", () => {
  it("refuses to start a second terminal for an agent a live one already carries", async () => {
    const agentId = newId("agent");
    await launch(agentId);
    await expect(launch(agentId)).rejects.toThrow(AgentTerminalExists);
    const carrying = (await environment.inventory()).filter((e) => e.agentId === agentId);
    expect(carrying).toHaveLength(1);
  });

  it("refuses a second terminal for an agent whose terminal is dead but kept", async () => {
    const agentId = newId("agent");
    await launch(agentId, "exits");
    await expect
      .poll(async () => (await environment.inventory()).find((e) => e.agentId === agentId)?.dead, {
        timeout: 10_000,
      })
      .toBe(true);
    await expect(launch(agentId)).rejects.toThrow(AgentTerminalExists);
  });
});
