import { request } from "node:http";
import { HealthResponse } from "@bazhen/protocol";

/** A daemon that is up answers its health at once; one that doesn't is treated as down. */
const PROBE_MS = 2000;

/** Nothing answers on the daemon's socket: it isn't running, or it is starting or stopping. */
export class DaemonUnreachable extends Error {
  override readonly name = "DaemonUnreachable";
}

/** The daemon answered, but not with what this command expects. */
export class DaemonError extends Error {
  override readonly name = "DaemonError";
}

/** A protocol schema, as far as checking a reply needs one. */
export interface Schema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

export interface Call<T> {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly reply: Schema<T>;
  readonly body?: unknown;
}

/**
 * One command over the daemon's Unix socket, its reply checked against the protocol. A caller
 * inside an agent says so, as the daemon's approval rule needs (foundation-design §9.1).
 */
export function call<T>(socket: string, c: Call<T>, timeoutMs?: number): Promise<T> {
  const agentId = process.env["BAZHEN_AGENT_ID"];
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath: socket,
        method: c.method,
        path: c.path,
        headers: {
          "content-type": "application/json",
          ...(agentId === undefined ? {} : { "bazhen-agent-id": agentId }),
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (text += chunk));
        res.on("end", () => {
          let json: unknown;
          try {
            json = JSON.parse(text);
          } catch {
            reject(new DaemonError(`${c.path}: HTTP ${res.statusCode}: ${text}`));
            return;
          }
          const parsed = c.reply.safeParse(json);
          if (parsed.success) resolve(parsed.data);
          else reject(new DaemonError(`${c.path}: HTTP ${res.statusCode}: ${text}`));
        });
      },
    );
    if (timeoutMs !== undefined) req.setTimeout(timeoutMs, () => req.destroy());
    req.on("error", (err) => reject(new DaemonUnreachable(socket, { cause: err })));
    req.end(c.body === undefined ? undefined : JSON.stringify(c.body));
  });
}

/** Whether a daemon answers on the socket at all, as `bazhen start` and `stop` ask. */
export async function answers(socket: string): Promise<boolean> {
  try {
    await call(socket, { method: "GET", path: "/v1/health", reply: HealthResponse }, PROBE_MS);
    return true;
  } catch (err) {
    if (err instanceof DaemonUnreachable) return false;
    throw err;
  }
}
