import {
  AnswerAttentionResponse,
  EventFrame,
  PROTOCOL_VERSION,
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

const MAX_RETRY_MS = 30_000;

/**
 * Hands `apply` the daemon's state, then a fresh read whenever the event stream says something
 * changed. A dropped or reset stream is reopened from the state last read, waiting longer after
 * each failure in a row. Answers a function that stops it.
 */
export function watchState(
  apply: (state: StateSnapshot) => void,
  failed: (err: unknown) => void,
): () => void {
  let stopped = false;
  let latest: StateSnapshot | undefined;
  let reading: Promise<void> | undefined;
  let again = false;
  let socket: WebSocket | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let delay = 0;

  // One read at a time; events that arrive during it are covered by one more read after it.
  const read = (): Promise<void> => {
    if (reading !== undefined) {
      again = true;
      return reading;
    }
    reading = (async () => {
      try {
        do {
          again = false;
          latest = await fetchState();
          if (!stopped) apply(latest);
        } while (again);
      } finally {
        reading = undefined;
      }
    })();
    return reading;
  };
  const retry = () => {
    if (stopped) return;
    delay = Math.min(MAX_RETRY_MS, delay * 2 || 500);
    timer = setTimeout(start, delay);
  };
  const open = () => {
    if (stopped || latest === undefined) return;
    const query = new URLSearchParams({
      v: PROTOCOL_VERSION,
      epoch: latest.epoch,
      after: String(latest.eventId),
    });
    const ws = new WebSocket(`${location.origin.replace(/^http/, "ws")}/v1/events?${query}`);
    socket = ws;
    ws.addEventListener("message", (message) => {
      const frame = EventFrame.safeParse(JSON.parse(String(message.data)));
      // A type this client doesn't know is still a change; only a reset counts as a failure.
      if (!frame.success || frame.data.type === "event") delay = 0;
      read().catch(failed);
    });
    ws.addEventListener("close", retry);
  };
  const start = () =>
    read().then(open, (err: unknown) => {
      failed(err);
      retry();
    });

  void start();
  return () => {
    stopped = true;
    clearTimeout(timer);
    socket?.close();
  };
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
