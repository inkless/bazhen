import { HealthResponse } from "@bazhen/protocol";

const Spoken = HealthResponse.pick({ protocolId: true });

/**
 * Whether a `/v1/health` reply comes from a daemon speaking another protocol than `ours`. A reply
 * without one comes from a daemon of another build too.
 */
export function isAnotherBuild(health: unknown, ours: string): boolean {
  const spoken = Spoken.safeParse(health);
  return !spoken.success || spoken.data.protocolId !== ours;
}
