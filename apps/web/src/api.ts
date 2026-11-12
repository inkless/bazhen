import {
  AnswerAttentionResponse,
  LaunchAgentResponse,
  SendMessageResponse,
  StateSnapshot,
  type ApprovalDecision,
  type HarnessId,
} from "@bazhen/protocol";

/** The daemon's state, validated as it arrives. */
export async function fetchState(): Promise<StateSnapshot> {
  const res = await fetch("/v1/state");
  if (!res.ok) throw new Error(`daemon answered ${res.status}`);
  return StateSnapshot.parse(await res.json());
}

/** A mutation, with a fresh key per click so a retried request acts once. */
async function act(path: string, body: object): Promise<unknown> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ idempotencyKey: crypto.randomUUID(), ...body }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`refused (${res.status}): ${text}`);
  return JSON.parse(text);
}

export const launchAgent = async (harness: HarnessId, cwd: string) =>
  LaunchAgentResponse.parse(await act("/v1/agents", { harness, cwd }));

export const sendMessage = async (agentId: string, body: string) =>
  SendMessageResponse.parse(await act(`/v1/agents/${agentId}/messages`, { body }));

export const answer = async (attentionId: string, decision: ApprovalDecision) =>
  AnswerAttentionResponse.parse(await act(`/v1/attention/${attentionId}/answer`, { decision }));
