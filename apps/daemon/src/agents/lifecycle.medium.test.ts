import { tmpdir } from "node:os";
import { FLEET_INSTRUCTIONS } from "../tasks/mail.ts";
import { describe, expect, it } from "vitest";
import {
  LaunchFailed,
  newId,
  NoTerminal,
  NotResumable,
  StaleIncarnation,
  TerminalUnconfirmed,
  type AgentLaunch,
  type AgentRefs,
  type AgentRespawn,
  type RuntimeRef,
} from "@bazhen/core";
import type { ExitStatus, Signal } from "@bazhen/protocol";
import { Mailbox } from "../mailbox/mailbox.ts";
import { IdempotencyConflict, type Store } from "../store/store.ts";
import { fakeEnvironment, quietStartAgain, testView, withAgent } from "../testing/fixtures.ts";
import { launchAgent, localEnvironmentId } from "./launch.ts";
import { AgentQueue } from "./queue.ts";
import {
  AgentStateConflict,
  EnvironmentUnavailable,
  Lifecycle,
  ServerUnconfirmed,
  StaleGeneration,
  TerminalReplaced,
} from "./lifecycle.ts";

/**
 * An agent left closing by an environment out of reach, then forced closed once it is back
 * (`recovered`) or still away: its state after, and how many closes reached the environment.
 */
async function unreachableThenForced(recovered: boolean) {
  const { lifecycle, agentId, agent, fail, closed } = await running();
  fail(new Error("tmux unreachable"));
  await lifecycle.close(agentId, { idempotencyKey: "c", generation: 0 }).catch(() => {});
  fail(recovered ? undefined : new Error("tmux unreachable"));
  await lifecycle.close(agentId, { idempotencyKey: "f", generation: 0, force: true });
  return [agent()?.state, closed.length];
}

/**
 * A running agent whose environment records closes, respawns and signals, fails them on demand,
 * and reports exits.
 */
async function running({
  session = true,
  duringRespawn = (_store: Store, _agentId: string) => {},
} = {}) {
  const closed: AgentRefs[] = [];
  const launches: AgentLaunch[] = [];
  const replaced: string[] = [];
  const respawned: AgentRespawn[] = [];
  const signalled: Signal[] = [];
  let failure: Error | undefined;
  const statesAtClose: (string | undefined)[] = [];
  let report: ((ref: RuntimeRef, status: ExitStatus) => void) | undefined;
  const { store, agentId, terminalId, environment } = await withAgent((s) => {
    const environmentId = localEnvironmentId(s);
    const base = fakeEnvironment(s, async (l) => {
      if (failure !== undefined) throw failure;
      launches.push(l);
      const fresh = { environmentId, kind: "claude-session" as const, id: `s-${launches.length}` };
      return {
        runtime: {
          terminalId: l.terminalId,
          runtime: "tmux",
          locator: { generation: String(l.generation) },
        },
        externalRef: l.resume ?? (session ? fresh : null),
        ...(l.options.theme && { theme: l.options.theme }),
      };
    });
    return {
      ...base,
      respawn: async (r) => {
        if (failure !== undefined) throw failure;
        respawned.push(r);
        duringRespawn(s, r.agentId);
        return base.respawn(r);
      },
      signal: async (_refs, signal) => {
        if (failure !== undefined) throw failure;
        signalled.push(signal);
      },
      close: async (refs) => {
        statesAtClose.push(s.snapshot(testView).agents[0]?.state);
        if (failure !== undefined) throw failure;
        closed.push(refs);
      },
      onExit: (cb) => {
        report = cb;
        return () => (report = undefined);
      },
    };
  });
  const lifecycle = new Lifecycle(store, environment, new AgentQueue(), {
    size: { cols: 80, rows: 24 },
    replaced: (id) => replaced.push(id),
  });
  lifecycle.watch();
  const exit = (generation: string, status: ExitStatus = { type: "exited", code: 1 }) =>
    report?.({ terminalId, runtime: "tmux", locator: { generation } }, status);
  const agent = () => store.snapshot(testView).agents[0];
  const events = () => store.snapshot(testView).eventId;
  const fail = (with_?: Error) => (failure = with_);
  return {
    store,
    lifecycle,
    agentId,
    closed,
    launches,
    replaced,
    respawned,
    signalled,
    statesAtClose,
    exit,
    agent,
    events,
    fail,
  };
}

/** The id of an agent whose launch the environment rejected. */
async function failedLaunch(store: Store): Promise<string> {
  const environment = fakeEnvironment(store, () => Promise.reject(new Error("no tmux")));
  const request = { idempotencyKey: "launch-2", harness: "claude-code", cwd: "~" } as const;
  const failed = await launchAgent(
    { store, environment, size: { cols: 80, rows: 24 }, home: tmpdir(), queue: new AgentQueue() },
    request,
  )
    .then(() => undefined)
    .catch((e: unknown) => e);
  if (!(failed instanceof LaunchFailed)) throw new Error("the launch did not fail");
  return failed.agentId;
}

describe("agent lifecycle", () => {
  it("records the exit of the agent's current generation, with how it ended", async () => {
    const { exit, agent } = await running();
    exit("0", { type: "signalled", signal: "SIGKILL" });
    expect(agent()).toMatchObject({
      state: "exited",
      exit: { type: "signalled", signal: "SIGKILL" },
    });
  });

  it("drops a report about an earlier generation of the terminal", async () => {
    const { exit, agent } = await running();
    exit("7");
    expect(agent()).toMatchObject({ state: "running", exit: null });
  });

  it("records an exit once, though the environment reports it on every check", async () => {
    const { exit, events } = await running();
    exit("0");
    const after = events();
    exit("0");
    expect(events()).toBe(after);
  });

  it("closes an agent: closing first, then its terminal, then closed", async () => {
    const { lifecycle, agentId, closed, agent } = await running();
    const res = await lifecycle.close(agentId, { idempotencyKey: "c", generation: 0 });
    expect([res.eventIds.length, closed.length, agent()?.state]).toEqual([2, 1, "closed"]);
  });

  it("gives up the mail still on its way to an agent that closes", async () => {
    const { lifecycle, agentId, store } = await running();
    const { messageId } = new Mailbox(store).send(agentId, { idempotencyKey: "m", body: "hi" });
    await lifecycle.close(agentId, { idempotencyKey: "c", generation: 0 });
    expect(store.snapshot(testView).messages.find((m) => m.id === messageId)?.state).toBe(
      "undeliverable",
    );
  });

  // A view that loses its terminal tells a close from a disconnect by this order.
  it("records closing before it asks the environment to end the terminal", async () => {
    const { lifecycle, agentId, statesAtClose } = await running();
    await lifecycle.close(agentId, { idempotencyKey: "c", generation: 0 });
    expect(statesAtClose).toEqual(["closing"]);
  });

  it("says a terminal whose server was replaced can't be closed by repeating the command", async () => {
    const { lifecycle, agentId, agent, fail } = await running();
    fail(new StaleIncarnation(newId("term"), "server-replaced"));
    await expect(lifecycle.close(agentId, { idempotencyKey: "c", generation: 0 })).rejects.toThrow(
      TerminalReplaced,
    );
    expect(agent()?.state).toBe("closing");
  });

  it("leaves the agent closing when its old server may still run it, until a forced close", async () => {
    const { lifecycle, agentId, agent, fail, closed } = await running();
    fail(new TerminalUnconfirmed(newId("term"), new Error("no server running")));
    const refused = await lifecycle
      .close(agentId, { idempotencyKey: "c", generation: 0 })
      .catch((e: unknown) => e);
    const kept = agent()?.state;
    await lifecycle.close(agentId, { idempotencyKey: "f", generation: 0, force: true });
    expect([refused instanceof ServerUnconfirmed, kept, agent()?.state, closed]).toEqual([
      true,
      "closing",
      "closed",
      [],
    ]);
  });

  it("forces a close past an environment out of reach, but still ends a terminal it now can", async () => {
    expect([await unreachableThenForced(false), await unreachableThenForced(true)]).toEqual([
      ["closed", 0],
      ["closed", 1],
    ]);
  });

  it("never forces a running terminal's close, nor one past a terminal another server carries", async () => {
    const live = await running();
    const onRunning = await live.lifecycle
      .close(live.agentId, { idempotencyKey: "f", generation: 0, force: true })
      .catch((e: unknown) => e);
    const replaced = await running();
    replaced.fail(new StaleIncarnation(newId("term"), "server-replaced"));
    const close = (key: string, force?: true) =>
      replaced.lifecycle.close(replaced.agentId, { idempotencyKey: key, generation: 0, force });
    await close("c").catch(() => {});
    const pastReplaced = await close("f", true).catch((e: unknown) => e);
    expect([
      onRunning instanceof AgentStateConflict,
      live.agent()?.state,
      live.closed,
      pastReplaced instanceof TerminalReplaced,
      replaced.agent()?.state,
    ]).toEqual([true, "running", [], true, "closing"]);
  });

  it("leaves the agent closing when the environment can't be reached, and finishes on a retry", async () => {
    const { lifecycle, agentId, agent, fail } = await running();
    fail(new Error("tmux unreachable"));
    await expect(lifecycle.close(agentId, { idempotencyKey: "c", generation: 0 })).rejects.toThrow(
      EnvironmentUnavailable,
    );
    expect(agent()?.state).toBe("closing");
    fail();
    const res = await lifecycle.close(agentId, { idempotencyKey: "c", generation: 0 });
    expect([res.eventIds.length, agent()?.state]).toEqual([2, "closed"]);
  });

  it("closes a lost agent without asking the environment, whose terminal is already gone", async () => {
    const { store, lifecycle, agentId, closed, agent } = await running();
    store.append({ type: "agent.lost", entityId: agentId, actor: "system", payload: {} });
    await lifecycle.close(agentId, { idempotencyKey: "c", generation: 0 });
    expect([closed.length, agent()?.state]).toEqual([0, "closed"]);
  });

  it("refuses a close naming a generation the terminal has moved past, with the current one", async () => {
    const { lifecycle, agentId, agent } = await running();
    const refused = lifecycle.close(agentId, { idempotencyKey: "c", generation: 3 });
    await expect(refused).rejects.toThrow(StaleGeneration);
    await expect(refused).rejects.toThrow("generation 0");
    expect(agent()?.state).toBe("running");
  });

  it("answers a repeated close with the first answer, and a close of a closed agent with nothing", async () => {
    const { lifecycle, agentId } = await running();
    const first = await lifecycle.close(agentId, { idempotencyKey: "c", generation: 0 });
    const again = await lifecycle.close(agentId, { idempotencyKey: "c", generation: 0 });
    const later = await lifecycle.close(agentId, { idempotencyKey: "d", generation: 0 });
    expect([again, later.eventIds]).toEqual([first, []]);
  });

  it("refuses to close an agent whose launch failed, which holds nothing to close", async () => {
    const { store, lifecycle } = await running();
    const agentId = await failedLaunch(store);
    await expect(lifecycle.close(agentId, { idempotencyKey: "c", generation: 0 })).rejects.toThrow(
      AgentStateConflict,
    );
  });

  it("runs two closes of one agent one after the other, so the second finds it closed", async () => {
    const { lifecycle, agentId, closed } = await running();
    const [a, b] = await Promise.all([
      lifecycle.close(agentId, { idempotencyKey: "c", generation: 0 }),
      lifecycle.close(agentId, { idempotencyKey: "d", generation: 0 }),
    ]);
    expect([a.eventIds.length, b.eventIds.length, closed.length]).toEqual([2, 0, 1]);
  });

  it("respawns an exited agent at the next generation, under the same id", async () => {
    const { lifecycle, agentId, exit, agent, respawned } = await running();
    exit("0");
    const res = await lifecycle.respawn(agentId, { idempotencyKey: "r", generation: 0 });
    expect([res.eventIds.length, respawned[0]?.generation]).toEqual([2, 1]);
    expect(agent()).toMatchObject({ id: agentId, state: "running", generation: 1, exit: null });
  });

  it("settles what the exited process held before a respawn starts the next one", async () => {
    const { lifecycle, agentId, exit, replaced } = await running();
    exit("0");
    await lifecycle.respawn(agentId, { idempotencyKey: "r", generation: 0 });
    expect(replaced).toEqual([agentId]);
  });

  it("respawns in the theme the respawn names, and shows the one its TUI started in", async () => {
    const { lifecycle, agentId, exit, agent, respawned } = await running();
    exit("0");
    await lifecycle.respawn(agentId, { idempotencyKey: "r", generation: 0, theme: "light" });
    expect([respawned[0]?.options, agent()?.theme]).toEqual([
      { theme: "light", instructions: FLEET_INSTRUCTIONS },
      "light",
    ]);
    exit("1");
    await lifecycle.respawn(agentId, { idempotencyKey: "r2", generation: 1 });
    expect(agent()?.theme).toBe("dark");
  });

  it("keeps a binding the new TUI moved while it started, over the session it resumed", async () => {
    const { lifecycle, agentId, exit, agent } = await running({
      duringRespawn: (store, id) =>
        store.append({
          type: "agent.external_ref_updated",
          entityId: id,
          actor: "system",
          payload: {
            externalRef: {
              environmentId: localEnvironmentId(store),
              kind: "claude-session",
              id: "s-2",
            },
          },
        }),
    });
    exit("0");
    await lifecycle.respawn(agentId, { idempotencyKey: "r", generation: 0 });
    expect(agent()?.externalRef?.id).toBe("s-2");
  });

  it("records the next exit under the new generation, and drops one about the old", async () => {
    const { lifecycle, agentId, exit, agent } = await running();
    exit("0");
    await lifecycle.respawn(agentId, { idempotencyKey: "r", generation: 0 });
    exit("0");
    const afterStale = agent()?.state;
    exit("1", { type: "exited", code: 4 });
    expect([afterStale, agent()?.exit]).toEqual(["running", { type: "exited", code: 4 }]);
  });

  it("returns a rejected respawn to exited, still closable, and says why", async () => {
    const { lifecycle, agentId, exit, agent, fail } = await running();
    exit("0");
    fail(new StaleIncarnation(newId("term"), "gone"));
    await expect(
      lifecycle.respawn(agentId, { idempotencyKey: "r", generation: 0 }),
    ).rejects.toThrow(TerminalReplaced);
    const rejected = agent()?.state;
    fail();
    await lifecycle.close(agentId, { idempotencyKey: "c", generation: 0 });
    expect([rejected, agent()?.state]).toEqual(["exited", "closed"]);
  });

  it("refuses a respawn the agent has no session for, recording nothing", async () => {
    const { lifecycle, agentId, exit, events, respawned } = await running({ session: false });
    exit("0");
    const before = events();
    await expect(
      lifecycle.respawn(agentId, { idempotencyKey: "r", generation: 0 }),
    ).rejects.toThrow(NotResumable);
    expect([events(), respawned.length]).toEqual([before, 0]);
  });

  it("refuses to respawn a running agent, or one at a stale generation", async () => {
    const { lifecycle, agentId, exit } = await running();
    await expect(
      lifecycle.respawn(agentId, { idempotencyKey: "r", generation: 0 }),
    ).rejects.toThrow(AgentStateConflict);
    exit("0");
    await expect(
      lifecycle.respawn(agentId, { idempotencyKey: "s", generation: 2 }),
    ).rejects.toThrow(StaleGeneration);
  });

  it("returns a respawn the environment can't reach to exited, to be tried again", async () => {
    const { lifecycle, agentId, exit, agent, fail } = await running();
    exit("0");
    fail(new Error("tmux unreachable"));
    await expect(
      lifecycle.respawn(agentId, { idempotencyKey: "r", generation: 0 }),
    ).rejects.toThrow(EnvironmentUnavailable);
    fail();
    const again = await lifecycle.respawn(agentId, { idempotencyKey: "r", generation: 0 });
    expect([again.eventIds.length, agent()?.state]).toEqual([2, "running"]);
  });

  it("signals a running agent and records it, without changing its state", async () => {
    const { lifecycle, agentId, agent, signalled } = await running();
    const res = await lifecycle.signal(agentId, {
      idempotencyKey: "s",
      generation: 0,
      signal: "SIGINT",
    });
    expect([res.eventIds.length, signalled, agent()?.state]).toEqual([1, ["SIGINT"], "running"]);
  });

  it("refuses to signal an agent that is not running", async () => {
    const { lifecycle, agentId, exit, signalled } = await running();
    exit("0");
    await expect(
      lifecycle.signal(agentId, { idempotencyKey: "s", generation: 0, signal: "SIGTERM" }),
    ).rejects.toThrow(AgentStateConflict);
    expect(signalled).toEqual([]);
  });

  it("refuses one key used for two different commands", async () => {
    const { lifecycle, agentId } = await running();
    await lifecycle.signal(agentId, { idempotencyKey: "k", generation: 0, signal: "SIGINT" });
    await expect(lifecycle.close(agentId, { idempotencyKey: "k", generation: 0 })).rejects.toThrow(
      IdempotencyConflict,
    );
  });
});

/** A running agent whose terminal was then lost, as when its tmux server died. */
async function lost(opts: Parameters<typeof running>[0] = {}) {
  const r = await running(opts);
  r.store.append({ type: "agent.lost", entityId: r.agentId, actor: "system", payload: {} });
  return r;
}

describe("relaunching a lost agent", () => {
  it("resumes its session on a new terminal at the next generation, in the theme asked for", async () => {
    const { lifecycle, agentId, agent, launches, replaced } = await lost();
    const before = agent()?.terminalId;
    await lifecycle.relaunch(agentId, { idempotencyKey: "l", generation: 0, theme: "light" });
    const after = agent();
    expect([
      after?.state,
      after?.terminalId === before,
      after?.generation,
      after?.theme,
      after?.externalRef?.id,
      launches[1]?.resume?.id,
      replaced,
    ]).toEqual(["running", false, 1, "light", "s-1", "s-1", [agentId]]);
  });

  it("refuses an agent it can't resume unless asked for a fresh session, recording nothing", async () => {
    const { lifecycle, agentId, agent, events, launches, replaced } = await lost({
      session: false,
    });
    const before = events();
    await expect(
      lifecycle.relaunch(agentId, { idempotencyKey: "l", generation: 0 }),
    ).rejects.toThrow(NotResumable);
    expect([events(), launches.length, replaced]).toEqual([before, 1, []]);
    await lifecycle.relaunch(agentId, { idempotencyKey: "f", generation: 0, fresh: true });
    expect([agent()?.state, launches[1]?.resume, agent()?.externalRef]).toEqual([
      "running",
      null,
      null,
    ]);
  });

  it("starts a fresh session when asked, though the old one could be resumed", async () => {
    const { lifecycle, store, agentId, agent, launches } = await lost();
    await lifecycle.relaunch(agentId, { idempotencyKey: "f", generation: 0, fresh: true });
    // The log says the old conversation was left behind, not only that a new session appeared.
    const asked = store.events(0).find((e) => e.type === "agent.relaunch_requested")?.payload;
    expect([launches[1]?.resume, agent()?.externalRef?.id, asked]).toEqual([
      null,
      "s-2",
      expect.objectContaining({ fresh: true }),
    ]);
  });

  it("leaves a rejected relaunch lost on its old terminal, to be relaunched again or removed", async () => {
    const { lifecycle, agentId, agent, fail } = await lost();
    const before = agent()?.terminalId;
    fail(new Error("tmux unreachable"));
    await expect(
      lifecycle.relaunch(agentId, { idempotencyKey: "l-1", generation: 0 }),
    ).rejects.toThrow(EnvironmentUnavailable);
    const rejected = agent();
    fail(undefined);
    await lifecycle.relaunch(agentId, { idempotencyKey: "l-2", generation: 0 });
    expect([
      [rejected?.state, rejected?.terminalId === before, rejected?.commands],
      [agent()?.state, agent()?.generation],
    ]).toEqual([
      ["lost", true, ["close", "relaunch"]],
      ["running", 1],
    ]);
  });

  it("leaves an agent lost when the environment starts it without a terminal", async () => {
    const { store, agentId, environment } = await withAgent((s) =>
      fakeEnvironment(s, async () => ({ runtime: null, externalRef: null })),
    );
    store.append({ type: "agent.lost", entityId: agentId, actor: "system", payload: {} });
    const lifecycle = new Lifecycle(store, environment, new AgentQueue(), quietStartAgain);
    await expect(
      lifecycle.relaunch(agentId, { idempotencyKey: "l", generation: 0, fresh: true }),
    ).rejects.toThrow(NoTerminal);
    expect(store.snapshot(testView).agents[0]?.state).toBe("lost");
  });

  it("refuses to relaunch an agent that isn't lost, or one at a stale generation", async () => {
    const live = await running();
    const gone = await lost();
    await expect(
      live.lifecycle.relaunch(live.agentId, { idempotencyKey: "l", generation: 0 }),
    ).rejects.toThrow(AgentStateConflict);
    await expect(
      gone.lifecycle.relaunch(gone.agentId, { idempotencyKey: "l", generation: 3 }),
    ).rejects.toThrow(StaleGeneration);
  });

  it("answers a repeated relaunch with the first answer, launching once", async () => {
    const { lifecycle, agentId, launches } = await lost();
    const req = { idempotencyKey: "l", generation: 0 };
    const first = await lifecycle.relaunch(agentId, req);
    expect([await lifecycle.relaunch(agentId, req), launches.length]).toEqual([first, 2]);
  });

  it("closes a relaunched agent's new terminal, not the lost one", async () => {
    const { lifecycle, agentId, agent, closed } = await lost();
    await lifecycle.relaunch(agentId, { idempotencyKey: "l", generation: 0 });
    const terminalId = agent()?.terminalId;
    await lifecycle.close(agentId, { idempotencyKey: "c", generation: 1 });
    expect([agent()?.state, closed.map((r) => r.runtime?.terminalId)]).toEqual([
      "closed",
      [terminalId],
    ]);
  });
});
