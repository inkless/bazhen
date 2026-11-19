import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ShellCommandResponse, StateSnapshot } from "@bazhen/protocol";
import { attachInScript, Daemon, DETACH } from "./daemon.ts";
import { closeWhileAttached } from "./attach-close.ts";

const state = async (daemon: Daemon) =>
  StateSnapshot.parse((await daemon.request("/v1/state")).body);

/** What an attach says once an agent's harness exits with code 0, on a thread it resumes. */
const nextSteps = (name: string) =>
  `${name}: Claude Code exited (code 0); its terminal and thread are kept. ` +
  `\`bazhen agents respawn ${name}\` starts it again on the same thread; ` +
  `\`bazhen agents close ${name}\` ends it.`;

describe("bazhen terminals attach, on a holder terminal", () => {
  let daemon: Daemon;
  let left: (() => void)[] = [];
  beforeAll(async () => {
    daemon = await Daemon.start();
  });
  afterEach(() => {
    for (const leave of left) leave();
    left = [];
  });
  afterAll(async () => {
    await daemon?.stop();
  });

  async function shell(key: string): Promise<string> {
    const opened = await daemon.request("/v1/shells", {
      method: "POST",
      body: { idempotencyKey: key, cwd: daemon.work },
    });
    return ShellCommandResponse.parse(opened.body).terminalId;
  }

  it("types into the terminal, shows what it prints, and detaches leaving it running", async () => {
    const terminalId = await shell("typed");
    const attached = attachInScript(daemon, terminalId);
    left.push(attached.leave);
    attached.type("printf 'attached-%s\\n' 42\r");
    await attached.shows("attached-42", "the command's output");
    attached.type(DETACH);
    const code = await attached.exited;
    const shells = (await state(daemon)).shells;
    expect([
      code,
      attached.shown().includes(`attaching to ${terminalId}: Ctrl-] Ctrl-] detaches`),
      attached.shown().includes(`detached from ${terminalId}`),
    ]).toEqual([0, true, true]);
    expect(shells.find((s) => s.id === terminalId)?.state).toBe("running");
  });

  it("refuses detach keys that name none, before it attaches", async () => {
    const terminalId = await shell("bad-keys");
    const attached = attachInScript(daemon, `${terminalId} --detach-keys ctrl-1`);
    left.push(attached.leave);
    expect([
      await attached.exited,
      attached.shown().includes('--detach-keys: "ctrl-1" isn\'t a key'),
      attached.shown().includes("attaching to"),
    ]).toEqual([2, true, false]);
  });

  it("with --direct while the daemon runs, only views: the web app's keys still land", async () => {
    const terminalId = await shell("viewed");
    const direct = attachInScript(daemon, `${terminalId} --direct`);
    left.push(direct.leave);
    direct.type("printf 'direct-%s\\n' 9\r");
    const view = await daemon.socketView(terminalId, "interactive");
    await view.drive();
    view.type("printf 'viewed-%s\\n' 7\r");
    await direct.shows("viewed-7", "the web's command, seen directly");
    direct.type(DETACH);
    const code = await direct.exited;
    view.close();
    expect([
      code,
      direct.shown().includes("direct-9"),
      direct.shown().includes("--direct only viewed the terminal"),
    ]).toEqual([0, false, true]);
  });

  it("ends, saying so, when the shell's program exits", async () => {
    const terminalId = await shell("exits");
    const attached = attachInScript(daemon, terminalId);
    left.push(attached.leave);
    attached.type("exit 0\r");
    const said = `${terminalId}: its program exited (code 0)`;
    await attached.shows(said, "the attach saying the shell exited");
    expect([await attached.exited, attached.shown().includes(said)]).toEqual([0, true]);
  });

  /**
   * An agent whose harness prints `ready`, then on a line typed prints its last words and exits
   * 0, as Codex does on `/exit`, on a session it can resume.
   */
  async function quitting(): Promise<{ agentId: string; terminalId: string; name: string }> {
    const program = await daemon.program([
      "sh",
      "-c",
      "printf 'ready\\n'; read line; printf 'last-words-%s\\n' 7; exit 0",
    ]);
    const agentOf = async () => (await state(daemon)).agents.find((a) => a.id === program.agentId);
    await daemon.giveTranscript(program.agentId, String((await agentOf())?.externalRef?.id));
    await expect.poll(async () => (await agentOf())?.resumable, { timeout: 10_000 }).toBe(true);
    return { ...program, name: String((await agentOf())?.name) };
  }

  it("ends after an agent's last output when its harness exits, and says how to start it again", async () => {
    const { agentId, name } = await quitting();
    const attached = attachInScript(daemon, name);
    left.push(attached.leave);
    await attached.shows("ready", "the harness's first output");
    attached.type("/exit\r");
    const said = nextSteps(name);
    await attached.shows(said, "the attach saying how to start the agent again");
    const code = await attached.exited;
    const shown = attached.shown();
    // Read the moment the attach ends: the daemon records the exit before it tells any view.
    const agent = (await state(daemon)).agents.find((a) => a.id === agentId);
    expect([
      code,
      shown.includes(said),
      shown.split(said)[0]?.includes("last-words-7"),
      agent?.state,
      agent?.commands.includes("respawn"),
    ]).toEqual([0, true, true, "exited", true]);
    const respawned = await daemon.request(`/v1/agents/${agentId}/respawn`, {
      method: "POST",
      body: { idempotencyKey: "respawn-after-exit", generation: 0 },
    });
    expect(respawned.status).toBe(200);
  });

  it("ends saying the terminal closed when its agent is closed, offering no respawn", async () => {
    expect(await closeWhileAttached(daemon, "close-attached")).toEqual([200, 0, false]);
  });

  it("with --direct, ends after an agent's last output when its harness exits", async () => {
    const { terminalId, name } = await quitting();
    const direct = attachInScript(daemon, `${terminalId} --direct`);
    left.push(direct.leave);
    await direct.shows("ready", "the harness's first output");
    const view = await daemon.socketView(terminalId, "interactive");
    await view.drive();
    view.type("/exit\r");
    const said = nextSteps(name);
    await direct.shows(said, "the attach saying how to start the agent again");
    const code = await direct.exited;
    view.close();
    const shown = direct.shown();
    expect([code, shown.includes(said), shown.split(said)[0]?.includes("last-words-7")]).toEqual([
      0,
      true,
      true,
    ]);
  });
});

describe("bazhen terminals attach, straight to the holder while the daemon is down", () => {
  let daemon: Daemon;
  let left: (() => void)[] = [];
  beforeAll(async () => {
    daemon = await Daemon.start();
  });
  afterEach(() => {
    for (const leave of left) leave();
    left = [];
  });
  afterAll(async () => {
    await daemon?.stop();
  });

  it("types there, and lets go of the input once the daemon is back", async () => {
    const opened = await daemon.request("/v1/shells", {
      method: "POST",
      body: { idempotencyKey: "straight", cwd: daemon.work },
    });
    const terminalId = ShellCommandResponse.parse(opened.body).terminalId;
    await daemon.crash();
    const direct = attachInScript(daemon, terminalId);
    left.push(direct.leave);
    direct.type("printf 'straight-%s\\n' 5\r");
    await direct.shows("straight-5", "the command's output");
    await daemon.restart();
    expect([
      await direct.exited,
      direct.shown().includes("bazhen is not running: attaching straight"),
      direct.shown().includes("the daemon is back, so this attachment let go"),
    ]).toEqual([0, true, true]);
  });
});

describe("bazhen terminals attach, with detach keys of the person's own", () => {
  let daemon: Daemon;
  let left: (() => void)[] = [];
  beforeAll(async () => {
    daemon = await Daemon.start({ config: '[attach]\ndetach_keys = "ctrl-p,ctrl-q"\n' });
  });
  afterEach(() => {
    for (const leave of left) leave();
    left = [];
  });
  afterAll(async () => {
    await daemon?.stop();
  });

  async function shell(key: string): Promise<string> {
    const opened = await daemon.request("/v1/shells", {
      method: "POST",
      body: { idempotencyKey: key, cwd: daemon.work },
    });
    return ShellCommandResponse.parse(opened.body).terminalId;
  }

  it("detaches on the keys config.toml names, and types the default ones", async () => {
    const terminalId = await shell("configured");
    const attached = attachInScript(daemon, terminalId);
    left.push(attached.leave);
    const said = `attaching to ${terminalId}: Ctrl-P Ctrl-Q detaches`;
    await attached.shows(said, "the attach saying config.toml's keys detach");
    // Ctrl-U after the default keys clears whatever the shell's line made of them.
    attached.type(`${DETACH}\x15`);
    attached.type("printf 'still-%s\\n' 3\r");
    await attached.shows("still-3", "a command typed after the default keys");
    attached.type("\x10\x11");
    expect([
      await attached.exited,
      attached.shown().includes(`detached from ${terminalId}`),
    ]).toEqual([0, true]);
  });

  it("detaches on the keys --detach-keys names over config.toml's, on either path", async () => {
    const terminalId = await shell("flagged");
    const ends = async (how: string) => {
      const attached = attachInScript(daemon, `${terminalId} ${how} --detach-keys ctrl-x,ctrl-y`);
      left.push(attached.leave);
      await attached.shows("Ctrl-X Ctrl-Y detaches", "the attach saying which keys detach");
      attached.type("\x18\x19");
      return [await attached.exited, attached.shown().includes(`detached from ${terminalId}`)];
    };
    expect([await ends(""), await ends("--direct")]).toEqual([
      [0, true],
      [0, true],
    ]);
  });
});
