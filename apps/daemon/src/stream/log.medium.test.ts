import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isId, newId } from "@bazhen/core";
import { launchAgent, localEnvironmentId } from "../agents/launch.ts";
import { Store } from "../store/store.ts";
import { endOpenAttachments, storeLog } from "./log.ts";

async function withTerminal() {
  const path = join(mkdtempSync(join(tmpdir(), "bz-log-")), "bazhen.db");
  const store = Store.open(path);
  const id = localEnvironmentId(store);
  const { terminalId } = await launchAgent(
    {
      store,
      size: { cols: 80, rows: 24 },
      environment: {
        id,
        kind: "local",
        harnesses: ["claude-code"],
        launch: async (l) => ({
          runtime: { terminalId: l.terminalId, runtime: "tmux", locator: {} },
          externalRef: null,
        }),
      },
    },
    { idempotencyKey: "k", harness: "claude-code", cwd: "/w" },
  );
  if (terminalId === null || !isId("term", terminalId)) throw new Error("launched no terminal");
  return { path, store, terminalId };
}

describe("attachment log", () => {
  it("keeps a terminal's lease epoch across a restart, so the next grant is higher", async () => {
    const { path, store, terminalId } = await withTerminal();
    const attachment = newId("att");
    storeLog(store).started(attachment, terminalId, "interactive");
    storeLog(store).granted(terminalId, attachment, 3);
    store.close();
    const again = Store.open(path);
    expect(storeLog(again).epoch(terminalId)).toBe(3);
    again.close();
  });

  it("ends every attachment still open at boot, as a daemon restart", async () => {
    const { store, terminalId } = await withTerminal();
    const a = newId("att");
    const b = newId("att");
    storeLog(store).started(a, terminalId, "interactive");
    storeLog(store).started(b, terminalId, "observe");
    storeLog(store).ended(b, "client_closed");
    endOpenAttachments(store);
    expect([store.openAttachments(), store.eventsAfter(0).at(-1)?.entityId]).toEqual([[], a]);
    store.close();
  });
});
