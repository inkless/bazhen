import { createHash, randomBytes } from "node:crypto";
import { chmodSync, lstatSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Context, Hono, Next } from "hono";
import { isId, type AgentSessionId, type Caller } from "@bazhen/core";
import type { ErrorResponse } from "@bazhen/protocol";
import { ensurePrivateDir } from "../config/private-dir.ts";
import type { Store } from "../store/store.ts";
import { AGENT_ID_HEADER, AGENT_TOKEN, AGENT_TOKEN_HEADER } from "./agent-token.ts";

const hashOf = (token: string): string => createHash("sha256").update(token).digest("hex");

/** A token file isn't as it was written, so no agent is started on it. */
export class UnsafeTokenFile extends Error {
  constructor(path: string, reason: string) {
    super(`refusing to start an agent on ${path}: ${reason}`);
  }
}

/** What identifying a caller needs to know of agents' tokens. */
export interface AgentCredentials {
  /** The live agent `token` is the current token of. */
  agentOf(token: string): AgentSessionId | undefined;
  /**
   * Whether `agentId` is an agent running from before agents had tokens, which no start has given
   * one since: the one kind of agent known by the id it names. An unknown id is no agent.
   */
  untokened(agentId: string): boolean;
}

/** A token minted for one start of an agent, until the start goes ahead or is refused. */
export interface MintedToken {
  /** The file the start runs with. */
  readonly file: string;
  /** The start went ahead: the files of the agent's earlier tokens go. */
  kept(): void;
  /** The start never happened: the agent's last token holds again, and this one's file goes. */
  abandoned(): void;
}

/** The token each start of an agent runs with. */
export interface AgentTokenIssuer {
  /**
   * A new token for the agent's next process, which takes the place of the last at once: the new
   * process may call before its start returns.
   */
  mint(agentId: string): MintedToken;
  /** Removes the agent's token files, once nothing will run on them again. */
  forget(agentId: string): void;
}

/**
 * Starts one process of an agent on a new token: kept once `start` resolves, abandoned if it
 * fails, so a refused start leaves the agent's running process its token.
 */
export async function startWithToken<T>(
  tokens: AgentTokenIssuer,
  agentId: string,
  start: (tokenFile: string) => Promise<T>,
): Promise<T> {
  const minted = tokens.mint(agentId);
  let started: T;
  try {
    started = await start(minted.file);
  } catch (cause) {
    minted.abandoned();
    throw cause;
  }
  minted.kept();
  return started;
}

/** A token file's name: its agent, a start's own part, and `.tmp` while a mint writes it. */
const TOKEN_FILE = /^(agent_[0-9a-f]+)\.[0-9a-f]+\.token(\.tmp)?$/;

/** Agent states whose token files no start will need again. */
const ENDED = new Set(["closed", "failed"]);

/**
 * Agents' tokens. The store keeps only each one's hash; the token is in a 0600 file, in a 0700
 * directory, that the agent's environment names. A file rather than a value: an environment
 * value reaches the runtime on its command line, which every user of the machine can read. Each
 * start's file has a name of its own, so a process left from an earlier start, which still names
 * its own file, never reads a later token.
 */
export class AgentTokens implements AgentCredentials, AgentTokenIssuer {
  private readonly store: Store;
  private readonly dir: string;
  private readonly uid: number;
  private readonly random: (size: number) => Buffer;

  constructor(
    store: Store,
    dir: string,
    uid: number,
    random: (size: number) => Buffer = randomBytes,
  ) {
    this.store = store;
    this.dir = dir;
    this.uid = uid;
    this.random = random;
  }

  mint(agentId: string): MintedToken {
    if (!isId("agent", agentId)) throw new UnsafeTokenFile(agentId, "it isn't an agent id");
    ensurePrivateDir(this.dir, this.uid);
    const token = this.random(32).toString("base64url");
    const path = join(this.dir, `${agentId}.${this.random(8).toString("hex")}.token`);
    const next = `${path}.tmp`;
    writeFileSync(next, token, { mode: 0o600, flag: "wx" });
    // The umask may have taken bits the owner needs; nobody else may have any.
    chmodSync(next, 0o600);
    renameSync(next, path);
    const stat = lstatSync(path);
    if (!stat.isFile()) throw new UnsafeTokenFile(path, "it isn't a regular file");
    if (stat.uid !== this.uid) throw new UnsafeTokenFile(path, `it is owned by uid ${stat.uid}`);
    if ((stat.mode & 0o777) !== 0o600)
      throw new UnsafeTokenFile(path, `its mode is ${(stat.mode & 0o777).toString(8)}`);
    const previous = this.store.agentTokenHash(agentId);
    this.store.noteAgentToken(agentId, hashOf(token));
    return {
      file: path,
      kept: () => {
        this.store.keptAgentToken(agentId);
        for (const file of this.filesOf(agentId)) if (file !== path) remove(file);
      },
      // An agent that had no token keeps the one minted, whose file is gone: no process holds it,
      // and its bare id still names it.
      abandoned: () => {
        if (previous !== null) this.store.noteAgentToken(agentId, previous);
        remove(path);
      },
    };
  }

  forget(agentId: string): void {
    for (const file of this.filesOf(agentId)) remove(file);
  }

  /**
   * Removes the files of agents that have ended, or that the store doesn't know, and any a mint
   * left half written: an agent closed while the daemon was down, or by reconciliation, left
   * its file behind. Nothing but a token file is touched.
   */
  sweep(): void {
    ensurePrivateDir(this.dir, this.uid);
    for (const name of this.names()) {
      const file = TOKEN_FILE.exec(name);
      if (file === null) continue;
      const state = this.store.agent(file[1] ?? "")?.state;
      if (file[2] !== undefined || state === undefined || ENDED.has(state))
        remove(join(this.dir, name));
    }
  }

  agentOf(token: string): AgentSessionId | undefined {
    if (!AGENT_TOKEN.test(token)) return undefined;
    const agentId = this.store.agentByTokenHash(hashOf(token));
    return agentId !== undefined && isId("agent", agentId) ? agentId : undefined;
  }

  untokened(agentId: string): boolean {
    return this.store.agentUntokened(agentId);
  }

  private filesOf(agentId: string): string[] {
    return this.names()
      .filter((name) => {
        const file = TOKEN_FILE.exec(name);
        return file !== null && file[1] === agentId && file[2] === undefined;
      })
      .map((name) => join(this.dir, name));
  }

  private names(): string[] {
    try {
      return readdirSync(this.dir);
    } catch {
      return [];
    }
  }
}

/** A token file that can't be removed is left, said once: its token no longer names an agent. */
function remove(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch (cause) {
    console.warn(`bazhen: can't remove the agent token file ${path}:`, cause);
  }
}

/** Who a socket caller is: the human, an agent, or refused for what it presented. */
export type Identity =
  | { readonly kind: "human" }
  | { readonly kind: "agent"; readonly agentId: AgentSessionId }
  | { readonly kind: "refused"; readonly reason: string };

/**
 * Who a caller is, from the token and agent id it presents (foundation-design §9.1). A token
 * names its agent, and an id beside it must be that agent's. An id alone counts only for an agent
 * running from before agents had tokens, until a start of its own gives it one; any other is
 * refused. A caller that presents neither is the human.
 *
 * Every token file is this user's, so a process of this user that reads another agent's file can
 * present it, and one that unsets both can pass as the human: telling those apart is the socket
 * peer's job.
 */
export function identify(
  credentials: AgentCredentials,
  presented: { readonly token: string | undefined; readonly said: string | undefined },
): Identity {
  const { token, said } = presented;
  if (token !== undefined) {
    const agentId = credentials.agentOf(token);
    if (agentId === undefined) return refused("the agent token is no live agent's");
    if (said !== undefined && said !== agentId)
      return refused(`the agent token is not agent ${said}'s`);
    return { kind: "agent", agentId };
  }
  if (said === undefined) return { kind: "human" };
  if (!isId("agent", said)) return refused(`not an agent id: ${said}`);
  if (!credentials.untokened(said)) return refused(`agent ${said} must present its agent token`);
  return { kind: "agent", agentId: said };
}

const refused = (reason: string): Identity => ({ kind: "refused", reason });

/** Who called, as `guardCallers` found it: an agent by its id, or the human as null. */
export type CallerEnv = { Variables: { caller?: Caller; refusal?: string; agentOpen?: boolean } };

/**
 * The socket routes an agent may use: reading state, its own task and mail verbs, launching
 * through a delegation, its own rename, and the reports a shell or tmux makes. Every other route
 * is the human's, whether or not it is listed below: a route nobody classified refuses agents.
 */
export const AGENT_OPEN: readonly string[] = [
  "/v1/health",
  "/v1/state",
  "/v1/roles",
  "/v1/daemon/doctor",
  "/v1/tasks",
  "/v1/tasks/delegate",
  "/v1/tasks/:id",
  "/v1/tasks/:id/assign",
  "/v1/tasks/:id/unassign",
  "/v1/tasks/:id/finish",
  "/v1/tasks/:id/notes",
  "/v1/tasks/:id/messages",
  "/v1/escalations",
  "/v1/agents/:id/messages",
  "/v1/agents/:id/rename",
  "/v1/messages/wait",
  "/v1/shells/:id/report",
  "/v1/shells/:id/prompt",
  "/v1/codex/pane-title",
];

/**
 * The human's routes, each with what an agent is told it can't do: pairing and revoking
 * browsers, stopping the daemon or replacing every later agent's environment, acting on
 * attention items and notices, launching an agent outside a delegation's limits, running
 * agents' terminals, and the shells.
 */
export const HUMANS_ONLY: readonly (readonly [path: string, what: string])[] = [
  ["/v1/pairing/codes", "pair a device"],
  ["/v1/devices", "list paired devices"],
  ["/v1/devices/:id/revoke", "revoke a device"],
  ["/v1/daemon/stop", "stop the daemon"],
  ["/v1/daemon/env", "replace the agents' environment"],
  ["/v1/attention/:id/answer", "answer an attention item"],
  ["/v1/attention/:id/reply", "reply to an attention item"],
  ["/v1/attention/:id/dismiss", "dismiss an attention item"],
  ["/v1/attention/:id/resend", "resend an attention item"],
  ["/v1/notices/:id/dismiss", "dismiss a notice"],
  ["/v1/agents", "launch an agent but by delegating"],
  ["/v1/agents/:id/close", "close an agent"],
  ["/v1/agents/:id/respawn", "respawn an agent"],
  ["/v1/agents/:id/relaunch", "relaunch an agent"],
  ["/v1/agents/:id/signal", "signal an agent"],
  ["/v1/shells", "open a shell"],
  ["/v1/shells/:id/close", "close a shell"],
  ["/v1/shells/:id/restart", "restart a shell"],
  ["/v1/shells/:id/rename", "rename a shell"],
  ["/v1/shells/:id/unlink", "unlink a shell"],
];

/** Hook routes answer in their own framing, and take their agent as `identify` says themselves. */
export const SELF_IDENTIFIED: readonly string[] = ["/v1/hooks", "/v1/hooks/ack"];

const forbidden = (c: Context, message: string) => {
  const body: ErrorResponse = { error: "forbidden", message };
  return c.json(body, 403);
};

/**
 * Identifies every socket request once, before any route sees it (foundation-design §9.1): a
 * credential that doesn't hold is refused on every route, an agent is refused every route but
 * those in `AGENT_OPEN`, and each route reads who called from `caller`.
 */
export function guardCallers<E extends CallerEnv>(app: Hono<E>, credentials: AgentCredentials) {
  app.use("/v1/*", async (c: Context<CallerEnv>, next: Next) => {
    if (SELF_IDENTIFIED.includes(c.req.path)) return next();
    const who = identify(credentials, {
      token: c.req.header(AGENT_TOKEN_HEADER),
      said: c.req.header(AGENT_ID_HEADER),
    });
    if (who.kind === "refused") c.set("refusal", who.reason);
    else c.set("caller", who.kind === "agent" ? who.agentId : null);
    return next();
  });
  for (const [path, what] of HUMANS_ONLY) {
    app.use(path, async (c: Context<CallerEnv>, next: Next) => {
      if (c.get("caller") === null) return next();
      const refusal = c.get("refusal");
      return forbidden(c, `an agent can't ${what}${refusal === undefined ? "" : `: ${refusal}`}`);
    });
  }
  for (const path of AGENT_OPEN) {
    app.use(path, async (c: Context<CallerEnv>, next: Next) => {
      c.set("agentOpen", true);
      return next();
    });
  }
  app.use("/v1/*", async (c: Context<CallerEnv>, next: Next) => {
    const refusal = c.get("refusal");
    if (refusal !== undefined) return forbidden(c, refusal);
    const caller = c.get("caller");
    if (caller === undefined || caller === null || c.get("agentOpen") === true) return next();
    return forbidden(c, `an agent can't use ${c.req.method} ${c.req.path}`);
  });
}
