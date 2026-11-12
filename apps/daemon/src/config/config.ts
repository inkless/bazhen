import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";
import { z } from "zod";
import { ENV_RULE, type EnvRules } from "@bazhen/core";
import { resolvePaths, type PathInputs } from "./paths.ts";

const Port = z.int().min(1).max(65_535);
const EnvRule = z.string().regex(ENV_RULE, "must be a variable name, or a prefix ending in *");

/** The keys `config.toml` may hold. Unknown keys are refused, so a typo never means "default". */
const ConfigFile = z.strictObject({
  daemon: z.strictObject({ port: Port.optional() }).optional(),
  bank: z.strictObject({ path: z.string().startsWith("/").optional() }).optional(),
  agents: z
    .strictObject({
      env: z
        .strictObject({
          deny: z.array(EnvRule).optional(),
          passthrough: z.array(EnvRule).optional(),
        })
        .optional(),
    })
    .optional(),
});
type ConfigFile = z.infer<typeof ConfigFile>;

export interface Config {
  readonly port: number;
  /** From the file only; `resolvePaths` ranks it below the flag and `BAZHEN_BANK`. */
  readonly bank: string | undefined;
  readonly envRules: Required<EnvRules>;
}

export class InvalidConfig extends Error {
  override readonly name = "InvalidConfig";
}

const DEFAULT_PORT = 7900;
const CONFIG_FILE = "config.toml";

/** The file's settings; a missing file has none. */
export function readConfigFile(file: string): ConfigFile {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return {};
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
    envRules: {
      deny: file.agents?.env?.deny ?? [],
      passthrough: file.agents?.env?.passthrough ?? [],
    },
  };
}

/**
 * Where everything lives and how the daemon is configured. The config file sits in the config
 * directory, which itself never comes from the file; the file can then move the bank.
 */
export function loadSettings(inputs: PathInputs) {
  const located = resolvePaths(inputs);
  const config = resolveConfig(readConfigFile(join(located.config, CONFIG_FILE)), inputs.env);
  const paths =
    config.bank === undefined ? located : resolvePaths({ ...inputs, configBank: config.bank });
  return { paths, config };
}
