import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { FakeRuntime } from "@bazhen/core/testing";
import { LocalEnvironment } from "@bazhen/env-local";
import { localEnvironmentId } from "../agents/launch.ts";
import { AgentQueue } from "../agents/queue.ts";
import { Store } from "../store/store.ts";
import { tempDb, testView } from "../testing/fixtures.ts";
import { ForegroundWatch } from "./foreground.ts";
import { ShellLifecycle } from "./lifecycle.ts";

/** A shell on a fake runtime, the watch over it, and what the store and its log say of it. */
async function setup() {
  const path = tempDb();
  const store = Store.open(path);
  const runtime = new FakeRuntime();
  const environment = new LocalEnvironment({
    id: localEnvironmentId(store),
    runtime,
    harnesses: [],
    socket: "/run/b.sock",
  });
  const home = mkdtempSync(join(tmpdir(), "bz-home-"));
  const shells = new ShellLifecycle({
    store,
    environment,
    queue: new AgentQueue(),
    size: { cols: 80, rows: 24 },
    home,
  });
  const logged: string[] = [];
  const watch = new ForegroundWatch({ store, environment, log: (m) => logged.push(m) });
  const { terminalId } = await shells.open({ idempotencyKey: "o" });
  const ref = store.shell(terminalId)?.runtime;
  if (ref == null) throw new Error("no terminal");
  const shellOf = () => store.snapshot(testView).shells[0];
  /** Every event the store holds about the shell, as written. */
  const events = () => {
    const raw = new DatabaseSync(path);
    const rows = raw
      .prepare("SELECT type, payload FROM events WHERE entity_id = ? ORDER BY id")
      .all(terminalId);
    raw.close();
    return rows.map((r) => ({ type: String(r.type), payload: String(r.payload) }));
  };
  const changes = () => events().filter((e) => e.type === "terminal.foreground_changed");
  return {
    store,
    runtime,
    environment,
    shells,
    watch,
    terminalId,
    ref,
    shellOf,
    events,
    changes,
    logged,
  };
}

describe("a shell's foreground", () => {
  it("shows a program running in it by name, and none once it ends", async () => {
    const { runtime, ref, watch, shellOf } = await setup();
    runtime.runInForeground(ref, "nvim");
    await watch.refresh();
    const running = shellOf()?.foreground;
    runtime.runInForeground(ref, null);
    await watch.refresh();
    expect([running, shellOf()?.foreground]).toEqual([
      { command: "nvim", since: expect.any(String) },
      null,
    ]);
  });

  it("records a change only when what runs changes", async () => {
    const { runtime, ref, watch, changes } = await setup();
    runtime.runInForeground(ref, "sleep");
    await watch.refresh();
    await watch.refresh();
    expect(changes().map((e) => JSON.parse(e.payload))).toEqual([{ command: "sleep" }]);
  });

  it("reads nothing at all while no shell runs", async () => {
    const { store, environment, terminalId, shells } = await setup();
    await shells.close(terminalId, { idempotencyKey: "c", generation: 0 });
    let reads = 0;
    const counting = Object.create(environment);
    counting.shellForegrounds = () => {
      reads++;
      return Promise.resolve([]);
    };
    await new ForegroundWatch({ store, environment: counting }).refresh();
    expect(reads).toBe(0);
  });

  it("says a read that fails once, however often it fails", async () => {
    const { runtime, watch, logged } = await setup();
    runtime.disconnect();
    await watch.refresh();
    await watch.refresh();
    expect(logged).toHaveLength(1);
  });

  it("drops the foreground of a shell that is lost, so it shows nothing running", async () => {
    const { runtime, ref, watch, store, terminalId } = await setup();
    runtime.runInForeground(ref, "nvim");
    await watch.refresh();
    store.append({ type: "terminal.lost", entityId: terminalId, actor: "system", payload: {} });
    expect(store.snapshot(testView).shells[0]?.foreground).toBeNull();
  });
});
