import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";
import { z } from "zod";
import { ENV_RULE, type EnvRules } from "@bazhen/core";
import { memoryMaxRefusal, swapMaxRefusal, type TerminalCaps } from "@bazhen/host-guard";
import {
  HISTORY_LINES,
  HOLDER_MAX_HISTORY_LINES,
  isOrigin,
  originList,
  originsProblem,
} from "@bazhen/protocol";
import { networkInterfaces } from "node:os";
import { localSubnets, parseRange, type Cidr } from "./cidr.ts";
import { resolvePaths, type PathInputs } from "./paths.ts";

const Port = z.int().min(1).max(65_535);
const Shell = z.enum(["direct", "login"]);
const EnvRule = z.string().regex(ENV_RULE, "must be a variable name, or a prefix ending in *");
const Origin = z.string().refine(isOrigin, "must be an origin, such as https://bazhen.example.com");
const Flag = z.enum(["true", "false"]).transform((value) => value === "true");
const Listen = z.enum(["loopback", "lan"]);
const RuntimeKind = z.enum(["tmux", "holder"]);
/** A string `refusal` takes, refused with what it says. */
const checkedBy = (refusal: (value: string) => string | undefined) =>
  z.string().superRefine((value, ctx) => {
    const why = refusal(value);
    if (why !== undefined) ctx.addIssue({ code: "custom", message: `${value} ${why}` });
  });
const MemoryMax = checkedBy(memoryMaxRefusal);
const SwapMax = checkedBy(swapMaxRefusal);
const Range = z.string().superRefine((text, ctx) => {
  const parsed = parseRange(text);
  if ("problem" in parsed) ctx.addIssue({ code: "custom", message: `${text} ${parsed.problem}` });
});

/** The keys `config.toml` may hold. Unknown keys are refused, so a typo never means "default". */
const ConfigFile = z.strictObject({
  daemon: z.strictObject({ port: Port.optional() }).optional(),
  bank: z.strictObject({ path: z.string().startsWith("/").optional() }).optional(),
  notifications: z.strictObject({ desktop: z.boolean().optional() }).optional(),
  shells: z.strictObject({ retype_last_command: z.boolean().optional() }).optional(),
  agents: z
    .strictObject({
      shell: Shell.optional(),
      /** How many agents one agent may have launched to delegate to and still open at once. */
      max_launched: z.int().min(0).optional(),
      /** How many launches down an agent may still launch another. */
      max_launch_depth: z.int().min(1).optional(),
      /** How long an agent's harness has to come up, once its terminal runs, before you're told. */
      start_deadline_seconds: z.int().min(1).optional(),
      env: z
        .strictObject({
          deny: z.array(EnvRule).optional(),
          passthrough: z.array(EnvRule).optional(),
        })
        .optional(),
    })
    .optional(),
  terminals: z
    .strictObject({
      /** How many terminals, agents' and shells', may be open at once. */
      max_open: z.int().min(1).optional(),
      /** The memory each terminal's processes may use together, where they can be contained. */
      memory_max: MemoryMax.optional(),
      /** The memory every terminal's processes may use together. */
      total_memory_max: MemoryMax.optional(),
      /** The swap each terminal's processes may use together, where they can be contained. */
      swap_max: SwapMax.optional(),
      /** How many lines of history above its screen each new terminal keeps. */
      history_lines: z.int().min(0).max(HOLDER_MAX_HISTORY_LINES).optional(),
    })
    .optional(),
  /** Where new terminals run; each one already made stays on the runtime it was made on. */
  runtime: z.strictObject({ default: RuntimeKind.optional() }).optional(),
  web: z
    .strictObject({
      external_origins: z.array(Origin).optional(),
      allow_insecure_origins: z.boolean().optional(),
      pairing: z.enum(["auto", "always"]).optional(),
      /** "lan" also serves HTTPS on every interface, to the ranges `lan_allow` lists. */
      listen: Listen.optional(),
      lan_port: Port.optional(),
      lan_allow: z.array(Range).optional(),
    })
    .optional(),
});
type ConfigFile = z.infer<typeof ConfigFile>;

export interface Config {
  readonly port: number;
  /** From the file only; `resolvePaths` ranks it below the flag and `BAZHEN_BANK`. */
  readonly bank: string | undefined;
  readonly envRules: Required<EnvRules>;
  /** With `agents.shell = "login"`, the shell every agent starts through; otherwise none. */
  readonly loginShell: string | undefined;
  /**
   * Origins the user's own route to the daemon presents, such as a tunnel's domain, which join
   * the Host and Origin allowlists (foundation-design §9.2).
   */
  readonly externalOrigins: readonly string[];
  /** Where they came from, for the start-up log and `bazhen doctor`; null when there are none. */
  readonly externalOriginsFrom: "BAZHEN_EXTERNAL_ORIGINS" | "config" | null;
  /** Whether plain HTTP to another host may be among them. */
  readonly allowInsecureOrigins: boolean;
  /** Whether what needs the human is shown on the host's desktop when no dashboard is. */
  readonly desktopNotifications: boolean;
  /**
   * Whether shells get the integration that reports each line they run, for a restart to type
   * the last one back. Off unless the user turns it on: a line can hold a secret.
   */
  readonly retypeLastCommand: boolean;
  /** `web.pairing`: "always", or "auto", which pairs only once an external origin is set. */
  readonly pairing: "auto" | "always";
  /**
   * Whether every browser must pair, on loopback too (foundation-design §9.2). With an external
   * origin it always must, since a proxy in front can present any request as loopback's.
   */
  readonly pairingRequired: boolean;
  /** The LAN listener under `web.listen = "lan"`: its port, and the ranges it admits. */
  readonly lan: {
    readonly port: number;
    readonly allow: readonly Cidr[];
    readonly ranges: readonly string[];
  } | null;
  /** How far agents may launch agents to delegate to: at once, and down a chain. */
  readonly launchLimits: { readonly maxLaunched: number; readonly maxDepth: number };
  /** `agents.start_deadline_seconds`, in ms: how long a harness has to come up. */
  readonly startDeadlineMs: number;
  /** `terminals.max_open`: past it, a new agent or shell is refused. */
  readonly maxOpenTerminals: number;
  /** `terminals.history_lines`: the history each new terminal keeps, for as long as it runs. */
  readonly historyLines: number;
  /** `runtime.default`: the runtime new terminals are created on. */
  readonly defaultRuntime: z.infer<typeof RuntimeKind>;
  /** `terminals.memory_max`, `terminals.total_memory_max` and `terminals.swap_max`. */
  readonly terminalCaps: TerminalCaps;
}

export class InvalidConfig extends Error {
  override readonly name = "InvalidConfig";
}

const DEFAULT_PORT = 7900;
// Twenty-odd agents with a shell or two each, well under macOS's 511 PTYs.
const DEFAULT_MAX_OPEN_TERMINALS = 100;
// One agent's build may need half the machine; all of them together must leave the rest of it.
const DEFAULT_TERMINAL_MEMORY = "50%";
const DEFAULT_TOTAL_MEMORY = "80%";
// A runaway at its memory cap would otherwise go on into swap, stalling every terminal before the
// kernel killed it.
const DEFAULT_TERMINAL_SWAP = "0";
/** Next to the native app's 7943 (a separate listener with its own key). */
const DEFAULT_LAN_PORT = 7942;
const CONFIG_FILE = "config.toml";

/** The file's settings, or undefined when there is no file. */
export function readConfigFile(file: string): ConfigFile | undefined {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return undefined;
    throw new InvalidConfig(`${file}: ${String(err)}`, { cause: err });
  }
  let toml: unknown;
  try {
    toml = parse(text);
  } catch (err) {
    throw new InvalidConfig(`${file}: ${err instanceof Error ? err.message : String(err)}`, {
      cause: err,
    });
  }
  const parsed = ConfigFile.safeParse(toml);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.join(".") || "(top level)";
    throw new InvalidConfig(`${file}: ${where}: ${issue?.message ?? "invalid"}`);
  }
  return parsed.data;
}

const fromEnv = <T>(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  schema: z.ZodType<T>,
): T | undefined => {
  const raw = env[name];
  if (raw === undefined || raw === "") return undefined;
  const parsed = schema.safeParse(raw);
  if (!parsed.success)
    throw new InvalidConfig(`${name}=${raw}: ${parsed.error.issues[0]?.message}`);
  return parsed.data;
};

/** Each setting from the environment, then the file, then the default. CLI flags reach it as the
 * environment (`bazhen --port` sets BAZHEN_PORT). */
export function resolveConfig(
  file: ConfigFile,
  env: Readonly<Record<string, string | undefined>>,
  subnets: readonly string[] = [],
): Config {
  const port =
    fromEnv(env, "BAZHEN_PORT", z.coerce.number().pipe(Port)) ?? file.daemon?.port ?? DEFAULT_PORT;
  const lan = lanListener(file, env, port, subnets);
  return {
    port,
    bank: file.bank?.path,
    loginShell: loginShell(
      fromEnv(env, "BAZHEN_AGENTS_SHELL", Shell) ?? file.agents?.shell ?? "direct",
      env["SHELL"],
    ),
    envRules: {
      deny: file.agents?.env?.deny ?? [],
      passthrough: file.agents?.env?.passthrough ?? [],
    },
    desktopNotifications: file.notifications?.desktop ?? true,
    retypeLastCommand: file.shells?.retype_last_command ?? false,
    launchLimits: {
      maxLaunched: file.agents?.max_launched ?? 5,
      maxDepth: file.agents?.max_launch_depth ?? 3,
    },
    startDeadlineMs: (file.agents?.start_deadline_seconds ?? 60) * 1000,
    maxOpenTerminals: file.terminals?.max_open ?? DEFAULT_MAX_OPEN_TERMINALS,
    historyLines: file.terminals?.history_lines ?? HISTORY_LINES,
    defaultRuntime: file.runtime?.default ?? "tmux",
    terminalCaps: {
      terminal: file.terminals?.memory_max ?? DEFAULT_TERMINAL_MEMORY,
      total: file.terminals?.total_memory_max ?? DEFAULT_TOTAL_MEMORY,
      swap: file.terminals?.swap_max ?? DEFAULT_TERMINAL_SWAP,
    },
    lan,
    ...withPairing(
      externalOrigins(file, env),
      fromEnv(env, "BAZHEN_PAIRING", PairingMode) ?? file.web?.pairing ?? "auto",
      lan !== null,
    ),
  };
}

/**
 * The LAN listener, if `web.listen` asks for one. It admits only the ranges listed, never a
 * default: the host's own subnets include a café's Wi-Fi, a VPN's and docker's.
 */
function lanListener(
  file: ConfigFile,
  env: Readonly<Record<string, string | undefined>>,
  port: number,
  subnets: readonly string[],
): Config["lan"] {
  const listen = fromEnv(env, "BAZHEN_WEB_LISTEN", Listen) ?? file.web?.listen ?? "loopback";
  if (listen === "loopback") return null;
  const lanPort =
    fromEnv(env, "BAZHEN_LAN_PORT", z.coerce.number().pipe(Port)) ??
    file.web?.lan_port ??
    DEFAULT_LAN_PORT;
  if (lanPort === port)
    throw new InvalidConfig(`web.lan_port: ${lanPort} is the daemon's own port`);
  if (lanPort === 443) {
    throw new InvalidConfig(
      "web.lan_port: 443 isn't supported: browsers leave it out of Host and Origin, which the LAN listener matches with its port; pick another, such as 7942",
    );
  }
  const ranges = file.web?.lan_allow ?? [];
  if (ranges.length === 0) {
    const suggested = subnets.length === 0 ? "" : `, such as ${JSON.stringify(subnets)}`;
    throw new InvalidConfig(
      `web.lan_allow: web.listen is "lan", so list the address ranges that may connect${suggested}`,
    );
  }
  const allow = ranges.map((text) => {
    const parsed = parseRange(text);
    if ("problem" in parsed) throw new InvalidConfig(`web.lan_allow: ${text} ${parsed.problem}`);
    return parsed.range;
  });
  return { port: lanPort, ranges, allow };
}

const PairingMode = z.enum(["auto", "always"]);

/** The LAN listener counts as an external origin: with it on, every browser pairs. */
const withPairing = <T extends { externalOrigins: readonly string[] }>(
  origins: T,
  pairing: "auto" | "always",
  lan: boolean,
) => ({
  ...origins,
  pairing,
  pairingRequired: pairing === "always" || origins.externalOrigins.length > 0 || lan,
});

/** The external origins, from the environment over the file, each checked as the dev server does. */
function externalOrigins(file: ConfigFile, env: Readonly<Record<string, string | undefined>>) {
  const fromVariable = originList(env["BAZHEN_EXTERNAL_ORIGINS"]);
  const fromFile = file.web?.external_origins ?? [];
  const [origins, from] =
    fromVariable.length > 0
      ? [fromVariable, "BAZHEN_EXTERNAL_ORIGINS" as const]
      : fromFile.length > 0
        ? [fromFile, "config" as const]
        : [[], null];
  const allowInsecure =
    fromEnv(env, "BAZHEN_ALLOW_INSECURE_ORIGINS", Flag) ??
    file.web?.allow_insecure_origins ??
    false;
  const problem = originsProblem(origins, allowInsecure);
  const where = from === "BAZHEN_EXTERNAL_ORIGINS" ? from : "web.external_origins";
  if (problem !== null) throw new InvalidConfig(`${where}: ${problem}`);
  return {
    externalOrigins: origins,
    externalOriginsFrom: from,
    allowInsecureOrigins: allowInsecure,
  };
}

/**
 * Where everything lives and how the daemon is configured. The config file sits in the config
 * directory, which itself never comes from the file; the file can then move the bank.
 */
export function loadSettings(inputs: PathInputs) {
  const located = resolvePaths(inputs);
  const configFile = join(located.config, CONFIG_FILE);
  const settings = readConfigFile(configFile);
  const subnets = localSubnets(networkInterfaces()).map((s) => s.cidr);
  const config = resolveConfig(settings ?? {}, inputs.env, subnets);
  const paths =
    config.bank === undefined ? located : resolvePaths({ ...inputs, configBank: config.bank });
  return { paths, config, configFile: { path: configFile, found: settings !== undefined } };
}

/** The login shell to start agents through, which must be the user's own, by absolute path. */
function loginShell(
  shell: z.infer<typeof Shell>,
  userShell: string | undefined,
): string | undefined {
  if (shell === "direct") return undefined;
  if (userShell?.startsWith("/")) return userShell;
  throw new InvalidConfig(`agents.shell is "login", but SHELL is ${userShell ?? "unset"}`);
}
