import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Daemon, waitUntil } from "./daemon.ts";

let daemon: Daemon;
beforeAll(async () => {
  daemon = await Daemon.start({ runtime: "tmux" });
});
afterAll(async () => {
  await daemon?.stop();
});

/** The daemon's clients on its tmux server. */
const clients = () =>
  daemon
    .tmux("list-clients")
    .split("\n")
    .filter((line) => line.trim() !== "");

describe("the terminal stream of a tmux terminal", () => {
  it("serves every view of a terminal through one tmux client", async () => {
    const { agentId, terminalId } = await daemon.program([
      "sh",
      "-c",
      "echo shared; exec sleep 600",
    ]);
    await waitUntil(async () => (await daemon.screen(agentId)).includes("shared"), "the program");
    const first = await daemon.view(terminalId, "interactive");
    await expect.poll(() => first.text(), { timeout: 10_000 }).toContain("shared");
    const late = await daemon.view(terminalId, "observe");
    expect(await late.snapshotText()).toContain("shared");
    // An earlier view's client may still be on its way out.
    await expect.poll(clients, { timeout: 10_000 }).toHaveLength(1);
    first.close();
    late.close();
  });

  it("keeps the client of a view closed on an Enter until the next view's client is in", async () => {
    const program = await daemon.program([
      "sh",
      "-c",
      'echo ready; read line; echo "got $line"; exec sleep 600',
    ]);
    await waitUntil(
      async () => (await daemon.screen(program.agentId)).includes("ready"),
      "the program",
    );
    const session = String(daemon.paneFact(program.terminalId, "session_name"));
    // tmux runs the hook as each client attaches, so this lists how many clients the session had
    // at each attach, in tmux's own order.
    daemon.tmux(
      "set-hook",
      "-t",
      session,
      "client-attached",
      `set-option -aF -t '${session}' @attached '#{session_attached} '`,
    );
    const attachedCounts = () =>
      daemon.tmux("show-options", "-v", "-t", session, "@attached").trim();
    const typed = await daemon.view(program.terminalId, "interactive");
    await typed.drive();
    typed.type("last words\r");
    typed.close();
    await typed.closed();
    const next = await daemon.view(program.terminalId, "observe");
    await expect.poll(attachedCounts, { timeout: 10_000 }).toBe("1 2");
    await expect.poll(() => daemon.screen(program.agentId)).toContain("got last words");
    next.close();
    await expect
      .poll(() => daemon.tmux("list-clients", "-t", session).trim(), { timeout: 10_000 })
      .toBe("");
  });
});
