import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HealthResponse, ShellCommandResponse, StateSnapshot } from "@bazhen/protocol";
import { closeHolderAt, holderSockets } from "../support/holder-close.ts";
import { bazhen, Daemon, replaceHolderChild, waitUntil } from "./daemon.ts";
import { startFakeModel, type FakeModel } from "./fake-model.ts";

let model: FakeModel;

const snapshot = async (daemon: Daemon) =>
  StateSnapshot.parse((await daemon.request("/v1/state")).body);

async function openShell(daemon: Daemon, key: string): Promise<string> {
  const opened = await daemon.request("/v1/shells", {
    method: "POST",
    body: { idempotencyKey: key, cwd: daemon.work },
  });
  return ShellCommandResponse.parse(opened.body).terminalId;
}

const runtimeOf = (command: string | null) =>
  command === null ? "none" : command.startsWith("bazhen terminals attach") ? "holder" : "tmux";

/** Each runtime the daemon reports, as `<kind>: <state>`. */
async function runtimeStates(daemon: Daemon): Promise<string[]> {
  const { runtimes } = HealthResponse.parse((await daemon.request("/v1/health")).body);
  return runtimes.map((r) => `${r.kind}: ${r.state}`);
}

/** Each terminal's state and the runtime its attach command names, by TerminalId. */
async function terminals(daemon: Daemon): Promise<Record<string, string>> {
  const { agents, shells } = await snapshot(daemon);
  return Object.fromEntries([
    ...agents.map((a) => [String(a.terminalId), `${a.state} on ${runtimeOf(a.attachCommand)}`]),
    ...shells.map((s) => [s.id, `${s.state} on ${runtimeOf(s.attachCommand)}`]),
  ]);
}

beforeAll(async () => {
  model = await startFakeModel();
});
afterAll(async () => {
  await model?.close();
});

describe("a daemon running terminals on both runtimes", () => {
  let daemon: Daemon;
  let onTmux: string;
  let holderShell: string;
  let holderAgent: string;

  beforeAll(async () => {
    daemon = await Daemon.start({ modelUrl: model.url, runtime: "tmux" });
    onTmux = await openShell(daemon, "tmux-shell");
    await daemon.crash();
    daemon.useRuntime("holder");
    await daemon.restart();
    holderShell = await openShell(daemon, "holder-shell");
    const launched = await daemon.launch("holder-agent");
    holderAgent = String(launched.terminalId);
    await daemon.running(launched.agentId);
  }, 120_000);
  afterAll(async () => {
    await daemon?.stop();
  });

  it("makes new terminals on the default, and keeps the old one where it was made", async () => {
    expect(await terminals(daemon)).toEqual({
      [onTmux]: "running on tmux",
      [holderShell]: "running on holder",
      [holderAgent]: "running on holder",
    });
    expect(holderSockets(daemon.home).toSorted()).toEqual(
      [holderShell, holderAgent].map((id) => `${daemon.home}/run/holders/${id}.sock`).toSorted(),
    );
  });

  it("finds each one on its own runtime after a crash", async () => {
    await daemon.crash();
    await daemon.restart();
    expect(await terminals(daemon)).toEqual({
      [onTmux]: "running on tmux",
      [holderShell]: "running on holder",
      [holderAgent]: "running on holder",
    });
  });

  it("calls only the agent whose holder ended lost, while the daemon runs, and leaves the rest", async () => {
    await closeHolderAt(`${daemon.home}/run/holders/${holderAgent}.sock`);
    await expect
      .poll(async () => (await terminals(daemon))[holderAgent], { timeout: 30_000 })
      .toBe("lost on none");
    expect(await terminals(daemon)).toEqual({
      [onTmux]: "running on tmux",
      [holderShell]: "running on holder",
      [holderAgent]: "lost on none",
    });
  });

  it("reads tmux while a terminal is open on it, though holders are the default, and not after", async () => {
    const whileOpen = await runtimeStates(daemon);
    const closed = await daemon.request(`/v1/shells/${onTmux}/close`, {
      method: "POST",
      body: { idempotencyKey: "close-tmux-shell", generation: 0 },
    });
    expect([whileOpen, closed.status]).toEqual([["tmux: healthy", "holder: healthy"], 200]);
    await expect
      .poll(() => runtimeStates(daemon), { timeout: 15_000 })
      .toEqual(["tmux: unused", "holder: healthy"]);
  });
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
