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
        `${JSON.stringify({ $id: name, ...z.toJSONSchema(schema) }, null, 2)}\n`,
      ]),
  );
}
