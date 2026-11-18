import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeHolderAt, holderSockets } from "../support/holder-close.ts";
import { bazhen, Daemon, replaceHolderChild, waitUntil } from "./daemon.ts";
import { startFakeModel, type FakeModel } from "./fake-model.ts";
import { openShell, runtimeStates, snapshot, terminals } from "./runtime-states.ts";

let model: FakeModel;

beforeAll(async () => {
  model = await startFakeModel();
});
afterAll(async () => {
  await model?.close();
});

describe("a holder daemon on a machine without tmux", () => {
  let daemon: Daemon;

  beforeAll(async () => {
    daemon = await Daemon.start({ runtime: "holder", withoutTmux: true });
  }, 60_000);
  afterAll(async () => {
    await daemon?.stop();
  });

  it("reports tmux unused, and passes doctor", async () => {
    const doctor = await bazhen(["doctor"], daemon.env);
    expect([
      await runtimeStates(daemon),
      doctor.code,
      doctor.out.split("\n").filter((l) => l.startsWith("tmux")),
    ]).toEqual([["tmux: unused", "holder: not-running"], 0, ["tmux: unused"]]);
  });

  it("runs no tmux while a holder shell runs, beyond asking its version at start", async () => {
    const shell = await openShell(daemon, "no-tmux-shell");
    await expect
      .poll(async () => (await terminals(daemon))[shell], { timeout: 30_000 })
      .toBe("running on holder");
    const view = await daemon.view(shell, "interactive");
    await view.drive();
    view.type("sleep 300\r");
    // The shell's foreground is read through every runtime that is read, so once it says sleep
    // the foregrounds have been read at least once with tmux unused, and its exit polls have run.
    await expect
      .poll(
        async () =>
          (await snapshot(daemon)).shells.find((s) => s.id === shell)?.foreground?.command,
        { timeout: 15_000 },
      )
      .toBe("sleep");
    view.close();
    expect(daemon.tmuxRan()).toEqual([expect.stringMatching(/ -V$/)]);
  });
});

describe("an agent whose holder ran a new process while the daemon was down", () => {
  let daemon: Daemon;
  let agentId: string;

  /** The agent's state and generation, as a client is shown them. */
  const agent = async () => {
    const found = (await snapshot(daemon)).agents.find((a) => a.id === agentId);
    return [found?.state, found?.generation];
  };
  const command = (name: string, body: Record<string, unknown>) =>
    daemon.request(`/v1/agents/${agentId}/${name}`, {
      method: "POST",
      body: { idempotencyKey: name, ...body },
    });

  beforeAll(async () => {
    daemon = await Daemon.start({ modelUrl: model.url, runtime: "holder" });
    const launched = await daemon.launch("replaced");
    agentId = launched.agentId;
    await daemon.running(agentId);
    // A turn on disk, so the agent's session can be resumed once the new process exits.
    await daemon.prompt(launched, "Remember the word kestrel.");
    await waitUntil(
      () => daemon.transcript(agentId).includes('"type":"assistant"'),
      "the turn in its transcript",
      30_000,
    );
    await daemon.crash();
    const socket = daemon.holderOf(agentId);
    if (socket === undefined) throw new Error(`${agentId} has no holder`);
    await replaceHolderChild(socket, ["sleep", "600"]);
    await daemon.restart();
  }, 120_000);
  afterAll(async () => {
    await daemon?.stop();
  });

  it("takes the new process as the agent's own, waiting on its harness", async () => {
    await expect.poll(agent, { timeout: 30_000 }).toEqual(["starting", 1]);
  });

  it("signals the new process, records its exit, and respawns past it", async () => {
    expect(await command("signal", { generation: 1, signal: "SIGTERM" })).toMatchObject({
      status: 200,
    });
    await expect.poll(agent, { timeout: 30_000 }).toEqual(["exited", 1]);
    expect(await command("respawn", { generation: 1 })).toMatchObject({ status: 200 });
    await expect.poll(async () => (await agent())[1], { timeout: 30_000 }).toBe(2);
  });
});

describe("an agent whose holder ran a new process while the daemon runs", () => {
  let daemon: Daemon;
  let agentId: string;
  let socket: string;

  /** The agent's state and generation, as a client is shown them. */
  const agent = async () => {
    const found = (await snapshot(daemon)).agents.find((a) => a.id === agentId);
    return [found?.state, found?.generation];
  };

  beforeAll(async () => {
    daemon = await Daemon.start({ modelUrl: model.url, runtime: "holder" });
    const launched = await daemon.launch("replaced-live");
    agentId = launched.agentId;
    await daemon.running(agentId);
    const found = daemon.holderOf(agentId);
    if (found === undefined) throw new Error(`${agentId} has no holder`);
    socket = found;
  }, 120_000);
  afterAll(async () => {
    await daemon?.stop();
  });

  it("takes the new process as the agent's own without waiting for it to exit", async () => {
    await replaceHolderChild(socket, ["sleep", "600"]);
    await expect.poll(agent, { timeout: 15_000 }).toEqual(["starting", 1]);
  });

  it("signals the new process, and records its exit", async () => {
    const signalled = await daemon.request(`/v1/agents/${agentId}/signal`, {
      method: "POST",
      body: { idempotencyKey: "signal", generation: 1, signal: "SIGTERM" },
    });
    expect(signalled).toMatchObject({ status: 200 });
    await expect.poll(agent, { timeout: 30_000 }).toEqual(["exited", 1]);
  });
});

describe("a daemon running terminals on several holders", () => {
  let daemon: Daemon;
  let shell: string;
  let agent: string;

  /** Whether the shell still runs what it is typed: a holder of its own, untouched by the rest. */
  async function answers(key: string): Promise<void> {
    const view = await daemon.view(shell, "interactive");
    await view.drive();
    view.type(`echo ${key}-$((6*7))\r`);
    await expect
      .poll(() => daemon.terminalScreen(shell), { timeout: 10_000 })
      .toContain(`${key}-42`);
    view.close();
  }

  beforeAll(async () => {
    daemon = await Daemon.start({ modelUrl: model.url });
    shell = await openShell(daemon, "shell");
    const launched = await daemon.launch("agent");
    agent = String(launched.terminalId);
    await daemon.running(launched.agentId);
  }, 120_000);
  afterAll(async () => {
    await daemon?.stop();
  });

  it("finds each terminal on its own holder after a crash", async () => {
    await daemon.crash();
    await daemon.restart();
    expect([await terminals(daemon), holderSockets(daemon.home).toSorted()]).toEqual([
      { [shell]: "running on holder", [agent]: "running on holder" },
      [shell, agent].map((id) => `${daemon.home}/run/holders/${id}.sock`).toSorted(),
    ]);
    await answers("after-crash");
  });

  it("calls only the agent whose holder ended lost, and leaves the shell running", async () => {
    await closeHolderAt(`${daemon.home}/run/holders/${agent}.sock`);
    await expect
      .poll(async () => (await terminals(daemon))[agent], { timeout: 30_000 })
      .toBe("lost on none");
    expect(await terminals(daemon)).toEqual({
      [shell]: "running on holder",
      [agent]: "lost on none",
    });
    await answers("after-end");
  });
});
