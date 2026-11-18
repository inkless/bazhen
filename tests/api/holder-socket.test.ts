import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ErrorResponse,
  HealthResponse,
  ShellCommandResponse,
  StateSnapshot,
} from "@bazhen/protocol";
import { Daemon, waitUntil } from "./daemon.ts";
import { startFakeModel, type FakeModel } from "./fake-model.ts";

/** Past the daemon's server watch tick, and several of its holder process polls. */
const WATCHED_MS = 6_000;

let model: FakeModel;
let daemon: Daemon;
beforeAll(async () => {
  model = await startFakeModel();
  daemon = await Daemon.start({ modelUrl: model.url, runtime: "holder" });
}, 60_000);
afterAll(async () => {
  await daemon?.stop();
  await model?.close();
});

const snapshot = async () => StateSnapshot.parse((await daemon.request("/v1/state")).body);

const holderHealth = async () =>
  HealthResponse.parse((await daemon.request("/v1/health")).body).runtimes.find(
    (r) => r.kind === "holder",
  )?.state;

const refusal = ({ status, body }: { status: number; body: unknown }) => [
  status,
  ErrorResponse.parse(body).error,
];

async function runningShell(key: string): Promise<string> {
  const opened = await daemon.request("/v1/shells", {
    method: "POST",
    body: { idempotencyKey: key, cwd: daemon.work },
  });
  const { terminalId } = ShellCommandResponse.parse(opened.body);
  await waitUntil(
    async () => (await snapshot()).shells.find((s) => s.id === terminalId)?.state === "running",
    `shell ${terminalId} running`,
    30_000,
  );
  return terminalId;
}

describe("a holder socket this user may no longer connect to", () => {
  it("keeps an agent closing while its holder can't be reached, and closes it once it can", async () => {
    const launched = await daemon.launch("unreachable");
    const { agentId } = launched;
    const terminalId = String(launched.terminalId);
    await daemon.running(agentId);
    const command = (name: string, body: Record<string, unknown> = {}) =>
      daemon.request(`/v1/agents/${agentId}/${name}`, {
        method: "POST",
        body: { idempotencyKey: `unreachable-${name}`, generation: 0, ...body },
      });

    const unblock = daemon.blockHolder(terminalId);
    let seen: unknown[];
    try {
      const signalled = await command("signal", { signal: "SIGTERM" });
      const screen = await daemon.request(`/v1/terminals/${terminalId}/screen`);
      const closed = await command("close");
      await new Promise((wait) => setTimeout(wait, WATCHED_MS));
      const agent = (await snapshot()).agents.find((a) => a.id === agentId);
      seen = [
        refusal(signalled),
        refusal(screen),
        refusal(closed),
        agent?.state,
        await holderHealth(),
      ];
    } finally {
      unblock();
    }
    expect(seen).toEqual([
      [503, "unavailable"],
      [503, "unavailable"],
      [503, "unavailable"],
      "closing",
      "unreachable",
    ]);
    expect((await command("close")).status).toBe(200);
    expect((await snapshot()).agents.find((a) => a.id === agentId)?.state).toBe("closed");
  });

  it("serves a view it already has, refuses a new one, and serves new ones once reachable", async () => {
    const watched = await runningShell("unreachable-watched");
    const unwatched = await runningShell("unreachable-unwatched");
    const view = await daemon.view(watched, "interactive");
    await view.drive();

    const unblocks = [daemon.blockHolder(watched), daemon.blockHolder(unwatched)];
    let refused: unknown[];
    try {
      // The shell echoes what is typed, so only the shell having run it shows 42.
      view.type("echo held-$((6 * 7))\r");
      await waitUntil(() => view.output().includes("held-42"), "the command's output");
      const fresh = await daemon.view(unwatched, "observe");
      await fresh.closed();
      refused = fresh.frames;
    } finally {
      for (const unblock of unblocks) unblock();
    }
    expect(refused).toEqual([
      { type: "error", message: expect.stringContaining("can't be reached") },
    ]);
    const after = await daemon.view(unwatched, "observe");
    await after.attached();
    after.close();
    view.close();
  });
});
