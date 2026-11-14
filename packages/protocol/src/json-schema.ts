import { z } from "zod";
import * as protocol from "./index.ts";

/**
 * Every schema the protocol exports, as JSON Schema, keyed by file name. Clients in other
 * languages read these files instead of the TypeScript (foundation-design §5.5).
 */
export function jsonSchemas(): Record<string, string> {
  const schemas = Object.entries(protocol).flatMap(([name, value]) =>
    value instanceof z.ZodType ? [[name, value] as const] : [],
  );
  return Object.fromEntries(
    schemas
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([name, schema]) => [
        `${name}.json`,
        `${JSON.stringify({ $id: name, ...z.toJSONSchema(schema, { override: forPeers }) }, null, 2)}\n`,
      ]),
  );
}

function forPeers(ctx: {
  zodSchema: unknown;
  jsonSchema: { required?: string[]; additionalProperties?: unknown };
}): void {
  optionalDefaults(ctx);
  openObjects(ctx);
}

/**
 * An object that strips fields it doesn't know accepts them, as a newer peer within the same major
 * sends them, so its schema doesn't refuse them either. Only a strict object is closed.
 */
function openObjects(ctx: { zodSchema: unknown; jsonSchema: { additionalProperties?: unknown } }) {
  const { zodSchema, jsonSchema } = ctx;
  if (zodSchema instanceof z.ZodObject && zodSchema.def.catchall === undefined) {
    delete jsonSchema.additionalProperties;
  }
}

/**
 * A field with a default may be missing on the wire, as from a peer older than the field, so it is
 * never required. Output mode is kept otherwise: it is what a peer sends.
 */
function optionalDefaults(ctx: { zodSchema: unknown; jsonSchema: { required?: string[] } }): void {
  const { zodSchema, jsonSchema } = ctx;
  if (!(zodSchema instanceof z.ZodObject) || jsonSchema.required === undefined) return;
  const shape: Record<string, unknown> = zodSchema.shape;
  const defaulted = new Set(
    Object.entries(shape).flatMap(([key, field]) => (field instanceof z.ZodDefault ? [key] : [])),
  );
  jsonSchema.required = jsonSchema.required.filter((key) => !defaulted.has(key));
}
