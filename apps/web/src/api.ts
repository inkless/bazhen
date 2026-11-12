import { LaunchAgentResponse, StateSnapshot, type HarnessId } from "@bazhen/protocol";

/** The daemon's state, validated as it arrives. */
export async function fetchState(): Promise<StateSnapshot> {
  const res = await fetch("/v1/state");
  if (!res.ok) throw new Error(`daemon answered ${res.status}`);
  return StateSnapshot.parse(await res.json());
}

/** Launches an agent; a fresh key per click, so a retried request launches once. */
export async function launchAgent(harness: HarnessId, cwd: string): Promise<LaunchAgentResponse> {
  const res = await fetch("/v1/agents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ idempotencyKey: crypto.randomUUID(), harness, cwd }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`launch refused (${res.status}): ${text}`);
  return LaunchAgentResponse.parse(JSON.parse(text));
}
