import { z } from "zod";
import { Id } from "./ids.ts";
import { ProtocolVersion } from "./version.ts";

export * from "./agents.ts";
export * from "./devices.ts";
export * from "./events.ts";
export * from "./holder.ts";
export * from "./holder-frame.ts";
export * from "./ids.ts";
export * from "./agent-name.ts";
export * from "./input.ts";
export * from "./json.ts";
export * from "./mail.ts";
export * from "./notices.ts";
export * from "./origins.ts";
export * from "./roles.ts";
export * from "./shells.ts";
export * from "./stream.ts";
export * from "./theme.ts";
export * from "./tasks.ts";
export * from "./version.ts";

export const RuntimeHealthState = z.enum(["healthy", "unreachable", "not-running"]);
export type RuntimeHealthState = z.infer<typeof RuntimeHealthState>;

export const HealthResponse = z.object({
  status: z.literal("ok"),
  appVersion: z.string(),
  protocolVersion: ProtocolVersion,
  schemaVersion: z.number().int().nonnegative(),
  runtime: z.object({
    kind: z.literal("tmux"),
    state: RuntimeHealthState,
    version: z.string().nullable(),
  }),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

/**
 * `GET /v1/daemon/doctor`, on the Unix socket only: what `bazhen doctor` shows. The environment
 * the daemon captured is counted, never listed, so no value of the user's leaves the daemon.
 */
export const DoctorResponse = z.object({
  appVersion: z.string(),
  protocolVersion: ProtocolVersion,
  runtime: z.object({ state: RuntimeHealthState, version: z.string().nullable() }),
  hookClient: z.object({ path: z.string(), fallback: z.boolean() }),
  config: z.object({ path: z.string(), found: z.boolean() }),
  /** `agents.shell`, and the login shell agents start through when it is "login". */
  agents: z.object({ shell: z.enum(["direct", "login"]), loginShell: z.string().nullable() }),
  /**
   * Codex's managed app-server, as last connected to, and the CLI agents run; null for one
   * not reached. They update apart (foundation-design §5.8). Absent from a daemon before 1.6.
   */
  codex: z.object({ daemon: z.string().nullable(), cli: z.string().nullable() }).optional(),
  /**
   * The external origins the daemon admits besides loopback, where they came from, and whether
   * plain HTTP to another host may be among them (foundation-design §9.2). Absent from a daemon
   * before they existed.
   */
  web: z
    .object({
      externalOrigins: z.array(z.string()),
      from: z.enum(["BAZHEN_EXTERNAL_ORIGINS", "config"]).nullable(),
      allowInsecureOrigins: z.boolean(),
      /**
       * `web.pairing`, and whether browsers must pair under it: always with an external origin.
       * Absent from a daemon before 1.29.
       */
      pairing: z.object({ mode: z.enum(["auto", "always"]), required: z.boolean() }).optional(),
      /** The built web client the daemon serves, or null before `pnpm build`. Absent before 1.33. */
      app: z.string().nullable().optional(),
      /**
       * The LAN listener under `web.listen = "lan"`, or null without one. `certificate` is null,
       * and `error` says why, when it isn't serving. No key material. Absent before 1.36.
       */
      lan: z
        .object({
          url: z.string(),
          allow: z.array(z.string()),
          certificate: z
            .object({ fingerprint: z.string(), path: z.string(), expiresAt: z.iso.datetime() })
            .nullable(),
          error: z.string().nullable(),
          /** This host's subnets, to choose `web.lan_allow` from. */
          subnets: z.array(z.object({ interface: z.string(), cidr: z.string() })),
        })
        .nullable()
        .optional(),
    })
    .optional(),
  /**
   * Whether desktop notifications are on, and the notifier they go through: Bazhen.app on macOS,
   * notify-send on Linux, or null where there is none (on macOS, `pnpm build:notify` builds it).
   * Absent from a daemon before 1.24.
   */
  notifications: z.object({ desktop: z.boolean(), notifier: z.string().nullable() }).optional(),
  /**
   * Terminals open and `terminals.max_open`, and the machine's PTYs in use and its most, or null
   * where they can't be counted. `exact` is false where `used` is an upper bound, as on macOS.
   * `refusing` names the limit refusing new terminals now, if one is. Absent before 1.37.
   */
  terminals: z
    .object({
      open: z.int().nonnegative(),
      max: z.int().positive(),
      host: z
        .object({ used: z.int().nonnegative(), max: z.int().positive(), exact: z.boolean() })
        .nullable(),
      refusing: z.enum(["budget", "host"]).nullable(),
    })
    .optional(),
  /**
   * The holder build new terminals run, named by its hash, or null for none built; and for each
   * holder that answers, the build it runs, null where it can't be told, and the holder/1
   * versions it speaks (design §4.7). Absent before 1.46.
   */
  holder: z
    .object({
      binary: z.string().nullable(),
      build: z.string().nullable(),
      /** Why no build is installed, when none is. */
      reason: z.string().nullable(),
      holders: z.array(
        z.object({
          terminalId: z.string(),
          build: z.string().nullable(),
          protocol: z.array(z.string()),
        }),
      ),
    })
    .optional(),
  env: z.object({
    capturedAt: z.string(),
    /** Captured when the daemon started, or by the latest `bazhen env refresh`. */
    source: z.enum(["start", "refresh"]),
    kept: z.int().nonnegative(),
    /** How many variables each denying rule removed. */
    removed: z.record(z.string(), z.int().nonnegative()),
  }),
});
export type DoctorResponse = z.infer<typeof DoctorResponse>;

/**
 * `POST /v1/codex/pane-title`, on the Unix socket only: a pane's title changed, as a Codex TUI's
 * does when it shows another thread (foundation-design §5.8). It names the pane only; the daemon
 * reads the title itself.
 */
export const PaneTitleChanged = z.object({ pane: z.string().regex(/^%\d+$/) });
export type PaneTitleChanged = z.infer<typeof PaneTitleChanged>;

/**
 * `POST /v1/daemon/env`, on the Unix socket only: the environment of the shell running
 * `bazhen env refresh`, for every agent started from now on (foundation-design §9.5).
 */
export const EnvRefreshRequest = z.object({ env: z.record(z.string(), z.string()) });
export type EnvRefreshRequest = z.infer<typeof EnvRefreshRequest>;

export const EnvRefreshResponse = z.object({
  capturedAt: z.string(),
  kept: z.int().nonnegative(),
  removed: z.record(z.string(), z.int().nonnegative()),
  /** Names left as they were, because tmux can't take their name or value as data. */
  refused: z.array(z.string()),
  /** Agents running now, which keep the environment they started with until respawned. */
  unchanged: z.array(Id("agent")),
});
export type EnvRefreshResponse = z.infer<typeof EnvRefreshResponse>;
