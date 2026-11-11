// Whether a script was run directly rather than imported. `import.meta.main` exists only from
// Node 24.2, so earlier 24.x releases compare the entry point with the module's own path.

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function isMain(
  meta: { main?: boolean; url: string },
  entry: string | undefined = process.argv[1],
): boolean {
  return meta.main ?? (entry !== undefined && realpathSync(entry) === fileURLToPath(meta.url));
}
