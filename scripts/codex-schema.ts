// Holds the Codex fixture's messages to the JSON Schema that Codex's app-server prints for itself,
// committed as it printed it, so the check runs offline and never needs the CLI. Only the keywords
// those files use are read; `format`, `default` and the annotations are not checked, as JSON Schema
// leaves them. A parity capture: it goes with the TypeScript daemon, as codex-fixtures.ts does.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export type Schema = boolean | { readonly [keyword: string]: unknown };

/** Where the schema files are, as `codex app-server generate-json-schema` wrote them. */
export const SCHEMA_DIR = fileURLToPath(
  new URL("../packages/protocol/fixtures/codex-schema/", import.meta.url),
);

/** The keywords a schema here may use; any other is refused, so none is silently not checked. */
const KNOWN = new Set([
  "$ref",
  "$schema",
  "additionalProperties",
  "allOf",
  "anyOf",
  "default",
  "definitions",
  "description",
  "enum",
  "format",
  "items",
  "minLength",
  "minimum",
  "oneOf",
  "properties",
  "required",
  "title",
  "type",
]);

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isSchema = (v: unknown): v is Schema => typeof v === "boolean" || isObject(v);
const isString = (v: unknown): v is string => typeof v === "string";

/** A keyword's schemas, its strings or its named schemas; none when it is absent. */
const schemas = (v: unknown): Schema[] => (Array.isArray(v) ? v.filter(isSchema) : []);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter(isString) : []);
const named = (v: unknown): Map<string, Schema> =>
  new Map(
    isObject(v) ? Object.entries(v).filter((e): e is [string, Schema] => isSchema(e[1])) : [],
  );

function hasType(value: unknown, type: string): boolean {
  switch (type) {
    case "null":
      return value === null;
    case "boolean":
      return typeof value === "boolean";
    case "string":
      return typeof value === "string";
    case "integer":
      return Number.isInteger(value);
    case "number":
      return typeof value === "number";
    case "array":
      return Array.isArray(value);
    case "object":
      return isObject(value);
    default:
      throw new Error(`a schema names the unknown type ${type}`);
  }
}

function resolve(root: Schema, ref: string): Schema {
  const name = /^#\/definitions\/(.+)$/.exec(ref)?.[1];
  const found =
    name === undefined || !isObject(root) ? undefined : named(root["definitions"]).get(name);
  if (found === undefined) throw new Error(`the schema's ${ref} names nothing`);
  return found;
}

/**
 * The problems `value` has against `schema`, a part of `root` that `$ref`s resolve in, each at
 * its path; none when it is valid.
 */
export function problems(root: Schema, value: unknown, schema: Schema = root, at = "$"): string[] {
  if (schema === true) return [];
  if (schema === false) return [`${at}: allowed by no schema`];
  for (const keyword of Object.keys(schema)) {
    if (!KNOWN.has(keyword)) throw new Error(`${at}: the schema keyword ${keyword} isn't read`);
  }
  const out: string[] = [];
  const sub = (s: Schema, v: unknown, path: string) => out.push(...problems(root, v, s, path));
  const valid = (s: Schema) => problems(root, value, s, at).length === 0;

  const ref = schema["$ref"];
  if (isString(ref)) sub(resolve(root, ref), value, at);
  const type = schema["type"];
  if (type !== undefined) {
    const types = isString(type) ? [type] : strings(type);
    if (!types.some((t) => hasType(value, t))) out.push(`${at}: not ${types.join(" or ")}`);
  }
  const allowed = schema["enum"];
  if (Array.isArray(allowed) && !allowed.includes(value)) {
    out.push(`${at}: not one of ${allowed.map(String).join(", ")}`);
  }
  // JSON Schema counts a string's length in code points.
  const minLength = schema["minLength"];
  if (typeof minLength === "number" && isString(value) && Array.from(value).length < minLength) {
    out.push(`${at}: shorter than ${minLength}`);
  }
  const minimum = schema["minimum"];
  if (typeof minimum === "number" && typeof value === "number" && value < minimum) {
    out.push(`${at}: below ${minimum}`);
  }
  if (isObject(value)) {
    const properties = named(schema["properties"]);
    for (const name of strings(schema["required"])) {
      if (!(name in value)) out.push(`${at}.${name}: missing`);
    }
    const extra = schema["additionalProperties"];
    for (const [name, field] of Object.entries(value)) {
      const declared = properties.get(name) ?? (isSchema(extra) ? extra : undefined);
      if (declared !== undefined) sub(declared, field, `${at}.${name}`);
    }
  }
  const items = schema["items"];
  if (isSchema(items) && Array.isArray(value)) {
    value.forEach((item, i) => sub(items, item, `${at}[${i}]`));
  }
  for (const s of schemas(schema["allOf"])) sub(s, value, at);
  if (schema["anyOf"] !== undefined && !schemas(schema["anyOf"]).some(valid)) {
    out.push(`${at}: matches none of anyOf`);
  }
  if (schema["oneOf"] !== undefined) {
    const matched = schemas(schema["oneOf"]).filter(valid).length;
    if (matched !== 1) out.push(`${at}: matches ${matched} of oneOf`);
  }
  return out;
}

/** A schema file Codex wrote, by its name in `SCHEMA_DIR`. */
export function schemaFile(name: string): Schema {
  const parsed: unknown = JSON.parse(readFileSync(join(SCHEMA_DIR, name), "utf8"));
  if (!isSchema(parsed)) throw new Error(`${name} isn't a schema`);
  return parsed;
}

/** The methods a message branch of `ServerNotification.json` or `ServerRequest.json` is sent as. */
function methodsOfBranch(branch: Schema): string[] {
  const method = isObject(branch) ? named(branch["properties"]).get("method") : undefined;
  return isObject(method) ? strings(method["enum"]) : [];
}

/** The methods a `ServerNotification.json` or `ServerRequest.json` file's messages are sent as. */
export const methodsOf = (file: Schema): string[] =>
  isObject(file) ? schemas(file["oneOf"]).flatMap(methodsOfBranch) : [];

const NOTIFICATIONS = "ServerNotification.json";
const REQUESTS = "ServerRequest.json";

/**
 * The problems a notification or request from the server has, against the branch of Codex's
 * schema its method names, so each is said of the field it is about; a method the schema has no
 * message for is one. A request is checked with an id, as the server sends one.
 */
export function messageProblems(method: string, params: unknown): string[] {
  for (const [name, message] of [
    [NOTIFICATIONS, { method }],
    [REQUESTS, { method, id: 0 }],
  ] as const) {
    const file = schemaFile(name);
    const branches = isObject(file) ? schemas(file["oneOf"]) : [];
    const branch = branches.find((b) => methodsOfBranch(b).includes(method));
    if (branch === undefined) continue;
    return problems(file, params === undefined ? message : { ...message, params }, branch);
  }
  return [`$.method: Codex sends no ${method}`];
}
