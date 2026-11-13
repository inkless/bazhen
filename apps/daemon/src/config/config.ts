import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";
import { z } from "zod";
import { ENV_RULE, type EnvRules } from "@bazhen/core";
import { isOrigin, originList, originsProblem } from "@bazhen/protocol";
import { resolvePaths, type PathInputs } from "./paths.ts";

const Port = z.int().min(1).max(65_535);
const Shell = z.enum(["direct", "login"]);
const EnvRule = z.string().regex(ENV_RULE, "must be a variable name, or a prefix ending in *");
const Origin = z.string().refine(isOrigin, "must be an origin, such as https://bazhen.example.com");
const Flag = z.enum(["true", "false"]).transform((value) => value === "true");

/** The keys `config.toml` may hold. Unknown keys are refused, so a typo never means "default". */
const ConfigFile = z.strictObject({
  daemon: z.strictObject({ port: Port.optional() }).optional(),
  bank: z.strictObject({ path: z.string().startsWith("/").optional() }).optional(),
  agents: z
    .strictObject({
      shell: Shell.optional(),
      env: z
        .strictObject({
          deny: z.array(EnvRule).optional(),
          passthrough: z.array(EnvRule).optional(),
        })
        .optional(),
    })
    .optional(),
  web: z
    .strictObject({
      external_origins: z.array(Origin).optional(),
      allow_insecure_origins: z.boolean().optional(),
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
}

export class InvalidConfig extends Error {
  override readonly name = "InvalidConfig";
}

const DEFAULT_PORT = 7900;
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
): Config {
  return {
    port:
      fromEnv(env, "BAZHEN_PORT", z.coerce.number().pipe(Port)) ??
      file.daemon?.port ??
      DEFAULT_PORT,
    bank: file.bank?.path,
    loginShell: loginShell(
      fromEnv(env, "BAZHEN_AGENTS_SHELL", Shell) ?? file.agents?.shell ?? "direct",
      env["SHELL"],
    ),
    envRules: {
      deny: file.agents?.env?.deny ?? [],
      passthrough: file.agents?.env?.passthrough ?? [],
    },
    ...externalOrigins(file, env),
  };
}

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
  const config = resolveConfig(settings ?? {}, inputs.env);
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
