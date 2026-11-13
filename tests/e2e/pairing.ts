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

/** A fresh pairing code, asked of the run's daemon over its socket, as `bazhen pair` does. */
export function issueCode(): Promise<string> {
  const home = runHome();
  return new Promise((resolve, reject) => {
    const req = request(
      { socketPath: join(home, "run", "bazhen.sock"), method: "POST", path: "/v1/pairing/codes" },
      (res) => {
        let text = "";
        res.on("data", (d: Buffer) => (text += d.toString()));
        res.on("end", () => {
          const body: unknown = JSON.parse(text);
          const code: unknown = Reflect.get(Object(body), "code");
          if (typeof code === "string") resolve(code);
          else reject(new Error(`no code in ${text}`));
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}
