import { createHash, randomBytes } from "node:crypto";
import { chmodSync, lstatSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Socket } from "node:net";
import type { HttpBindings } from "@hono/node-server";
import type { Context, Hono, Next } from "hono";
import { isId, type AgentSessionId, type Caller } from "@bazhen/core";
import type { ErrorResponse } from "@bazhen/protocol";
import { ensurePrivateDir } from "../config/private-dir.ts";
import type { Store } from "../store/store.ts";
import {
  AGENT_ID_HEADER,
  AGENT_TOKEN,
  AGENT_TOKEN_HEADER,
  CODEX_THREAD_HEADER,
} from "./agent-token.ts";
import type { CodexReading, PeerReading } from "./peer.ts";

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
  /** The live Codex agent bound to thread `threadId`; without it, no Codex agent is known. */
  codexAgent?(threadId: string): AgentSessionId | undefined;
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

  codexAgent(threadId: string): AgentSessionId | undefined {
    const agentId = this.store.codexAgent(threadId);
    return agentId !== undefined && isId("agent", agentId) ? agentId : undefined;
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
 * peer's job. A Codex tool call runs out of the agent's terminal, under the Codex app-server, so
 * only the thread it names says which agent it is: the live agent bound to that thread, or refused.
 * Any agent's command can name any thread, so this tells Codex agents apart only as far as they
 * keep to their own.
 */
export function identify(
  credentials: AgentCredentials,
  presented: Presented,
  peer: PeerReading = { kind: "outside" },
): Identity {
  if (peer.kind === "refused") return refused(peer.reason);
  if (peer.kind === "codex") return asCodex(credentials, presented, peer.via);
  if (peer.kind === "agent") return asPeer(credentials, presented, peer.agentId);
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

/** What a caller presents: an agent token, an agent id, and the Codex thread it runs in. */
export interface Presented {
  readonly token: string | undefined;
  readonly said: string | undefined;
  readonly thread?: string | undefined;
}

/**
 * What a request presents, by its headers. An empty agent id is none: a Codex thread sets
 * `BAZHEN_AGENT_ID` empty over the app-server's own environment, which has no way to unset it, and
 * a caller that sends it empty could as well send nothing, so reading it as an id gives no check.
 */
export function presentedBy(header: (name: string) => string | undefined): Presented {
  return {
    token: header(AGENT_TOKEN_HEADER),
    said: header(AGENT_ID_HEADER) || undefined,
    thread: header(CODEX_THREAD_HEADER),
  };
}

/** A Codex thread id as the app-server makes them; anything else names no thread. */
const CODEX_THREAD = /^[0-9A-Za-z-]{1,64}$/;

/**
 * A Codex tool call is the live agent bound to the thread it names, else refused. Under the
 * server, what else it presents is the server's environment, which is whoever started the server's,
 * an agent's tool call included, and never the thread's agent's own: it is not held against the
 * call. A caller marked by its own environment only may be any process outside every terminal, so
 * another agent's token or id beside the thread still refuses it.
 */
function asCodex(
  credentials: AgentCredentials,
  presented: Presented,
  via: CodexReading["via"],
): Identity {
  const { thread } = presented;
  if (thread === undefined) return refused("a Codex tool call names no thread");
  if (!CODEX_THREAD.test(thread)) return refused("a Codex tool call names no Codex thread");
  const agentId = credentials.codexAgent?.(thread);
  if (agentId === undefined) return refused(`Codex thread ${thread} is no live agent's`);
  if (via === "server") return { kind: "agent", agentId };
  return asPeer(credentials, presented, agentId);
}

/**
 * A caller whose own process is agent `agentId`'s is that agent, whatever it presents or leaves
 * out; a token or an id it does present must be that agent's own.
 */
function asPeer(
  credentials: AgentCredentials,
  { token, said }: Presented,
  agentId: AgentSessionId,
): Identity {
  if (token !== undefined && credentials.agentOf(token) !== agentId)
    return refused(`the agent token is not agent ${agentId}'s, whose process calls`);
  if (said !== undefined && said !== agentId)
    return refused(`agent ${agentId}'s process names agent ${said}`);
  return { kind: "agent", agentId };
}

const refused = (reason: string): Identity => ({ kind: "refused", reason });

/** Who called, as `guardCallers` found it: an agent by its id, or the human as null. */
export type CallerEnv = { Variables: { caller?: Caller; refusal?: string; agentOpen?: boolean } };

/** The socket's own requests, which carry the connection a peer is read from. */
export type SocketEnv = { Bindings: HttpBindings } & CallerEnv;

/**
 * The socket routes an agent may use, each by its method: reading state, its own task and mail
 * verbs, launching through a delegation, its own rename, and the reports a shell makes.
 * Every other route and method is the human's, whether or not it is listed below: one nobody
 * classified refuses agents.
 */
export const AGENT_OPEN: readonly (readonly [method: string, path: string])[] = [
  ["GET", "/v1/health"],
  ["GET", "/v1/state"],
  ["GET", "/v1/caller"],
  ["GET", "/v1/roles"],
  ["GET", "/v1/daemon/doctor"],
  ["POST", "/v1/tasks"],
  ["POST", "/v1/tasks/delegate"],
  ["GET", "/v1/tasks/:id"],
  ["POST", "/v1/tasks/:id/assign"],
  ["POST", "/v1/tasks/:id/unassign"],
  ["POST", "/v1/tasks/:id/finish"],
  ["POST", "/v1/tasks/:id/notes"],
  ["POST", "/v1/tasks/:id/messages"],
  ["POST", "/v1/escalations"],
  ["POST", "/v1/agents/:id/messages"],
  ["POST", "/v1/agents/:id/rename"],
  ["POST", "/v1/messages/wait"],
  ["POST", "/v1/waits"],
  ["POST", "/v1/shells/:id/report"],
  ["POST", "/v1/shells/:id/prompt"],
  ["POST", "/v1/shells/:id/decline"],
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

/**
 * Routes the guard doesn't identify a caller for. The hooks answer in their own framing, and
 * identify their agent themselves. tmux's pane-title hook runs under the tmux server in no
 * terminal, and names only a pane whose title the daemon then reads itself.
 */
export const SELF_IDENTIFIED: readonly string[] = [
  "/v1/hooks",
  "/v1/hooks/ack",
  "/v1/codex/pane-title",
];

const forbidden = (c: Context, message: string) => {
  const body: ErrorResponse = { error: "forbidden", message };
  return c.json(body, 403);
};

/**
 * Identifies every socket request once, before any route sees it (foundation-design §9.1): a
 * credential that doesn't hold is refused on every route, an agent is refused every route but
 * those in `AGENT_OPEN`, and each route reads who called from `caller`. With `peer`, every request
 * is also matched to the process that made it; without, a caller that presents nothing is the
 * human.
 */
export function guardCallers(
  app: Hono<SocketEnv>,
  credentials: AgentCredentials,
  peer?: (connection: Socket) => Promise<PeerReading>,
) {
  app.use("/v1/*", async (c: Context<SocketEnv>, next: Next) => {
    if (SELF_IDENTIFIED.includes(c.req.path)) return next();
    const reading = peer === undefined ? undefined : await peer(c.env.incoming.socket);
    const who = identify(
      credentials,
      presentedBy((name) => c.req.header(name)),
      reading,
    );
    if (who.kind === "refused") c.set("refusal", who.reason);
    else c.set("caller", who.kind === "agent" ? who.agentId : null);
    return next();
  });
  for (const [path, what] of HUMANS_ONLY) {
    app.use(path, async (c: Context<SocketEnv>, next: Next) => {
      if (c.get("caller") === null) return next();
      const refusal = c.get("refusal");
      return forbidden(c, `an agent can't ${what}${refusal === undefined ? "" : `: ${refusal}`}`);
    });
  }
  for (const [method, path] of AGENT_OPEN) {
    app.use(path, async (c: Context<SocketEnv>, next: Next) => {
      if (c.req.method === method) c.set("agentOpen", true);
      return next();
    });
  }
  app.use("/v1/*", async (c: Context<SocketEnv>, next: Next) => {
    const refusal = c.get("refusal");
    if (refusal !== undefined) return forbidden(c, refusal);
    const caller = c.get("caller");
    if (caller === undefined || caller === null || c.get("agentOpen") === true) return next();
    return forbidden(c, `an agent can't use ${c.req.method} ${c.req.path}`);
  });
}
