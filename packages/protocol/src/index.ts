import { z } from "zod";
import { Id } from "./ids.ts";
import { HolderStats } from "./holder.ts";

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

/** One runtime's health, as `bazhen status` and `bazhen doctor` show it. */
export const RuntimeHealthReport = z.object({
  kind: z.string(),
  state: RuntimeHealthState,
  version: z.string().nullable(),
  /**
   * Defects of this runtime's version that Bazhen works around, each with what it costs, worded
   * for a person. Absent from an older daemon.
   */
  workarounds: z.array(z.string()).optional(),
});
export type RuntimeHealthReport = z.infer<typeof RuntimeHealthReport>;

export const HealthResponse = z.object({
  status: z.literal("ok"),
  appVersion: z.string(),
  /** The protocol the daemon speaks (`protocolId()`): a client of another one should reload. */
  protocolId: z.string(),
  runtime: z.object({
    kind: z.literal("tmux"),
    state: RuntimeHealthState,
    version: z.string().nullable(),
  }),
  /**
   * Every runtime the daemon runs terminals on, each read by itself; `runtime` is the worst of
   * them, with tmux's version. Absent from an older daemon.
   */
  runtimes: z.array(RuntimeHealthReport).optional(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

/** A memory cap as configured, and as the kernel enforces it: bytes, or null for none. */
export const MemoryCap = z.object({ asked: z.string(), bytes: z.int().nonnegative().nullable() });
export type MemoryCap = z.infer<typeof MemoryCap>;

/** A cap as people read it: `50% (31.0 GiB)`, `0 (none)`, or `infinity (no cap)`. */
export const memoryCapText = ({ asked, bytes }: MemoryCap) =>
  `${asked} (${bytes === null ? "no cap" : bytes === 0 ? "none" : `${(bytes / 1024 ** 3).toFixed(1)} GiB`})`;

/**
 * `GET /v1/daemon/doctor`, on the Unix socket only: what `bazhen doctor` shows. The environment
 * the daemon captured is counted, never listed, so no value of the user's leaves the daemon.
 */
export const DoctorResponse = z.object({
  appVersion: z.string(),
  protocolId: z.string(),
  runtime: z.object({ state: RuntimeHealthState, version: z.string().nullable() }),
  /** As in `HealthResponse`. Absent from an older daemon. */
  runtimes: z.array(RuntimeHealthReport).optional(),
  hookClient: z.object({ path: z.string(), fallback: z.boolean() }),
  /**
   * The installed binary that reads which process calls on the socket, so a call from inside an
   * agent's process tree is that agent's; null when none is installed, an incomplete install.
   * Absent from an older daemon.
   */
  peerReader: z.object({ path: z.string() }).nullable().optional(),
  config: z.object({ path: z.string(), found: z.boolean() }),
  /** `agents.shell`, and the login shell agents start through when it is "login". */
  agents: z.object({ shell: z.enum(["direct", "login"]), loginShell: z.string().nullable() }),
  /**
   * Codex's managed app-server, as last connected to, and the CLI agents run; null for one
   * not reached. They update apart (foundation-design §5.8). Absent from an older daemon.
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
       * Absent from an older daemon.
       */
      pairing: z.object({ mode: z.enum(["auto", "always"]), required: z.boolean() }).optional(),
      /** The built web client the daemon serves, or null before `pnpm build`. Absent from an older daemon. */
      app: z.string().nullable().optional(),
      /**
       * The LAN listener under `web.listen = "lan"`, or null without one. `certificate` is null,
       * and `error` says why, when it isn't serving. No key material. Absent from an older daemon.
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
   * Absent from an older daemon.
   */
  notifications: z.object({ desktop: z.boolean(), notifier: z.string().nullable() }).optional(),
  /**
   * Terminals open and `terminals.max_open`, and the machine's PTYs in use and its most, or null
   * where they can't be counted. `exact` is false where `used` is an upper bound, as on macOS.
   * `refusing` names the limit refusing new terminals now, if one is. Absent from an older daemon.
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
   * versions it speaks (design §4.7). Absent from an older daemon.
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
          /**
           * Whether it runs in a terminal's systemd scope; null where that can't be read. Absent
           * from an older daemon.
           */
          contained: z.boolean().nullable().optional(),
          /** The socket it answers on. Absent from an older daemon. */
          socket: z.string().optional(),
          /**
           * Its process; null for one that shares no protocol with this build, which names none.
           * Absent from an older daemon.
           */
          holderPid: z.number().int().positive().nullable().optional(),
          /** Its memory, as it reports it; null where it didn't. Absent from an older daemon. */
          stats: HolderStats.nullable().optional(),
        }),
      ),
    })
    .optional(),
  /**
   * Whether each new holder terminal starts in a systemd scope of its own: if so, each terminal's
   * memory cap and swap cap and all terminals' memory together, as configured and as the kernel
   * enforces them (bytes, null for no cap), and whether a process past its cap is killed alone
   * (`OOMPolicy=continue`, systemd 253 or later); if not, why. `unchecked` until a holder terminal
   * has needed it. tmux terminals are never contained. Absent from an older daemon.
   */
  containment: z
    .discriminatedUnion("state", [
      z.object({
        state: z.literal("scoped"),
        systemd: z.int().positive(),
        oomPolicy: z.boolean(),
        terminal: MemoryCap,
        total: MemoryCap,
        swap: MemoryCap,
      }),
      z.object({ state: z.literal("uncontained"), why: z.string() }),
      z.object({ state: z.literal("unchecked") }),
    ])
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
