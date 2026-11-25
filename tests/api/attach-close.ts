import { StateSnapshot } from "@bazhen/protocol/web";
import { attachInScript, type Daemon } from "./daemon.ts";

/**
 * Attaches to an agent and closes it through the daemon, which ends the agent's process before
 * its terminal. What the close answered, how the attach exited, and whether it offered a respawn.
 */
export async function closeWhileAttached(
  daemon: Daemon,
  key: string,
): Promise<[number, number | null, boolean]> {
  const { agentId } = await daemon.program(["sh", "-c", "printf 'ready\\n'; exec sleep 300"]);
  const state = async () => StateSnapshot.parse((await daemon.request("/v1/state")).body);
  const name = String((await state()).agents.find((a) => a.id === agentId)?.name);
  const attached = attachInScript(daemon, name);
  try {
    await attached.shows("ready", "the agent's first output");
    const closed = await daemon.request(`/v1/agents/${agentId}/close`, {
      method: "POST",
      body: { idempotencyKey: key, generation: 0 },
    });
    const said = `${name}: the terminal closed`;
    await attached.shows(said, "the attach saying the terminal closed");
    return [closed.status, await attached.exited, attached.shown().includes("respawn")];
  } finally {
    attached.leave();
  }
}
