import { request } from "node:http";
import { join } from "node:path";

/**
 * Where every spec's browser keeps the device cookie the global setup paired it with: in the
 * run's home, which teardown removes.
 */
export const storageState = () => join(runHome(), "browser.json");

function runHome(): string {
  const home = process.env["BZ_E2E_HOME"];
  if (home === undefined) throw new Error("BZ_E2E_HOME is unset");
  return home;
}

/** One request to the run's daemon over its socket, as the CLI makes it; answers the JSON body. */
function socketCall(method: string, path: string, body?: object): Promise<unknown> {
  const home = runHome();
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath: join(home, "run", "bazhen.sock"),
        method,
        path,
        headers: { "content-type": "application/json" },
      },
      (res) => {
        let text = "";
        res.on("data", (d: Buffer) => (text += d.toString()));
        res.on("end", () => {
          if ((res.statusCode ?? 0) >= 400) reject(new Error(`${path}: ${res.statusCode} ${text}`));
          else resolve(JSON.parse(text));
        });
      },
    );
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

/** A fresh pairing code, asked of the run's daemon over its socket, as `bazhen devices pair` does. */
export async function issueCode(): Promise<string> {
  const body = await socketCall("POST", "/v1/pairing/codes");
  const code: unknown = Reflect.get(Object(body), "code");
  if (typeof code !== "string") throw new Error(`no code in ${JSON.stringify(body)}`);
  return code;
}

/**
 * Dismisses open notices over the socket, as the owner does with `bazhen devices dismiss`: no
 * paired browser can dismiss a pairing, and the specs count what the inbox holds. Only those of
 * `deviceId`, when it names one.
 */
export async function dismissNotices(deviceId?: string): Promise<void> {
  const state = await socketCall("GET", "/v1/state");
  const notices: unknown = Reflect.get(Object(state), "notices");
  for (const notice of Array.isArray(notices) ? notices : []) {
    if (Reflect.get(Object(notice), "state") !== "open") continue;
    const device: unknown = Reflect.get(Object(notice), "device");
    if (deviceId !== undefined && Reflect.get(Object(device), "id") !== deviceId) continue;
    const id = String(Reflect.get(Object(notice), "id"));
    await socketCall("POST", `/v1/notices/${id}/dismiss`, { idempotencyKey: `e2e-${id}` });
  }
}
