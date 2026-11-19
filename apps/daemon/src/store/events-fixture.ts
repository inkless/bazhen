import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveRoles } from "@bazhen/core";
import { CreateTaskRequest, EVENTS, EventFrame } from "@bazhen/protocol";
import { z } from "zod";
import { builtinRoles } from "../roles/roles.ts";
import { type Launcher, Tasks } from "../tasks/tasks.ts";
import { type SnapshotView, Store } from "./store.ts";

/** Schema kinds that make a value other than the one stored, which a stream passing it on can't. */
const REWRITES = new Set(["pipe", "transform", "default", "prefault", "catch"]);

/** Whether `schema`, under any optional or nullable, rewrites the value it parses. */
function rewrites(schema: z.core.$ZodType): boolean {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) {
    return rewrites(schema.unwrap());
  }
  return !(schema instanceof z.ZodType) || REWRITES.has(schema.def.type);
}

/**
 * Each event type with the entity it is about and the payload keys a client is sent, in the
 * order the stream sends them. A payload is filtered by these keys alone, and its values passed
 * on as stored, so every type's streamed shape must be its payload's with top-level keys left
 * out and nothing else changed, and no kept key may rewrite its value: a nested omission or a
 * transform would stream what the key filter can't redact or reproduce. A string's `trim` is the
 * one rewrite left, since a title is stored trimmed.
 */
export function eventRegistry(
  events: Readonly<
    Record<string, { entity: string; payload: z.ZodType; streamed?: z.ZodType }>
  > = EVENTS,
) {
  return Object.entries(events).map(([type, { entity, payload, streamed = payload }]) => {
    if (!(payload instanceof z.ZodObject) || !(streamed instanceof z.ZodObject)) {
      throw new Error(`${type}: a payload or its streamed shape is not an object`);
    }
    const kept = Object.keys(streamed.shape);
    const changed = kept.filter(
      (key) => streamed.shape[key] !== payload.shape[key] || rewrites(streamed.shape[key]),
    );
    if (changed.length > 0 || streamed.def.catchall !== payload.def.catchall) {
      throw new Error(`${type}: streams ${changed.join(", ") || "its unknown keys"} differently`);
    }
    return { type, entity, streamed: kept };
  });
}

const fixedId = (prefix: string, n: number) =>
  `${prefix}_0190000000007000800000000000${n.toString(16).padStart(4, "0")}`;

/** Every id the fixture mints, swapped for a fixed one of its shape, so it is reproducible. */
function steady(text: string, db: DatabaseSync): string {
  const values = (sql: string) =>
    db
      .prepare(sql)
      .all()
      .map((row) => String(Object.values(row)[0]));
  const swaps = new Map<string, string>();
  for (const host of values("SELECT id FROM host"))
    swaps.set(host, fixedId("host", swaps.size + 1));
  for (const task of values("SELECT id FROM tasks ORDER BY created_event_id"))
    swaps.set(task, fixedId("task", swaps.size + 1));
  for (const epoch of values("SELECT epoch FROM event_log")) swaps.set(epoch, "e".repeat(32));
  let out = text;
  for (const [from, to] of swaps) out = out.replaceAll(from, to);
  return out;
}

function unused(): never {
  throw new Error("the events fixture holds nothing a snapshot view describes, and mails no one");
}

/** A snapshot view for a store holding nothing a view describes: any use of it is a fault here. */
const NO_VIEW: SnapshotView = {
  host: unused,
  attachCommand: unused,
  resumes: unused,
  themes: unused,
  attentionActions: unused,
  noticeActions: unused,
  get shellsReport(): boolean {
    return unused();
  },
  listening: unused,
  promptHash: unused,
};

/**
 * What the Rust daemon's event log is held to: the registry, and a log the human made with task
 * commands, as rows, as the stream sends each one, and as the snapshot reads it, with the
 * idempotency keys its commands recorded.
 */
export function eventsFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "bazhen-events-fixture-"));
  try {
    const path = join(dir, "events.db");
    const store = Store.open(path);
    const { book } = resolveRoles(builtinRoles(), []);
    const launcher: Launcher = { launch: unused, maxLaunched: 0, maxDepth: 0 };
    const tasks = new Tasks(store, { send: unused }, unused, launcher, () => book);
    // As the route hands them over: parsed, so the title is trimmed.
    const parent = { idempotencyKey: "create parent", title: "  Ship the port ", brief: "all" };
    const first = tasks.create(null, CreateTaskRequest.parse(parent));
    const child = {
      idempotencyKey: "create child",
      title: "Events",
      brief: "the log",
      parentTaskId: first.taskId,
    };
    const second = tasks.create(null, CreateTaskRequest.parse(child));
    tasks.note(null, first.taskId, { idempotencyKey: "note", text: "half done" });
    tasks.finish(null, second.taskId, {
      idempotencyKey: "finish",
      outcome: "done",
      note: "merged",
    });
    const requests = [parent, child];
    const created = [first, second];
    store.close();
    const db = new DatabaseSync(path);
    try {
      db.exec(`UPDATE events SET ts = strftime('2026-11-01T00:00:%S.000Z', id, 'unixepoch');
               UPDATE host SET created_at = '2026-11-01T00:00:00.000Z'`);
      const read = Store.open(path);
      const frames = read
        .events(0)
        .map((event) => JSON.stringify(EventFrame.parse({ type: "event", event })));
      const snapshot = read.snapshot(NO_VIEW);
      read.close();
      const rows = (table: string) =>
        db
          .prepare(`SELECT * FROM ${table} ORDER BY rowid`)
          .all()
          .map((row) => ({ ...row }));
      const fixture = {
        registry: eventRegistry(),
        log: {
          requests,
          responses: created,
          tables: Object.fromEntries(
            ["host", "events", "tasks", "task_notes", "idempotency_keys", "event_log"].map((t) => [
              t,
              rows(t),
            ]),
          ),
          frames,
          snapshot,
        },
      };
      return steady(`${JSON.stringify(fixture, null, 2)}\n`, db);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
