/*
 * What a set of example values exercises of a message's JSON Schema, so fixtures written for
 * another language's types can be held to cover them: each property present, each optional one
 * absent, each nullable one null, each branch of a union and each value of an enum.
 *
 * A path names a place in a value: `agents[].exit.(type=signalled).signal` is the `signal` of an
 * agent's `exit` when that is the union branch whose `type` is `signalled`; `removed{}` is any
 * value of the record `removed`.
 */

/** As much of a JSON Schema as zod writes for the protocol, and this walk reads. */
export interface JsonSchema {
  readonly type?: string | readonly string[];
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly items?: JsonSchema;
  readonly additionalProperties?: JsonSchema | boolean;
  readonly anyOf?: readonly JsonSchema[];
  readonly oneOf?: readonly JsonSchema[];
  readonly enum?: readonly unknown[];
  readonly const?: unknown;
}

type Seen = Set<string>;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Whether null is a value of `s`: zod writes a nullable scalar as `type: [..., "null"]`. */
const allowsNull = (s: JsonSchema): boolean =>
  s.type === "null" ||
  (Array.isArray(s.type) && s.type.includes("null")) ||
  (s.anyOf ?? []).some(allowsNull);

/** The branch's discriminator, as the one property whose schema is a constant. */
function discriminator(branch: JsonSchema): [string, unknown] | undefined {
  const found = Object.entries(branch.properties ?? {}).find(([, p]) => p.const !== undefined);
  return found === undefined ? undefined : [found[0], found[1].const];
}

const branchPath = (path: string, branch: JsonSchema, index: number) => {
  const d = discriminator(branch);
  return d === undefined ? `${path}.(#${index})` : `${path}.(${d[0]}=${String(d[1])})`;
};

/** Everything a complete set of fixtures exercises of `schema`. */
export function required(schema: JsonSchema, path = "", out: Seen = new Set()): Seen {
  for (const branch of schema.anyOf ?? []) required(branch, path, out);
  (schema.oneOf ?? []).forEach((branch, i) => {
    const at = branchPath(path, branch, i);
    out.add(`branch:${at}`);
    required(branch, at, out);
  });
  for (const value of schema.enum ?? []) out.add(`enum:${path}=${JSON.stringify(value)}`);
  for (const [key, property] of Object.entries(schema.properties ?? {})) {
    const at = path === "" ? key : `${path}.${key}`;
    out.add(`present:${at}`);
    if (!(schema.required ?? []).includes(key)) out.add(`absent:${at}`);
    if (allowsNull(property)) out.add(`null:${at}`);
    required(property, at, out);
  }
  if (schema.items !== undefined) required(schema.items, `${path}[]`, out);
  if (typeof schema.additionalProperties === "object") {
    out.add(`present:${path}{}`);
    required(schema.additionalProperties, `${path}{}`, out);
  }
  return out;
}

/** What `value`, valid under `schema`, exercises of it. */
export function exercised(
  schema: JsonSchema,
  value: unknown,
  path = "",
  out: Seen = new Set(),
): Seen {
  for (const branch of schema.anyOf ?? []) {
    if (branch.type !== "null") exercised(branch, value, path, out);
  }
  (schema.oneOf ?? []).forEach((branch, i) => {
    const d = discriminator(branch);
    if (d !== undefined && isObject(value) && value[d[0]] === d[1]) {
      const at = branchPath(path, branch, i);
      out.add(`branch:${at}`);
      exercised(branch, value, at, out);
    }
  });
  if (schema.enum !== undefined && schema.enum.includes(value)) {
    out.add(`enum:${path}=${JSON.stringify(value)}`);
  }
  if (isObject(value)) {
    for (const [key, property] of Object.entries(schema.properties ?? {})) {
      const at = path === "" ? key : `${path}.${key}`;
      if (!(key in value)) {
        out.add(`absent:${at}`);
        continue;
      }
      out.add(`present:${at}`);
      if (value[key] === null) out.add(`null:${at}`);
      else exercised(property, value[key], at, out);
    }
    if (typeof schema.additionalProperties === "object") {
      const known = new Set(Object.keys(schema.properties ?? {}));
      for (const [key, field] of Object.entries(value)) {
        if (known.has(key)) continue;
        out.add(`present:${path}{}`);
        exercised(schema.additionalProperties, field, `${path}{}`, out);
      }
    }
  }
  if (Array.isArray(value) && schema.items !== undefined) {
    for (const item of value) exercised(schema.items, item, `${path}[]`, out);
  }
  return out;
}

/** What `values` together leave unexercised of `schema`, sorted. */
export function uncovered(schema: JsonSchema, values: readonly unknown[]): string[] {
  const seen: Seen = new Set();
  for (const value of values) exercised(schema, value, "", seen);
  return [...required(schema)].filter((r) => !seen.has(r)).toSorted();
}

/** Each enum's place and values in `schema`, for making a value that holds each. */
export function enumPaths(schema: JsonSchema): Map<string, readonly unknown[]> {
  const out = new Map<string, readonly unknown[]>();
  for (const r of required(schema)) {
    const m = /^enum:(.*)=(.*)$/.exec(r);
    if (m?.[1] === undefined || m[2] === undefined) continue;
    out.set(m[1], [...(out.get(m[1]) ?? []), JSON.parse(m[2])]);
  }
  return out;
}

/**
 * `value` with `replacement` at every place `path` names in it, or undefined when it has no such
 * place. Union branches are matched by their discriminator.
 */
export function replaceAt(value: unknown, path: string, replacement: unknown): unknown {
  const steps = path === "" ? [] : splitPath(path);
  let hit = false;
  const walk = (v: unknown, i: number): unknown => {
    const step = steps[i];
    if (step === undefined) {
      hit = true;
      return replacement;
    }
    if (step === "[]") return Array.isArray(v) ? v.map((item) => walk(item, i + 1)) : v;
    const branch = /^\((.+)=(.+)\)$/.exec(step);
    if (branch !== null) {
      return isObject(v) && String(v[branch[1] ?? ""]) === branch[2] ? walk(v, i + 1) : v;
    }
    if (!isObject(v) || !(step in v) || v[step] === null) return v;
    return { ...v, [step]: walk(v[step], i + 1) };
  };
  const out = walk(value, 0);
  return hit ? out : undefined;
}

const splitPath = (path: string) =>
  path
    .replaceAll("[]", ".[]")
    .split(".")
    .filter((s) => s !== "");

/**
 * `value` with `field` set in every object whose shape the schema fixes, nested ones, array items
 * and union branches included, though never in a record, whose keys are its data.
 */
export function withField(schema: JsonSchema, value: unknown, field: string): unknown {
  if (value === null) return value;
  const branch =
    schema.anyOf?.find((b) => b.type !== "null") ??
    schema.oneOf?.find((b) => {
      const d = discriminator(b);
      return d !== undefined && isObject(value) && value[d[0]] === d[1];
    });
  if (branch !== undefined) return withField(branch, value, field);
  if (Array.isArray(value) && schema.items !== undefined) {
    const items = schema.items;
    return value.map((item) => withField(items, item, field));
  }
  if (!isObject(value)) return value;
  if (typeof schema.additionalProperties === "object") {
    const values = schema.additionalProperties;
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, withField(values, v, field)]),
    );
  }
  const properties = schema.properties ?? {};
  const out = Object.fromEntries(
    Object.entries(value).map(([k, v]) => {
      const property = properties[k];
      return [k, property === undefined ? v : withField(property, v, field)];
    }),
  );
  return { ...out, [field]: { any: [1] } };
}

/** `value` with every lone surrogate in its strings made U+FFFD, as UTF-8 can hold it. */
export function wellFormed(value: unknown): unknown {
  if (typeof value === "string") return value.toWellFormed();
  if (Array.isArray(value)) return value.map(wellFormed);
  if (isObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, wellFormed(v)]));
  }
  return value;
}
