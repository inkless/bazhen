import { request } from "node:http";

/** How long a probe waits for the daemon's answer: one that is up answers its health at once. */
const PROBE_MS = 2000;

/** What a reply this build can't read, though the daemon gave it as a success, means. */
export const ANOTHER_BUILD =
  "the daemon runs another build of Bazhen: restart it with `bazhen stop`, then `bazhen start`";

/** What answers on a socket, as start-up and `bazhen start` ask before taking it (`probe.rs`). */
export type Answer =
  /** Nothing listens: no socket, or one no process listens on, as a daemon that ended leaves. */
  | { readonly kind: "nothing" }
  /**
   * Something may hold the socket but gave no answer: a daemon stuck or busy, one whose backlog is
   * full, or one this process can't reach. Not this one's to replace either.
   */
  | { readonly kind: "silent" }
  /** Something answered, with the protocol id its health names, if it names one. */
  | { readonly kind: "daemon"; readonly protocolId: string | null };

/** Why bazhen won't start over a socket that answered `silent`. */
export function silence(socket: string): string {
  return `something holds ${socket} but gave no answer: a daemon there may be stuck or busy, so bazhen won't start over it`;
}

/** Only a socket that isn't there, or that refuses, is proven free: anything else may be a daemon. */
export function answerOf(err: unknown): Answer {
  const code = err instanceof Error && "code" in err ? err.code : undefined;
  return code === "ENOENT" || code === "ECONNREFUSED" ? { kind: "nothing" } : { kind: "silent" };
}

/** Asks the daemon on `socket` for its health. Never throws. */
export function probe(socket: string, timeoutMs = PROBE_MS): Promise<Answer> {
  return new Promise((resolve) => {
    let replied = false;
    const req = request({ socketPath: socket, method: "GET", path: "/v1/health" }, (res) => {
      replied = true;
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (text += chunk));
      res.on("end", () =>
        resolve({ kind: "daemon", protocolId: res.statusCode === 200 ? spoken(text) : null }),
      );
      // Close follows end, so this answers only for a reply cut short, whose error says no more.
      res.on("error", () => {});
      res.on("close", () => resolve({ kind: "daemon", protocolId: null }));
    });
    req.setTimeout(timeoutMs, () => req.destroy());
    req.on("error", (err) =>
      resolve(replied ? { kind: "daemon", protocolId: null } : answerOf(err)),
    );
    req.end();
  });
}

/** The protocol id a health body names: a string `protocolId` in a JSON object. */
function spoken(body: string): string | null {
  let health: unknown;
  try {
    health = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof health !== "object" || health === null || !("protocolId" in health)) return null;
  return typeof health.protocolId === "string" ? health.protocolId : null;
}
