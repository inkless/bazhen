import { readFileSync } from "node:fs";
import { request } from "node:http";
import { HealthResponse } from "@bazhen/protocol";
import { AGENT_ID_HEADER, AGENT_TOKEN, AGENT_TOKEN_HEADER } from "../auth/agent-token.ts";

/** A daemon that is up answers its health at once; one that doesn't is treated as down. */
const PROBE_MS = 2000;

/** Nothing answers on the daemon's socket: it isn't running, or it is starting or stopping. */
export class DaemonUnreachable extends Error {
  override readonly name = "DaemonUnreachable";
}

/** What a reply this build can't read, though the daemon gave it as a success, means. */
export const ANOTHER_BUILD =
  "the daemon runs another build of Bazhen: restart it with `bazhen stop`, then `bazhen start`";

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
  /** How long the call may take, for one the daemon holds, as a wait does. */
  readonly timeoutMs?: number;
}

/**
 * The agent token in the file the agent's environment names, if it can be read and is one. The
 * daemon refuses an agent that names itself without its token, so one that can't be read is
 * sent as nothing rather than guessed at.
 */
export function agentToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const file = env["BAZHEN_AGENT_AUTH_FILE"];
  if (file === undefined || file === "") return undefined;
  let token: string;
  try {
    token = readFileSync(file, "utf8").trim();
  } catch {
    return undefined;
  }
  return AGENT_TOKEN.test(token) ? token : undefined;
}

/**
 * One command over the daemon's Unix socket, its reply checked against the protocol. A caller
 * inside an agent says which, with its token, as the daemon's rules need (foundation-design §9.1).
 */
export function call<T>(socket: string, c: Call<T>, timeoutMs?: number): Promise<T> {
  const agentId = process.env["BAZHEN_AGENT_ID"];
  const token = agentToken();
  // Advisory, like the agent's: which paired device's shell this runs in, if one opened it.
  const deviceId = process.env["BAZHEN_DEVICE_ID"];
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath: socket,
        method: c.method,
        path: c.path,
        headers: {
          "content-type": "application/json",
          ...(agentId === undefined ? {} : { [AGENT_ID_HEADER]: agentId }),
          ...(token === undefined ? {} : { [AGENT_TOKEN_HEADER]: token }),
          ...(deviceId === undefined ? {} : { "bazhen-device-id": deviceId }),
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
          if (parsed.success) {
            resolve(parsed.data);
            return;
          }
          // A refusal is read by its caller; a success this build can't read came from another.
          const succeeded = (res.statusCode ?? 0) < 300;
          const hint = succeeded ? `\n${ANOTHER_BUILD}` : "";
          reject(new DaemonError(`${c.path}: HTTP ${res.statusCode}: ${text}${hint}`));
        });
      },
    );
    if (timeoutMs !== undefined) req.setTimeout(timeoutMs, () => req.destroy());
    req.on("error", (err) => reject(new DaemonUnreachable(socket, { cause: err })));
    req.end(c.body === undefined ? undefined : JSON.stringify(c.body));
  });
}

/**
 * The protocol id a running daemon speaks, or null for one that names none, from before ids.
 * Throws `DaemonUnreachable` when nothing answers.
 */
export async function spokenProtocol(socket: string): Promise<string | null> {
  const reply = HealthResponse.pick({ status: true, protocolId: true }).partial({
    protocolId: true,
  });
  const health = await call(socket, { method: "GET", path: "/v1/health", reply }, PROBE_MS);
  return health.protocolId ?? null;
}

/**
 * Whether a daemon answers on the socket at all, as `bazhen start` and `stop` ask. Only `status`
 * is read, so `stop` still stops a daemon of another build.
 */
export async function answers(socket: string): Promise<boolean> {
  const reply = HealthResponse.pick({ status: true });
  try {
    await call(socket, { method: "GET", path: "/v1/health", reply }, PROBE_MS);
    return true;
  } catch (err) {
    if (err instanceof DaemonUnreachable) return false;
    throw err;
  }
}
