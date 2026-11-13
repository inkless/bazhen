import { DatabaseSync, type SQLOutputValue, type StatementSync } from "node:sqlite";
import {
  isId,
  offeredCommands,
  newId,
  type AgentLaunchRequest,
  type AgentSessionId,
  type AttachmentId,
  type AttentionId,
  type DeviceId,
  type EnvironmentId,
  type IdPrefix,
  type MessageId,
  type RuntimeRef,
  type TerminalId,
  type TaskView,
} from "@bazhen/core";
import { z } from "zod";
import {
  Activity,
  Usage,
  AgentState,
  Assignment,
  TaskDetail,
  TaskState,
  type AssignmentState,
  EVENTS,
  ExternalRef,
  HarnessId,
  TuiTheme,
  StateSnapshot,
  TerminalState,
  EnvironmentKind,
  AttentionKind,
  type AttentionAction,
  type MailboxState,
  type ResetReason,
  type EventPayload,
  type EventType,
  type ShellCommand,
} from "@bazhen/protocol";
import { LATEST_SCHEMA_VERSION, MIGRATIONS, type Migration } from "./migrations.ts";
import { project, type Recorded, type Statements } from "./projections.ts";

export interface NewEvent<T extends EventType> {
  readonly type: T;
  readonly entityId: string;
  readonly actor: string;
  readonly payload: EventPayload<T>;
  readonly causationId?: number;
  readonly correlationId?: string;
}

/** An event as the log holds it, payload parsed from its JSON. */
export interface LoggedEvent {
  readonly id: number;
  readonly ts: string;
  readonly type: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly actor: string;
  readonly causationId: number | null;
  readonly correlationId: string | null;
  readonly payload: unknown;
}

/** A row's id as a Bazhen id of the given kind, or nothing if it isn't one. */
function rowIds<P extends IdPrefix>(rows: readonly Record<string, SQLOutputValue>[], prefix: P) {
  return rows.flatMap((r) => (typeof r.id === "string" && isId(prefix, r.id) ? [r.id] : []));
}

/** A key reused for a different request: answering with the first one would be a lie. */
export interface OpenAttention {
  readonly id: AttentionId;
  readonly agentId: string;
  readonly kind: AttentionKind;
  readonly toolUseId: string | null;
  readonly mainAgent: boolean;
  /** The message it is about, for mail that could not be delivered. */
  readonly messageId: string | null;
}

export class UnknownDevice extends Error {
  override readonly name = "UnknownDevice";
  constructor(id: string) {
    super(`no device ${id}`);
  }
}

export interface StoredDevice {
  readonly id: DeviceId;
  readonly name: string;
  readonly pairedAt: string;
  readonly lastSeenAt: string;
  readonly revoked: boolean;
  /** Paired over HTTPS. */
  readonly secure: boolean;
}

const DEVICE_COLUMNS = "id, name, paired_at, last_seen_at, revoked_at, secure";

function storedDevice(row: Record<string, SQLOutputValue>): StoredDevice {
  const id = String(row.id);
  if (!isId("dev", id)) throw new RangeError(`not a device id: ${id}`);
  return {
    id,
    name: String(row.name),
    pairedAt: String(row.paired_at),
    lastSeenAt: String(row.last_seen_at),
    revoked: row.revoked_at !== null,
    secure: row.secure === 1,
  };
}

/** No agent the command can act on: none by that id or, given `qualifier`, none that is so. */
export class UnknownAgent extends Error {
  readonly agentId: string;

  constructor(agentId: string, qualifier?: string) {
    super(["no agent", agentId, qualifier].filter(Boolean).join(" "));
    this.agentId = agentId;
  }
}

/** A runtime incarnation as an event records it: the ref, minus the terminal it is for. */
export const runtimePayload = ({ runtime, locator }: RuntimeRef) => ({ runtime, locator });

/** What the state snapshot shows that the store doesn't record. */
export interface SnapshotView {
  /** The machine an environment of this kind runs on. */
  host(kind: EnvironmentKind): string;
  /** How a human attaches to a terminal, or null when they can't. */
  attachCommand(ref: RuntimeRef): string | null;
  /** The harnesses whose agents a respawn can resume. */
  readonly resumable: readonly HarnessId[];
  /** The themes a harness can start its TUI in. */
  themes(harness: HarnessId): readonly TuiTheme[];
  /** What the human can do about an open item now. */
  attentionActions(item: OpenAttention): readonly AttentionAction[];
}

/** Terminal states whose runtime target still exists, so a human can attach to it. */
const ATTACHABLE: ReadonlySet<string> = new Set<TerminalState>(["running", "unknown", "exited"]);

export interface AgentTerminal {
  readonly agentId: AgentSessionId;
  readonly state: AgentState;
  readonly terminalState: TerminalState | null;
  readonly generation: number | null;
  readonly runtime: RuntimeRef | null;
}

const TASK = `SELECT id, title, state, owner_agent_id AS ownerAgentId,
    parent_task_id AS parentTaskId FROM tasks`;
const ASSIGNMENT = `SELECT id, task_id AS taskId, agent_session_id AS agentId, role,
    parent_assignment_id AS parentAssignmentId, state, end_reason AS endReason FROM assignments`;

const AGENT_TERMINAL = `SELECT a.id, a.state AS agent_state, t.id AS terminal_id,
         t.state AS terminal_state, t.generation, t.runtime, t.locator
  FROM agent_sessions a LEFT JOIN terminals t ON t.id = a.terminal_id`;

function agentTerminalFrom(row: Record<string, SQLOutputValue>): AgentTerminal | undefined {
  if (typeof row.id !== "string" || !isId("agent", row.id)) return undefined;
  return {
    agentId: row.id,
    state: AgentState.parse(row.agent_state),
    terminalState: row.terminal_state === null ? null : TerminalState.parse(row.terminal_state),
    generation: typeof row.generation === "number" ? row.generation : null,
    runtime: refFrom(row.terminal_id, row),
  };
}

/** The runtime incarnation a terminal row records, or null while it has none. */
function refFrom(
  terminalId: unknown,
  row: Record<string, SQLOutputValue> | undefined,
): RuntimeRef | null {
  if (typeof terminalId !== "string" || !isId("term", terminalId)) return null;
  if (typeof row?.runtime !== "string") return null;
  const locator: Record<string, string> = JSON.parse(String(row.locator));
  return { terminalId, runtime: row.runtime, locator };
}

/** A shell terminal as its lifecycle needs it. */
export interface ShellTerminal {
  readonly terminalId: TerminalId;
  readonly environmentId: EnvironmentId;
  readonly state: TerminalState;
  readonly generation: number;
  readonly runtime: RuntimeRef | null;
  readonly cwd: string;
  readonly linkedAgentId: string | null;
  readonly theme: TuiTheme | null;
  /** What runs in its foreground, by name, as its events last said; null at its prompt. */
  readonly foreground: string | null;
  /** The directory it was last seen in, or the one it opened in. */
  readonly currentCwd: string;
}

const SHELL_TERMINAL = `SELECT id, environment_id, state, generation, runtime, locator, cwd,
    linked_agent_id, theme, json_extract(foreground, '$.command') AS foreground,
    current_cwd
  FROM terminals WHERE kind = 'shell'`;

function shellFrom(row: Record<string, SQLOutputValue>): ShellTerminal | undefined {
  const { id, environment_id: environmentId } = row;
  if (typeof id !== "string" || !isId("term", id)) return undefined;
  if (typeof environmentId !== "string" || !isId("env", environmentId)) return undefined;
  return {
    terminalId: id,
    environmentId,
    state: TerminalState.parse(row.state),
    generation: Number(row.generation),
    runtime: refFrom(id, row),
    cwd: String(row.cwd),
    linkedAgentId: typeof row.linked_agent_id === "string" ? row.linked_agent_id : null,
    theme: row.theme === null ? null : TuiTheme.parse(row.theme),
    foreground: typeof row.foreground === "string" ? row.foreground : null,
    currentCwd: String(row.current_cwd ?? row.cwd),
  };
}

/** The shell states a close can still act on; a closed one is answered with nothing to do. */
const SHELL_CLOSABLE: ReadonlySet<TerminalState> = new Set(["running", "lost", "closing"]);

/** The shell states that are still a shell someone may name. */
const SHELL_LISTED: ReadonlySet<TerminalState> = new Set([...SHELL_CLOSABLE, "creating"]);

/** The commands a shell takes, where it is in its lifecycle and linked or not (§4.8). */
export function shellCommands(state: TerminalState, linked: boolean): ShellCommand[] {
  return [
    ...(SHELL_CLOSABLE.has(state) ? (["close"] as const) : []),
    ...(state === "lost" ? (["restart"] as const) : []),
    ...(SHELL_LISTED.has(state) ? (["rename"] as const) : []),
    ...(linked && state === "running" ? (["unlink"] as const) : []),
  ];
}

export class IdempotencyConflict extends Error {
  readonly key: string;

  constructor(key: string) {
    super(`idempotency key ${key} was first used for a different request`);
    this.key = key;
  }
}

/** A payload its event type's schema refuses; nothing is recorded. */
export class InvalidEvent extends Error {
  readonly type: EventType;

  constructor(type: EventType, cause: unknown) {
    super(`invalid ${type} payload`, { cause });
    this.type = type;
  }
}

export class SchemaTooNew extends Error {
  readonly found: number;
  readonly supported: number;

  constructor(found: number, supported: number) {
    super(`database schema ${found} is newer than this build supports (${supported})`);
    this.found = found;
    this.supported = supported;
  }
}

/** Running Codex agents, bound to a thread. */
const RUNNING_CODEX = `harness = 'codex' AND state = 'running'
  AND json_extract(external_ref, '$.kind') = 'codex-thread'`;
const THREAD = "json_extract(external_ref, '$.id')";

/** The SQLite seam. Nothing else in the daemon imports node:sqlite. */
export class Store {
  private readonly db: DatabaseSync;
  private host = "";
  private depth = 0;
  private appended = false;
  private afterCommits: (() => void)[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly reactors = new Set<(event: Recorded) => void>();
  /** Every event a projection still points at; retention keeps them, as it keeps projections. */
  private referenced = "";
  private readonly cache = new Map<string, StatementSync>();
  /** What the projections may do: run SQL, inside the transaction that records an event. */
  private readonly statements: Statements = { prepare: (sql) => this.prepare(sql) };

  private constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** This installation's HostId: minted on first open, stamped on every event. */
  hostId(): string {
    return this.host;
  }

  private ensureHost(): void {
    const hasTable = this.db
      .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'host'")
      .get();
    if (!hasTable) return;
    const existing = this.db.prepare("SELECT id FROM host LIMIT 1").get()?.id;
    if (typeof existing === "string") {
      this.host = existing;
      return;
    }
    const id = newId("host");
    this.db
      .prepare("INSERT INTO host (id, created_at) VALUES (?, ?)")
      .run(id, new Date().toISOString());
    this.host = id;
  }

  static open(path: string, migrations: readonly Migration[] = MIGRATIONS): Store {
    const db = new DatabaseSync(path);
    db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL) STRICT");
    const store = new Store(db);
    store.migrate(migrations);
    store.ensureHost();
    store.referenced = referencedEvents(db);
    return store;
  }

  schemaVersion(): number {
    const v = this.db.prepare("SELECT max(version) AS v FROM schema_version").get()?.v;
    return typeof v === "number" ? v : 0;
  }

  private migrate(migrations: readonly Migration[]): void {
    const current = this.schemaVersion();
    const supported = migrations.at(-1)?.version ?? 0;
    if (current > supported) throw new SchemaTooNew(current, supported);
    for (const m of migrations) {
      if (m.version <= current) continue;
      this.transaction(() => {
        this.db.exec(m.sql);
        this.db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(m.version);
      });
    }
  }

  /**
   * Appends a registered event and applies it to the read models in one transaction: if either
   * fails, neither is recorded.
   */
  append<T extends EventType>(event: NewEvent<T>): number {
    const ts = new Date().toISOString();
    return this.transaction(() => {
      const result = this.prepare(
        `INSERT INTO events (host_id, ts, type, entity_type, entity_id, actor, causation_id, correlation_id, payload)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        this.host,
        ts,
        event.type,
        EVENTS[event.type].entity,
        event.entityId,
        event.actor,
        event.causationId ?? null,
        event.correlationId ?? null,
        JSON.stringify(event.payload),
      );
      const id = Number(result.lastInsertRowid);
      this.appended = true;
      // The projection parses the payload with its type's schema, rolling the event back if
      // it doesn't match.
      const recorded = { id, ts, hostId: this.host, ...event };
      try {
        project(this.statements, recorded);
      } catch (err) {
        throw err instanceof z.ZodError ? new InvalidEvent(event.type, err) : err;
      }
      for (const reactor of this.reactors) reactor(recorded);
      return id;
    });
  }

  private prepare(sql: string): StatementSync {
    let statement = this.cache.get(sql);
    if (statement === undefined) {
      statement = this.db.prepare(sql);
      this.cache.set(sql, statement);
    }
    return statement;
  }

  /** The answer first given to a mutation carrying `key`, if there was one. */
  recall(key: string): unknown {
    const row = this.prepare("SELECT response FROM idempotency_keys WHERE key = ?").get(key);
    return typeof row?.response === "string" ? JSON.parse(row.response) : undefined;
  }

  remember(key: string, response: unknown): void {
    this.prepare("INSERT OR REPLACE INTO idempotency_keys (key, response) VALUES (?, ?)").run(
      key,
      JSON.stringify(response),
    );
  }

  environments(kind: EnvironmentKind): EnvironmentId[] {
    const rows = this.prepare(
      "SELECT id FROM environments WHERE kind = ? ORDER BY created_event_id",
    );
    return rowIds(rows.all(kind), "env");
  }

  /** The version a harness's own server last answered on in an environment, if one has. */
  harnessVersion(environmentId: string, harness: HarnessId): string | undefined {
    const row = this.prepare(
      "SELECT version FROM harness_versions WHERE environment_id = ? AND harness = ?",
    ).get(environmentId, harness);
    return typeof row?.version === "string" ? row.version : undefined;
  }

  terminalState(terminalId: string): TerminalState | undefined {
    const row = this.prepare("SELECT state FROM terminals WHERE id = ?").get(terminalId);
    return row === undefined ? undefined : TerminalState.parse(row.state);
  }

  /** A terminal's current runtime incarnation, if it is running in one. */
  runtimeRef(terminalId: string): RuntimeRef | undefined {
    const row = this.prepare("SELECT runtime, locator FROM terminals WHERE id = ?").get(terminalId);
    return refFrom(terminalId, row) ?? undefined;
  }

  /** The epoch of a terminal's last lease grant, or 0 if it has had none. */
  leaseEpoch(terminalId: string): number {
    const row = this.prepare("SELECT epoch FROM leases WHERE terminal_id = ?").get(terminalId);
    return typeof row?.epoch === "number" ? row.epoch : 0;
  }

  /** Attachments recorded as open; after a restart, none of them has a client any more. */
  openAttachments(): AttachmentId[] {
    return rowIds(
      this.prepare("SELECT id FROM attachments_open ORDER BY started_event_id").all(),
      "att",
    );
  }

  /** An agent's messages in the given states, oldest first, with when each was first offered. */
  mail(agentId: string, states: readonly MailboxState[]) {
    const marks = states.map(() => "?").join(", ");
    const rows = this.prepare(
      `SELECT m.id, m.body, m.prompt_id, m.failures, e.ts AS first_offered FROM mailbox m
       LEFT JOIN events e ON e.id = m.first_offered_event_id
       WHERE m.agent_session_id = ? AND m.state IN (${marks}) ORDER BY m.created_event_id`,
    ).all(agentId, ...states);
    return rows.flatMap((r) =>
      typeof r.id === "string" && isId("msg", r.id)
        ? [
            {
              id: r.id,
              body: String(r.body),
              promptId: typeof r.prompt_id === "string" ? r.prompt_id : null,
              firstOffered: typeof r.first_offered === "string" ? r.first_offered : null,
              failures: Number(r.failures),
            },
          ]
        : [],
    );
  }

  /** Messages a hook held when the daemon stopped; their hooks are gone with its socket. */
  inFlight(): { id: MessageId; agentId: string }[] {
    const sql = `SELECT id, agent_session_id FROM mailbox
                 WHERE state IN ('offered', 'emitted', 'seen') ORDER BY created_event_id`;
    return this.prepare(sql)
      .all()
      .flatMap((r) =>
        typeof r.id === "string" && isId("msg", r.id)
          ? [{ id: r.id, agentId: String(r.agent_session_id) }]
          : [],
      );
  }

  /** Open attention items, for one agent or all, with the tool call each is about. */
  openAttention(agentId?: string): OpenAttention[] {
    const sql = `SELECT id, agent_session_id, kind, tool_use_id, main_agent, message_id FROM attention_items
                 WHERE state = 'open' AND (?1 IS NULL OR agent_session_id = ?1) ORDER BY created_event_id`;
    return this.prepare(sql)
      .all(agentId ?? null)
      .flatMap((r) =>
        typeof r.id === "string" && isId("attn", r.id)
          ? [
              {
                id: r.id,
                agentId: String(r.agent_session_id),
                kind: AttentionKind.parse(r.kind),
                toolUseId: typeof r.tool_use_id === "string" ? r.tool_use_id : null,
                mainAgent: r.main_agent === 1,
                messageId: typeof r.message_id === "string" ? r.message_id : null,
              },
            ]
          : [],
      );
  }

  /** Records a newly paired device under the hash of its token; the token itself never comes here. */
  pairDevice(name: string, tokenHash: string, secure: boolean, now: Date): DeviceId {
    return this.transaction(() => {
      const id = newId("dev");
      const at = now.toISOString();
      this.prepare(
        `INSERT INTO devices (id, name, token_hash, paired_at, last_seen_at, secure)
           VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(id, name, tokenHash, at, at, secure ? 1 : 0);
      this.append({ type: "device.paired", entityId: id, actor: "user", payload: { name } });
      return id;
    });
  }

  /** The device whose token hashes to `tokenHash`, revoked or not. */
  deviceByToken(tokenHash: string): StoredDevice | undefined {
    const row = this.prepare(`SELECT ${DEVICE_COLUMNS} FROM devices WHERE token_hash = ?`).get(
      tokenHash,
    );
    return row === undefined ? undefined : storedDevice(row);
  }

  touchDevice(id: DeviceId, now: Date): void {
    this.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(now.toISOString(), id);
  }

  /** Every device not revoked, oldest first. */
  devices(): StoredDevice[] {
    return this.prepare(
      `SELECT ${DEVICE_COLUMNS} FROM devices WHERE revoked_at IS NULL ORDER BY paired_at, id`,
    )
      .all()
      .map(storedDevice);
  }

  /** Revokes a device; one already revoked is left as it is, with no second event. */
  revokeDevice(id: string, now: Date): void {
    this.transaction(() => {
      const row = this.prepare("SELECT revoked_at FROM devices WHERE id = ?").get(id);
      if (row === undefined) throw new UnknownDevice(id);
      if (row.revoked_at !== null) return;
      this.prepare("UPDATE devices SET revoked_at = ? WHERE id = ?").run(now.toISOString(), id);
      this.append({ type: "device.revoked", entityId: id, actor: "user", payload: {} });
    });
  }

  /** One agent's harness, if this daemon runs it. */
  agent(agentId: string): { harness: string; state: AgentState; project: string } | undefined {
    const row = this.prepare("SELECT harness, state, project FROM agent_sessions WHERE id = ?").get(
      agentId,
    );
    return row === undefined
      ? undefined
      : {
          harness: String(row.harness),
          state: AgentState.parse(row.state),
          project: String(row.project),
        };
  }

  /** The agent a message is for. */
  messageAgent(messageId: string): string | undefined {
    const row = this.prepare("SELECT agent_session_id FROM mailbox WHERE id = ?").get(messageId);
    return row === undefined ? undefined : String(row.agent_session_id);
  }

  /**
   * Records what an agent's harness reports it doing. Nothing is recorded, and null returned,
   * for a signal that repeats the latest one (the same value, source and detail: a new observed
   * time or confidence alone is no change, so a stream of tool calls appends one event, and the
   * standing signal's age shows how long it has held), or for one observed before the latest,
   * which arrived late, or for an agent whose process has gone (exited, closed, lost): a
   * harness's last report can land a moment after that, and is about a process no longer there.
   * An agent this daemon never ran is refused.
   */
  recordActivity(agentId: string, activity: Activity): number | null {
    return this.transaction(() => {
      const row = this.prepare("SELECT state FROM agent_sessions WHERE id = ?").get(agentId);
      if (row === undefined) throw new UnknownAgent(agentId);
      if (!REPORTING.has(AgentState.parse(row.state))) return null;
      const latest = this.latestActivity(agentId);
      if (latest !== undefined) {
        if (Date.parse(activity.observedAt) < Date.parse(latest.observedAt)) return null;
        if (sameActivity(latest, activity)) return null;
      }
      return this.append({
        type: "agent.activity",
        entityId: agentId,
        actor: "system",
        payload: activity,
      });
    });
  }

  /**
   * Records the model an agent runs and its context use, as its harness reports them, unless
   * they are what it reported last: a status line redraws often, and only a change is an event.
   * Returns the event id, or null when nothing was recorded, as for an agent whose process has
   * gone. An agent this daemon never ran is refused.
   */
  recordUsage(agentId: string, usage: Usage): number | null {
    return this.transaction(() => {
      const row = this.prepare("SELECT state, usage FROM agent_sessions WHERE id = ?").get(agentId);
      if (row === undefined) throw new UnknownAgent(agentId);
      if (!REPORTING.has(AgentState.parse(row.state))) return null;
      if (typeof row.usage === "string" && row.usage === JSON.stringify(usage)) return null;
      return this.append({
        type: "agent.usage",
        entityId: agentId,
        actor: "system",
        payload: usage,
      });
    });
  }

  /** What an agent's harness last reported it doing in this process, if anything. */
  latestActivity(agentId: string): Activity | undefined {
    const row = this.prepare("SELECT activity FROM activity_latest WHERE agent_session_id = ?").get(
      agentId,
    );
    return row === undefined ? undefined : activityOf(row.activity);
  }

  /** The environment an agent runs in. */
  agentEnvironment(agentId: string): EnvironmentId | undefined {
    const id = this.prepare("SELECT environment_id FROM agent_sessions WHERE id = ?").get(
      agentId,
    )?.environment_id;
    return typeof id === "string" && isId("env", id) ? id : undefined;
  }

  /**
   * The Claude Code session an agent is bound to, and the pid of its pane's process, which is
   * the TUI Bazhen launched (foundation-design §3.1). Either is null when not known.
   */
  claudeBinding(agentId: string): { sessionId: string | null; panePid: number | null } {
    const row = this.prepare(
      `SELECT a.external_ref, t.locator FROM agent_sessions a
       LEFT JOIN terminals t ON t.id = a.terminal_id WHERE a.id = ?`,
    ).get(agentId);
    const ref =
      typeof row?.external_ref === "string"
        ? ExternalRef.parse(JSON.parse(row.external_ref))
        : null;
    const locator: unknown = typeof row?.locator === "string" ? JSON.parse(row.locator) : null;
    const pid = Number(
      typeof locator === "object" && locator !== null ? Reflect.get(locator, "panePid") : NaN,
    );
    return {
      sessionId: ref?.kind === "claude-session" ? ref.id : null,
      panePid: Number.isInteger(pid) && pid > 0 ? pid : null,
    };
  }

  /**
   * The running Codex agent bound to a thread, if exactly one is: of two, neither is guessed at,
   * so nothing meant for one reaches the other.
   */
  codexAgent(threadId: string): string | undefined {
    const sql = `SELECT id FROM agent_sessions WHERE ${RUNNING_CODEX} AND ${THREAD} = ? LIMIT 2`;
    const rows = this.prepare(sql).all(threadId);
    return rows.length === 1 ? String(rows[0]?.id) : undefined;
  }

  /** Every running Codex agent bound to a thread. */
  codexAgentsOn(threadId: string): string[] {
    const sql = `SELECT id FROM agent_sessions WHERE ${RUNNING_CODEX} AND ${THREAD} = ?`;
    return this.prepare(sql)
      .all(threadId)
      .map((r) => String(r.id));
  }

  /**
   * The running Codex agent a message is for, while it is queued or queued in Codex, and whether
   * Codex has taken it yet.
   */
  codexMessageAgent(messageId: string): { agentId: string; inCodex: boolean } | undefined {
    const sql = `SELECT a.id, m.state FROM mailbox m JOIN agent_sessions a ON a.id = m.agent_session_id
                 WHERE m.id = ? AND m.state IN ('queued', 'queued_in_codex')
                   AND a.harness = 'codex' AND a.state = 'running'`;
    const row = this.prepare(sql).get(messageId);
    if (row === undefined) return undefined;
    return { agentId: String(row.id), inCodex: row.state === "queued_in_codex" };
  }

  /** The panes of the running Codex agents on the tmux server at `socket`. */
  codexPanes(socket: string): string[] {
    const sql = `SELECT json_extract(t.locator, '$.paneId') AS pane
                 FROM agent_sessions a JOIN terminals t ON t.id = a.terminal_id
                 WHERE a.harness = 'codex' AND a.state = 'running'
                   AND json_extract(t.locator, '$.socket') = ?`;
    return this.prepare(sql)
      .all(socket)
      .flatMap((r) => (typeof r.pane === "string" ? [r.pane] : []));
  }

  /** The thread a running Codex agent is bound to, if it is one. */
  codexThread(agentId: string): string | undefined {
    const sql = `SELECT ${THREAD} AS thread FROM agent_sessions WHERE ${RUNNING_CODEX} AND id = ?`;
    const row = this.prepare(sql).get(agentId);
    return row === undefined ? undefined : String(row.thread);
  }

  /**
   * The running Codex agent in a tmux pane, on the tmux server at `socket`, with its thread and
   * its terminal's current incarnation.
   */
  codexAgentInPane(socket: string, pane: string) {
    const sql = `SELECT a.id, a.environment_id, json_extract(a.external_ref, '$.id') AS thread,
                        t.id AS terminal_id, t.runtime, t.locator
                 FROM agent_sessions a JOIN terminals t ON t.id = a.terminal_id
                 WHERE a.harness = 'codex' AND a.state = 'running'
                   AND json_extract(a.external_ref, '$.kind') = 'codex-thread'
                   AND json_extract(t.locator, '$.socket') = ?
                   AND json_extract(t.locator, '$.paneId') = ?`;
    const row = this.prepare(sql).get(socket, pane);
    const runtime = row === undefined ? null : refFrom(row.terminal_id, row);
    if (row === undefined || runtime === null) return undefined;
    const environmentId = String(row.environment_id);
    if (!isId("env", environmentId)) return undefined;
    return { agentId: String(row.id), environmentId, threadId: String(row.thread), runtime };
  }

  /** The Codex threads the running Codex agents are bound to. */
  codexThreads(): string[] {
    const sql = `SELECT ${THREAD} AS thread FROM agent_sessions WHERE ${RUNNING_CODEX}`;
    return this.prepare(sql)
      .all()
      .map((r) => String(r.thread));
  }

  /**
   * Runs a mutation once per idempotency key (§5.1): a repeat of the same request gets the first
   * answer, parsed as `parse` reads it; the same key for a different request is refused. The
   * answer is written in the transaction that records the mutation.
   */
  once<T>(key: string, request: unknown, parse: (stored: unknown) => T, mutate: () => T): T {
    const prior = this.replay(key, request, parse);
    if (prior !== undefined) return prior;
    return this.transaction(() => {
      const response = mutate();
      this.answered(key, request, response);
      return response;
    });
  }

  /** The first answer to `key`, parsed; undefined if none. The same key for another request is refused. */
  replay<T>(key: string, request: unknown, parse: (stored: unknown) => T): T | undefined {
    const prior = this.recall(key);
    if (prior === undefined) return undefined;
    const stored: unknown =
      typeof prior === "object" && prior !== null ? Reflect.get(prior, "request") : undefined;
    if (stored !== JSON.stringify(request)) throw new IdempotencyConflict(key);
    return parse(Reflect.get(Object(prior), "response"));
  }

  /** Records the answer to `key`, for `replay`. */
  answered(key: string, request: unknown, response: unknown): void {
    this.remember(key, { request: JSON.stringify(request), response });
  }

  /** The theme a terminal's process was started for: dark when none was named, or it is unknown. */
  terminalTheme(terminalId: string): TuiTheme {
    const row = this.prepare("SELECT theme FROM terminals WHERE id = ?").get(terminalId);
    return TuiTheme.catch("dark").parse(row?.theme);
  }

  /** What an agent was launched with, and the harness session it is on, to start it again. */
  agentLaunch(
    agentId: string,
  ): { launch: AgentLaunchRequest; externalRef: ExternalRef | null } | undefined {
    const row = this.prepare(
      "SELECT harness, project, cwd, external_ref FROM agent_sessions WHERE id = ?",
    ).get(agentId);
    if (row === undefined) return undefined;
    const ref = row.external_ref;
    return {
      launch: {
        harness: HarnessId.parse(row.harness),
        project: String(row.project),
        cwd: String(row.cwd),
      },
      externalRef: typeof ref === "string" ? ExternalRef.parse(JSON.parse(ref)) : null,
    };
  }

  /**
   * An agent and its terminal, found by either id, for a lifecycle change: the agent's state, the
   * terminal's state and generation, and the runtime incarnation it is in.
   */
  agentTerminal(by: { agentId: string } | { terminalId: string }): AgentTerminal | undefined {
    const [where, id] = "agentId" in by ? ["a.id", by.agentId] : ["t.id", by.terminalId];
    const row = this.prepare(`${AGENT_TERMINAL} WHERE ${where} = ?`).get(id);
    return row === undefined ? undefined : agentTerminalFrom(row);
  }

  /**
   * An environment's agents that a restart may have left behind: every one not yet final, with
   * its terminal, oldest first (foundation-design §7).
   */
  recoverable(environmentId: string): AgentTerminal[] {
    const sql = `${AGENT_TERMINAL} WHERE a.environment_id = ?
                 AND a.state NOT IN ('lost', 'closed', 'failed') ORDER BY a.created_event_id`;
    return this.prepare(sql)
      .all(environmentId)
      .flatMap((row) => agentTerminalFrom(row) ?? []);
  }

  shell(terminalId: string): ShellTerminal | undefined {
    const row = this.prepare(`${SHELL_TERMINAL} AND id = ?`).get(terminalId);
    return row === undefined ? undefined : shellFrom(row);
  }

  /** The shells linked to an agent that have not closed yet, oldest first. */
  linkedShells(agentId: string): ShellTerminal[] {
    const sql = `${SHELL_TERMINAL} AND linked_agent_id = ?
                 AND state NOT IN ('closed', 'failed') ORDER BY created_event_id`;
    return this.prepare(sql)
      .all(agentId)
      .flatMap((row) => shellFrom(row) ?? []);
  }

  /** The directory a live shell was last seen in, written only when it changed. */
  noteShellCwd(terminalId: string, cwd: string): void {
    this.prepare(
      `UPDATE terminals SET current_cwd = ?
       WHERE id = ? AND kind = 'shell' AND current_cwd IS NOT ?`,
    ).run(cwd, terminalId, cwd);
  }

  /** Agents that have closed or failed but still have shells linked to them, not yet closed. */
  agentsWithOrphanedShells(): string[] {
    const sql = `SELECT DISTINCT t.linked_agent_id AS id FROM terminals t
                 JOIN agent_sessions a ON a.id = t.linked_agent_id
                 WHERE t.kind = 'shell' AND t.state NOT IN ('closed', 'failed')
                 AND a.state IN ('closed', 'failed')`;
    return this.prepare(sql)
      .all()
      .map((r) => String(r.id));
  }

  /** An environment's shells that a restart may have left behind: every one not yet final. */
  recoverableShells(environmentId: string): ShellTerminal[] {
    const sql = `${SHELL_TERMINAL} AND environment_id = ?
                 AND state NOT IN ('lost', 'closed', 'failed') ORDER BY created_event_id`;
    return this.prepare(sql)
      .all(environmentId)
      .flatMap((row) => shellFrom(row) ?? []);
  }

  /**
   * Every projection the state snapshot shows, with the last event it reflects. `view` adds what
   * only the daemon's surroundings know.
   */
  snapshot(view: SnapshotView): StateSnapshot {
    return this.transaction("read", () =>
      StateSnapshot.parse({
        epoch: this.epoch(),
        eventId: Number(this.prepare("SELECT coalesce(max(id), 0) AS id FROM events").get()?.id),
        environments: this.prepare("SELECT id, kind FROM environments ORDER BY created_event_id")
          .all()
          .map((r) => ({ ...r, host: view.host(EnvironmentKind.parse(r.kind)) })),
        agents: this.prepare(
          `SELECT a.id, a.environment_id AS environmentId, a.harness, a.project, a.cwd, a.state,
                  a.terminal_id AS terminalId, t.generation, a.external_ref AS externalRef, t.exit,
                  coalesce(t.theme, 'dark') AS theme, s.activity, a.usage, t.state AS terminalState,
                  t.runtime, t.locator
           FROM agent_sessions a LEFT JOIN terminals t ON t.id = a.terminal_id
           LEFT JOIN activity_latest s ON s.agent_session_id = a.id
           ORDER BY a.created_event_id`,
        )
          .all()
          .map(({ activity, usage, terminalState, runtime, locator, ...r }) => {
            const ref = ATTACHABLE.has(String(terminalState))
              ? refFrom(r.terminalId, { runtime: runtime ?? null, locator: locator ?? null })
              : null;
            const externalRef =
              typeof r.externalRef === "string" ? JSON.parse(r.externalRef) : null;
            return {
              ...r,
              externalRef,
              exit: typeof r.exit === "string" ? JSON.parse(r.exit) : null,
              ...(activity === null ? {} : { activity: activityOf(activity) }),
              ...(typeof usage === "string" ? { usage: Usage.parse(JSON.parse(usage)) } : {}),
              attachCommand: ref === null ? null : view.attachCommand(ref),
              themes: view.themes(HarnessId.parse(r.harness)),
              commands: offeredCommands(
                {
                  state: AgentState.parse(r.state),
                  generation: typeof r.generation === "number" ? r.generation : null,
                  harness: HarnessId.parse(r.harness),
                  externalRef,
                },
                view.resumable,
              ),
            };
          }),
        attention: this.prepare(
          `SELECT i.id, i.agent_session_id AS agentId, i.state, i.close_reason AS closeReason,
                  i.summary, i.kind, i.task_id AS taskId, i.message_id AS messageId,
                  i.tool_use_id, i.main_agent, e.ts AS openedAt
           FROM attention_items i JOIN events e ON e.id = i.created_event_id
           ORDER BY i.created_event_id`,
        )
          .all()
          .map(({ tool_use_id, main_agent, ...r }) => ({
            ...r,
            actions:
              r.state === "open" && typeof r.id === "string" && isId("attn", r.id)
                ? view.attentionActions({
                    id: r.id,
                    agentId: String(r.agentId),
                    kind: AttentionKind.parse(r.kind),
                    toolUseId: typeof tool_use_id === "string" ? tool_use_id : null,
                    mainAgent: main_agent === 1,
                    messageId: typeof r.messageId === "string" ? r.messageId : null,
                  })
                : [],
          })),
        messages: this.prepare(
          "SELECT id, agent_session_id AS agentId, state FROM mailbox ORDER BY created_event_id",
        ).all(),
        shells: this.prepare(
          `SELECT id, environment_id AS environmentId, state, generation, cwd,
                  linked_agent_id AS linkedAgentId, name, coalesce(theme, 'dark') AS theme,
                  foreground, runtime, locator
           FROM terminals WHERE kind = 'shell' AND state NOT IN ('closed', 'failed') ORDER BY created_event_id`,
        )
          .all()
          .map(({ runtime, locator, foreground, ...r }) => {
            const state = TerminalState.parse(r.state);
            const ref = ATTACHABLE.has(state)
              ? refFrom(r.id, { runtime: runtime ?? null, locator: locator ?? null })
              : null;
            return {
              ...r,
              foreground: typeof foreground === "string" ? JSON.parse(foreground) : null,
              attachCommand: ref === null ? null : view.attachCommand(ref),
              commands: shellCommands(state, r.linkedAgentId !== null),
            };
          }),
        tasks: this.prepare(`${TASK} ORDER BY created_event_id`).all(),
        assignments: this.prepare(`${ASSIGNMENT} ORDER BY created_event_id`).all(),
      }),
    );
  }

  /** A task with its active assignments, for deciding whether a command on it is allowed. */
  taskView(taskId: string): TaskView | undefined {
    const row = this.prepare("SELECT state, owner_agent_id FROM tasks WHERE id = ?").get(taskId);
    if (row === undefined) return undefined;
    const owner = row.owner_agent_id;
    return {
      state: TaskState.parse(row.state),
      ownerAgentId: typeof owner === "string" && isId("agent", owner) ? owner : null,
      openSubtasks: this.prepare("SELECT id FROM tasks WHERE parent_task_id = ? AND state = 'open'")
        .all(taskId)
        .map((r) => String(r.id)),
      active: this.assignments({ taskId }, "active").flatMap(({ id, agentId, role, ...a }) => {
        const parent = a.parentAssignmentId;
        if (!isId("asgn", id) || !isId("agent", agentId)) return [];
        return [
          {
            id,
            agentId,
            role,
            parentAssignmentId: parent !== null && isId("asgn", parent) ? parent : null,
          },
        ];
      }),
    };
  }

  /** A task in full: its brief and note, every assignment it has had, and its subtasks. */
  taskDetail(taskId: string): TaskDetail | undefined {
    const row = this.prepare(`${TASK} WHERE id = ?`).get(taskId);
    if (row === undefined) return undefined;
    const text = this.prepare("SELECT brief, note FROM tasks WHERE id = ?").get(taskId);
    return TaskDetail.parse({
      ...row,
      brief: text?.brief,
      note: text?.note ?? null,
      assignments: this.assignments({ taskId }),
      subtasks: this.prepare(`${TASK} WHERE parent_task_id = ? ORDER BY created_event_id`).all(
        taskId,
      ),
    });
  }

  /** The agents an assignment was granted under, nearest first, up through every task. */
  granters(assignmentId: string): AgentSessionId[] {
    const rows = this.prepare(
      `WITH RECURSIVE up (id, parent, agent, depth) AS (
         SELECT id, parent_assignment_id, agent_session_id, 0 FROM assignments WHERE id = ?
         UNION ALL
         SELECT a.id, a.parent_assignment_id, a.agent_session_id, up.depth + 1
           FROM assignments a JOIN up ON a.id = up.parent
       )
       SELECT agent FROM up WHERE depth > 0 ORDER BY depth`,
    ).all(assignmentId);
    return rows.flatMap((r) =>
      typeof r.agent === "string" && isId("agent", r.agent) ? [r.agent] : [],
    );
  }

  /** The active assignments granted under any of `assignmentIds`, however deep. */
  activeUnder(assignmentIds: readonly string[]): Assignment[] {
    if (assignmentIds.length === 0) return [];
    const marks = assignmentIds.map(() => "?").join(", ");
    return this.prepare(
      `WITH RECURSIVE under (id) AS (
         SELECT id FROM assignments WHERE parent_assignment_id IN (${marks})
         UNION
         SELECT a.id FROM assignments a JOIN under ON a.parent_assignment_id = under.id
       )
       ${ASSIGNMENT} WHERE state = 'active' AND id IN (SELECT id FROM under) ORDER BY created_event_id`,
    )
      .all(...assignmentIds)
      .map((r) => Assignment.parse(r));
  }

  /** A task's open subtasks, however deep, the deepest first, so each can finish before its parent. */
  openSubtasksUnder(taskId: string): string[] {
    return this.prepare(
      `WITH RECURSIVE down (id, depth) AS (
         SELECT id, 1 FROM tasks WHERE parent_task_id = ?
         UNION ALL
         SELECT t.id, down.depth + 1 FROM tasks t JOIN down ON t.parent_task_id = down.id
       )
       SELECT d.id FROM down d JOIN tasks t ON t.id = d.id WHERE t.state = 'open'
       ORDER BY d.depth DESC, t.created_event_id`,
    )
      .all(taskId)
      .map((r) => String(r.id));
  }

  /**
   * The assignments a close ended because they were granted under the closing agent's, after
   * event `afterId`, with the event that ended them.
   */
  endedByClose(afterId: number): (Assignment & { eventId: number })[] {
    return this.prepare(
      `SELECT a.id, a.task_id AS taskId, a.agent_session_id AS agentId, a.role,
              a.parent_assignment_id AS parentAssignmentId, a.state, a.end_reason AS endReason,
              a.updated_event_id AS eventId
       FROM assignments a JOIN events e ON e.id = a.updated_event_id
       WHERE a.end_reason = 'parent_ended' AND e.type = 'agent.closed' AND a.updated_event_id > ?
       ORDER BY a.updated_event_id`,
    )
      .all(afterId)
      .map(({ eventId, ...r }) => ({ ...Assignment.parse(r), eventId: Number(eventId) }));
  }

  /** A task's or an agent's assignments, oldest first, optionally only those in `state`. */
  assignments(by: { taskId: string } | { agentId: string }, state?: AssignmentState): Assignment[] {
    const [column, id] = "taskId" in by ? ["task_id", by.taskId] : ["agent_session_id", by.agentId];
    const filter = state === undefined ? "" : " AND state = ?";
    return this.prepare(`${ASSIGNMENT} WHERE ${column} = ?${filter} ORDER BY created_event_id`)
      .all(...(state === undefined ? [id] : [id, state]))
      .map((r) => Assignment.parse(r));
  }

  /** The id of the newest event, or 0 for an empty log. */
  latestEventId(): number {
    return Number(this.prepare("SELECT coalesce(max(id), 0) AS id FROM events").get()?.id);
  }

  /** The id of the latest event of `type` about an entity, if there is one. */
  lastEventId(entityId: string, type: EventType): number | undefined {
    const row = this.prepare(
      "SELECT max(id) AS id FROM events WHERE entity_id = ? AND type = ?",
    ).get(entityId, type);
    return typeof row?.id === "number" ? row.id : undefined;
  }

  /** This database's epoch, which every cursor into its log carries. */
  epoch(): string {
    return String(this.prepare("SELECT epoch FROM event_log").get()?.epoch);
  }

  /** Events after `afterId`, oldest first. */
  events(afterId: number, limit = 500): LoggedEvent[] {
    const sql = `SELECT id, ts, type, entity_type, entity_id, actor, causation_id, correlation_id, payload
                 FROM events WHERE id > ? ORDER BY id LIMIT ?`;
    return this.prepare(sql)
      .all(afterId, limit)
      .map((r) => ({
        id: Number(r.id),
        ts: String(r.ts),
        type: String(r.type),
        entityType: String(r.entity_type),
        entityId: String(r.entity_id),
        actor: String(r.actor),
        causationId: typeof r.causation_id === "number" ? r.causation_id : null,
        correlationId: typeof r.correlation_id === "string" ? r.correlation_id : null,
        payload: JSON.parse(String(r.payload)),
      }));
  }

  /** Whether the log can no longer continue after `afterId` for a client of store `epoch`. */
  cursorFault(epoch: string, afterId: number): ResetReason | null {
    const row = this.prepare(
      "SELECT epoch, pruned_through, (SELECT coalesce(max(id), 0) FROM events) AS newest FROM event_log",
    ).get();
    if (epoch !== row?.epoch || afterId > Number(row.newest)) return "foreign";
    return afterId < Number(row.pruned_through) ? "stale" : null;
  }

  /**
   * Retires up to `limit` events older than `cutoff`, walking up from where retention last
   * stopped, and answers whether any remain. Events a projection points at stay, and so does the
   * newest event: ids are max(id) + 1, so deleting it would hand out ids retention has passed.
   * Events kept earlier are looked at again each time, and go once nothing points at them.
   */
  pruneBatch(cutoff: Date, limit = 1000): boolean {
    return this.transaction(() => {
      const from = Number(
        this.prepare("SELECT pruned_through FROM event_log").get()?.pruned_through,
      );
      const rows = this.prepare("SELECT id, ts FROM events WHERE id > ? ORDER BY id LIMIT ?").all(
        from,
        limit,
      );
      const young = rows.findIndex((r) => String(r.ts) >= cutoff.toISOString());
      const expired = young === -1 ? rows : rows.slice(0, young);
      const through = Number(expired.at(-1)?.id ?? from);
      this.prepare(
        `DELETE FROM events WHERE id <= ?
           AND id <> (SELECT max(id) FROM events) AND id NOT IN (${this.referenced})`,
      ).run(through);
      this.prepare("UPDATE event_log SET pruned_through = ?").run(through);
      return young === -1 && rows.length === limit;
    });
  }

  /**
   * Runs `fn` in one transaction; nested calls join the outer one. A read takes no write lock,
   * but still sees one consistent state.
   */
  transaction<T>(fn: () => T): T;
  transaction<T>(mode: "read", fn: () => T): T;
  transaction<T>(...args: [() => T] | ["read", () => T]): T {
    const fn = args.length === 1 ? args[0] : args[1];
    if (this.depth > 0) return fn();
    this.db.exec(args.length === 1 ? "BEGIN IMMEDIATE" : "BEGIN DEFERRED");
    this.depth++;
    let out: T;
    try {
      out = fn();
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      this.afterCommits = [];
      this.appended = false;
      throw err;
    } finally {
      this.depth--;
    }
    const appended = this.appended;
    this.appended = false;
    this.runAfterCommits();
    if (appended) this.notify();
    return out;
  }

  /**
   * Runs the work queued for after the commit just made, each in a transaction of its own. The
   * command it followed has committed, so a failure is logged rather than reported as the
   * command's: what failed is left as it was, as mail left queued is offered again later.
   */
  private runAfterCommits(): void {
    const queued = this.afterCommits;
    this.afterCommits = [];
    for (const run of queued) {
      try {
        this.transaction(run);
      } catch (err) {
        console.error("work after a commit failed", err);
      }
    }
  }

  /**
   * Runs `fn` once the transaction in progress commits, and never if it rolls back; at once when
   * none is. For acting outside the store, as handing mail to a hook, only on what was kept.
   */
  afterCommit(fn: () => void): void {
    if (this.depth === 0) fn();
    else this.afterCommits.push(fn);
  }

  /**
   * Calls `reactor` with each event as it is recorded, inside its transaction, so what the
   * reactor appends in turn is committed or rolled back with the event that caused it.
   */
  react(reactor: (event: Recorded) => void): () => void {
    this.reactors.add(reactor);
    return () => this.reactors.delete(reactor);
  }

  /**
   * Calls `listener` after each commit that appended events, never for a rolled-back one. It runs
   * after the mutation has returned, so a failing listener can't fail what already committed.
   */
  onCommit(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      queueMicrotask(() => {
        if (!this.listeners.has(listener)) return;
        try {
          listener();
        } catch (err) {
          console.error("an event listener failed", err);
        }
      });
    }
  }

  close(): void {
    this.db.close();
  }
}

const quote = (name: unknown) => `"${String(name).replaceAll('"', '""')}"`;

/**
 * One query for every event id a projection column points at, read from the schema's foreign
 * keys, so a table added later is kept without retention having to know about it.
 */
function referencedEvents(db: DatabaseSync): string {
  const columns = db
    .prepare(
      `SELECT m.name AS tbl, f."from" AS col FROM sqlite_master m, pragma_foreign_key_list(m.name) f
       WHERE m.type = 'table' AND f."table" = 'events' ORDER BY m.name, f."from"`,
    )
    .all();
  // NOT IN over a NULL is never true, which would keep every event.
  const selects = columns.map(
    (c) => `SELECT ${quote(c.col)} FROM ${quote(c.tbl)} WHERE ${quote(c.col)} IS NOT NULL`,
  );
  return selects.length > 0 ? selects.join(" UNION ") : "SELECT NULL WHERE 0";
}

export { LATEST_SCHEMA_VERSION };

/** The agent states whose process may still report what it is doing. */
const REPORTING: ReadonlySet<AgentState> = new Set(["starting", "running", "unknown"]);

/** Two signals that say the same thing, whenever each was observed and however sure. */
const sameActivity = (a: Activity, b: Activity) =>
  a.value === b.value && a.source === b.source && a.detail === b.detail;

const activityOf = (column: SQLOutputValue | undefined): Activity =>
  Activity.parse(JSON.parse(String(column)));
