import { request } from "@playwright/test";
import { issueCode, storageState } from "./pairing.ts";

// Every browser must pair (foundation-design §9.2). The specs share one paired browser's cookie;
// pairing.spec.ts pairs a browser of its own through the page.
export default async function setup(): Promise<void> {
  const origin = `http://127.0.0.1:${process.env["BZ_E2E_WEB_PORT"]}`;
  const context = await request.newContext({ baseURL: origin });
  const res = await context.post("/v1/pairing", {
    headers: { origin },
    data: { code: await issueCode(), name: "e2e" },
  });
  if (!res.ok()) throw new Error(`pairing failed: ${res.status()} ${await res.text()}`);
  await context.storageState({ path: storageState() });
  await context.dispose();
}
