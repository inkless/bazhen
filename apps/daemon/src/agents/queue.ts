/**
 * Runs the commands on one agent one at a time, in the order they were asked for; commands on
 * different agents don't wait for each other. What it holds is also what is in flight: an agent
 * is busy from the moment a command is queued on it until the last one settles.
 */
export class AgentQueue {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(agentId: string, command: () => Promise<T>): Promise<T> {
    const next = (this.tails.get(agentId) ?? Promise.resolve()).then(command);
    // The queue only orders commands; each caller gets its own command's failure from `next`.
    const settled = next.catch(() => {});
    this.tails.set(agentId, settled);
    void settled.then(() => {
      if (this.tails.get(agentId) === settled) this.tails.delete(agentId);
    });
    return next;
  }

  /** Whether a command on the agent is queued or running. */
  busy(agentId: string): boolean {
    return this.tails.has(agentId);
  }
}
