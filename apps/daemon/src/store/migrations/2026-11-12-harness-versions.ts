import type { Migration } from "../migrations.ts";

export default Object.freeze({
  name: "2026-11-12-harness-versions",
  sql: `
    -- The version each harness's own server last answered on, per environment.
    CREATE TABLE harness_versions (
      environment_id TEXT NOT NULL REFERENCES environments (id),
      harness TEXT NOT NULL,
      version TEXT NOT NULL,
      updated_event_id INTEGER NOT NULL REFERENCES events (id),
      PRIMARY KEY (environment_id, harness)
    ) STRICT;
  `,
} satisfies Migration);
