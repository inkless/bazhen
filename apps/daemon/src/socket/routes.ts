import type { HttpBindings } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Socket } from "node:net";
import { guardCallers, type AgentCredentials, type CallerEnv } from "../auth/callers.ts";
import type { PeerReading } from "../auth/peer.ts";
import type { DeviceAuth } from "../auth/devices.ts";
import type { AppEnv } from "../http/app.ts";
import type { PairingCodes } from "../auth/pairing.ts";
import type { ReportOutcome } from "../shells/reports.ts";
import { UnknownDevice } from "../store/store.ts";
import {
  EnvRefreshRequest,
  PaneTitleChanged,
  ShellDecline,
  ShellPrompt,
  ShellReport,
  DoctorResponse,
  PairingCodeResponse,
  type DevicesResponse,
  type RevokeDeviceResponse,
  type EnvRefreshResponse,
  type ErrorResponse,
  type StopResponse,
} from "@bazhen/protocol";

export interface SocketParts {
  /** The `/v1` command routes, unguarded: the socket's permission is the authentication. */
  readonly commands: Hono<AppEnv>;
  readonly hooks: Hono<{ Bindings: HttpBindings }>;
  /** Agents' tokens, which tell an agent's call from the human's. */
  readonly credentials: AgentCredentials;
  /** Whose process is at the other end of a connection; absent when it can't be read. */
  readonly peer?: (connection: Socket) => Promise<PeerReading>;
  /** Stops the daemon; called once the reply to `stop` has been written. */
  readonly stop: () => void;
  readonly doctor: () => Promise<DoctorResponse>;
  /** Agents started from now on get `env`, filtered as at start-up (foundation-design §9.5). */
  readonly refreshEnv: (env: Readonly<Record<string, string>>) => Promise<EnvRefreshResponse>;
  /** A tmux pane's title changed; the daemon reads it itself (foundation-design §5.8). */
  readonly paneTitleChanged: (pane: string) => void;
  readonly pairing: Pick<PairingCodes, "issue">;
  readonly devices: Pick<DeviceAuth, "list" | "revoke">;
  /** The configured external origins, which `bazhen pair` shows as the addresses to open. */
  readonly externalOrigins: readonly string[];
  /** The LAN listener's address and fingerprint while it serves, for `bazhen pair` to show. */
  readonly lan: () => PairingCodeResponse["lan"];
  /** A shell's integration reported the line it is running (foundation-design §4.8). */
  readonly shellReport: (terminalId: string, report: ShellReport) => ReportOutcome;
  /** It reached its first prompt; false when the report wasn't the shell's own. */
  readonly shellPrompt: (terminalId: string, report: ShellPrompt) => boolean;
  /** At its first prompt, it won't take a line typed back; false when not the shell's own. */
  readonly shellDecline: (terminalId: string, report: ShellDecline) => boolean;
}

/**
 * The most bytes of a shell's report read before it is refused: a whole line the daemon keeps,
 * every character escaped as `\uXXXX`, its token and the fields around them fit with room.
 */
const REPORT_MAX_BYTES = 16 * 1024;
/** A prompt report, or a decline, is its token alone. */
const PROMPT_MAX_BYTES = 1024;

const tooLarge = (c: Context) => {
  const body: ErrorResponse = { error: "invalid_request", message: "report too large" };
  return c.json(body, 413);
};

const forbidden = (c: Context, message: string) => {
  const body: ErrorResponse = { error: "forbidden", message };
  return c.json(body, 403);
};

/**
 * What the daemon's 0600 Unix socket serves: the hook ingress, the full command set, and routes a
 * browser must never reach (foundation-design §5.1, §9.1).
 */
export function socketApp(parts: SocketParts): Hono<{ Bindings: HttpBindings } & CallerEnv> {
  const app = new Hono<{ Bindings: HttpBindings } & CallerEnv>();

  guardCallers(app, parts.credentials, parts.peer);

  // The code is in this reply only, to the person who ran `bazhen pair`; the daemon never logs it.
  app.post("/v1/pairing/codes", (c) => {
    const { code, expiresAt } = parts.pairing.issue();
    const lan = parts.lan();
    const body = PairingCodeResponse.parse({
      code,
      expiresAt: expiresAt.toISOString(),
      origins: [...parts.externalOrigins],
      ...(lan === undefined ? {} : { lan }),
    });
    return c.json(body);
  });

  app.get("/v1/devices", (c) => {
    const body: DevicesResponse = { devices: parts.devices.list() };
    return c.json(body);
  });

  app.post("/v1/devices/:id/revoke", (c) => {
    const id = c.req.param("id");
    try {
      parts.devices.revoke(id);
    } catch (err) {
      if (!(err instanceof UnknownDevice)) throw err;
      const body: ErrorResponse = { error: "not_found", message: err.message };
      return c.json(body, 404);
    }
    const body: RevokeDeviceResponse = {};
    return c.json(body);
  });

  app.post("/v1/daemon/stop", (c) => {
    c.env.outgoing.once("finish", parts.stop);
    const body: StopResponse = {};
    return c.json(body);
  });

  app.get("/v1/daemon/doctor", async (c) => c.json(DoctorResponse.parse(await parts.doctor())));

  // The body is the user's whole environment: it is used and dropped, never logged or stored.
  app.post("/v1/daemon/env", async (c) => {
    const req = EnvRefreshRequest.safeParse(await c.req.json().catch(() => undefined));
    if (!req.success) {
      const body: ErrorResponse = { error: "invalid_request", message: "expected { env }" };
      return c.json(body, 400);
    }
    return c.json(await parts.refreshEnv(req.data.env));
  });

  // tmux's hook, through the hook client: it names a pane, and nothing it says is trusted further.
  app.post("/v1/codex/pane-title", async (c) => {
    const req = PaneTitleChanged.safeParse(await c.req.json().catch(() => undefined));
    if (!req.success) {
      const body: ErrorResponse = { error: "invalid_request", message: "expected { pane }" };
      return c.json(body, 400);
    }
    parts.paneTitleChanged(req.data.pane);
    return c.body(null, 204);
  });

  // A shell's integration, through the hook client. The line can hold a secret the user typed:
  // it goes to the store and nowhere else, and a refusal names no part of it. Only the socket
  // serves this route, never HTTP.
  app.post(
    "/v1/shells/:id/report",
    bodyLimit({
      maxSize: REPORT_MAX_BYTES,
      onError: tooLarge,
    }),
    async (c) => {
      const req = ShellReport.safeParse(await c.req.json().catch(() => undefined));
      if (!req.success) {
        const body: ErrorResponse = {
          error: "invalid_request",
          message: "expected { token, at, command }",
        };
        return c.json(body, 400);
      }
      const outcome = parts.shellReport(c.req.param("id"), req.data);
      if (outcome === "refused") return forbidden(c, "no such shell, or not its token");
      return c.body(null, 204);
    },
  );

  app.post(
    "/v1/shells/:id/prompt",
    bodyLimit({ maxSize: PROMPT_MAX_BYTES, onError: tooLarge }),
    async (c) => {
      const req = ShellPrompt.safeParse(await c.req.json().catch(() => undefined));
      if (!req.success) {
        const body: ErrorResponse = { error: "invalid_request", message: "expected { token }" };
        return c.json(body, 400);
      }
      if (!parts.shellPrompt(c.req.param("id"), req.data))
        return forbidden(c, "no such shell, or not its token");
      return c.body(null, 204);
    },
  );

  app.post(
    "/v1/shells/:id/decline",
    bodyLimit({ maxSize: PROMPT_MAX_BYTES, onError: tooLarge }),
    async (c) => {
      const req = ShellDecline.safeParse(await c.req.json().catch(() => undefined));
      if (!req.success) {
        const body: ErrorResponse = { error: "invalid_request", message: "expected { token }" };
        return c.json(body, 400);
      }
      if (!parts.shellDecline(c.req.param("id"), req.data))
        return forbidden(c, "no such shell, or not its token");
      return c.body(null, 204);
    },
  );

  app.route("/", parts.hooks);
  app.route("/", parts.commands);
  return app;
}
