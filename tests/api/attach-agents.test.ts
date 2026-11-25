import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { StateSnapshot } from "@bazhen/protocol/web";
import { attachInScript, Daemon } from "./daemon.ts";
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
