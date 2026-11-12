import { describe, expect, it } from "vitest";
import { newId } from "@bazhen/core";
import { Store } from "../store/store.ts";
import { withAgent } from "../testing/fixtures.ts";
import { endOpenAttachments, storeLog } from "./log.ts";

describe("attachment log", () => {
  it("keeps a terminal's lease epoch across a restart, so the next grant is higher", async () => {
    const { path, store, terminalId } = await withAgent();
    const attachment = newId("att");
    storeLog(store).started(attachment, terminalId, "interactive");
    storeLog(store).granted(terminalId, attachment, 3);
    store.close();
    const again = Store.open(path);
    expect(storeLog(again).epoch(terminalId)).toBe(3);
    again.close();
  });

  it("ends every attachment still open at boot, as a daemon restart", async () => {
    const { store, terminalId } = await withAgent();
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
