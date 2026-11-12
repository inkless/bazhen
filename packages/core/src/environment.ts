import type { EnvironmentId } from "./ids.ts";

/** Where agents run (foundation-design §3). One `local` environment exists from the first run. */
export interface Environment {
  readonly id: EnvironmentId;
  readonly kind: "local" | "opencode-server";
}
