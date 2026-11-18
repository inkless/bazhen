import { join } from "node:path";
import { socketCall } from "./daemons.ts";

/**
 * Where a project's browser keeps the device cookie the global setup paired it with, with the
 * daemon at `home`: in that home, which teardown removes.
 */
export const storageState = (home: string) => join(home, "browser.json");

/**
 * A fresh pairing code, asked of the daemon at `home` over its socket, as `bazhen devices pair`
 * does.
 */
export async function issueCode(home: string): Promise<string> {
  const body = await socketCall(home, "POST", "/v1/pairing/codes");
  const code: unknown = Reflect.get(Object(body), "code");
  if (typeof code !== "string") throw new Error(`no code in ${JSON.stringify(body)}`);
  return code;
}

/**
 * Dismisses the open notices of the daemon at `home` over its socket, as the owner does with
 * `bazhen devices dismiss`: no paired browser can dismiss a pairing, and the specs count what the
 * inbox holds. Only those of `deviceId`, when it names one.
 */
export async function dismissNotices(home: string, deviceId?: string): Promise<void> {
  const state = await socketCall(home, "GET", "/v1/state");
  const notices: unknown = Reflect.get(Object(state), "notices");
  for (const notice of Array.isArray(notices) ? notices : []) {
    if (Reflect.get(Object(notice), "state") !== "open") continue;
    const device: unknown = Reflect.get(Object(notice), "device");
    if (deviceId !== undefined && Reflect.get(Object(device), "id") !== deviceId) continue;
    const id = String(Reflect.get(Object(notice), "id"));
    await socketCall(home, "POST", `/v1/notices/${id}/dismiss`, { idempotencyKey: `e2e-${id}` });
  }
}
