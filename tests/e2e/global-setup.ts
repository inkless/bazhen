import { request } from "@playwright/test";
import { e2eDaemons, webOrigin } from "./daemons.ts";
import { dismissNotices, issueCode, storageState } from "./pairing.ts";

// Every browser must pair (foundation-design §9.2). Each project's specs share one browser's
// cookie, paired with its own daemon; pairing.spec.ts pairs a browser of its own through the page.
export default async function setup(): Promise<void> {
  for (const daemon of e2eDaemons()) {
    const origin = webOrigin(daemon);
    const context = await request.newContext({ baseURL: origin });
    const res = await context.post("/v1/pairing", {
      headers: { origin },
      data: { code: await issueCode(daemon.home), name: "e2e" },
    });
    if (!res.ok()) {
      throw new Error(`pairing with ${daemon.runtime} failed: ${res.status()} ${await res.text()}`);
    }
    const paired: unknown = await res.json();
    await dismissNotices(daemon.home, String(Reflect.get(Object(paired), "deviceId")));
    await context.storageState({ path: storageState(daemon.home) });
    await context.dispose();
  }
}
