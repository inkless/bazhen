import {
  AgentCommandResponse,
  AssignTaskResponse,
  CreateTaskResponse,
  TaskCommandResponse,
  TaskDetail,
  type Role,
  type TaskOutcome,
  AnswerAttentionResponse,
  DismissAttentionResponse,
  ErrorResponse,
  ReplyAttentionResponse,
  ResendAttentionResponse,
  EventFrame,
  LaunchAgentResponse,
  PROTOCOL_VERSION,
  VISIBILITY_HEARTBEAT_MS,
  type ClientEventFrame,
  SendMessageResponse,
  StateSnapshot,
  type ApprovalDecision,
  type HarnessId,
  type Signal,
  type TuiTheme,
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
  let reading: Promise<StateSnapshot> | undefined;
  let again = false;
  let socket: WebSocket | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let delay = 0;

  // One read at a time; events that arrive during it are covered by one more read after it.
  const read = (): Promise<StateSnapshot> => {
    if (reading !== undefined) {
      again = true;
      return reading;
    }
    reading = (async () => {
      try {
        let latest: StateSnapshot;
        do {
          again = false;
          latest = await fetchState();
          if (!stopped) apply(latest);
        } while (again);
        return latest;
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
  const open = (latest: StateSnapshot) => {
    if (stopped) return;
    const query = new URLSearchParams({
      v: PROTOCOL_VERSION,
      epoch: latest.epoch,
      after: String(latest.eventId),
    });
    const ws = new WebSocket(`${location.origin.replace(/^http/, "ws")}/v1/events?${query}`);
    socket = ws;
    let state: "connecting" | "open" | "reset" = "connecting";
    // Whether this page is in sight, so the host's desktop notifications wait while it is.
    const sendVisibility = () => {
      const frame: ClientEventFrame = {
        type: "visibility",
        visible: document.visibilityState === "visible",
      };
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
    };
    const heartbeat = setInterval(() => {
      if (document.visibilityState === "visible") sendVisibility();
    }, VISIBILITY_HEARTBEAT_MS);
    document.addEventListener("visibilitychange", sendVisibility);
    ws.addEventListener("open", () => {
      state = "open";
      sendVisibility();
    });
    ws.addEventListener("message", (message) => {
      const frame = EventFrame.safeParse(JSON.parse(String(message.data)));
      // The close that follows a reset reads the state again. Anything else is a change, an event
      // type this client doesn't know included.
      if (frame.success && frame.data.type === "reset") state = "reset";
      else read().catch(failed);
    });
    ws.addEventListener("close", () => {
      clearInterval(heartbeat);
      document.removeEventListener("visibilitychange", sendVisibility);
      // A stream that was healthy, as before a daemon restart, reconnects at once. A browser
      // isn't told why an upgrade was refused, so a refusal is shown rather than retried unseen.
      if (state === "open") delay = 0;
      if (state === "connecting") failed(new Error("the daemon refused the event stream"));
      retry();
    });
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
  if (!res.ok) throw refusal(res.status, text);
  return JSON.parse(text);
}

/** A request the daemon refused, with its code where it gave one. */
export class Refused extends Error {
  readonly code: ErrorResponse["error"] | null;

  constructor(code: ErrorResponse["error"] | null, message: string) {
    super(message);
    this.code = code;
  }
}

/** What the daemon said when it refused, in its own words, or the status if it said nothing. */
function refusal(status: number, text: string): Refused {
  try {
    const { error, message } = ErrorResponse.parse(JSON.parse(text));
    return new Refused(error, message);
  } catch {
    return new Refused(null, `the daemon refused the request (${status})`);
  }
}

/** `theme` is the background the agent's terminal shows, which its TUI is started for. */
export const launchAgent = async (harness: HarnessId, cwd: string, theme: TuiTheme) =>
  LaunchAgentResponse.parse(await act("/v1/agents", { harness, cwd, theme }));

export const sendMessage = async (agentId: string, body: string) =>
  SendMessageResponse.parse(await act(`/v1/agents/${agentId}/messages`, { body }));

export const answer = async (attentionId: string, decision: ApprovalDecision) =>
  AnswerAttentionResponse.parse(await act(`/v1/attention/${attentionId}/answer`, { decision }));

/** A reply to an item: its question's answer, or mail to its agent. */
export const reply = async (attentionId: string, body: string) =>
  ReplyAttentionResponse.parse(await act(`/v1/attention/${attentionId}/reply`, { body }));

/** Sends an undelivered message's own text again, as a new message. */
export const resend = async (attentionId: string) =>
  ResendAttentionResponse.parse(await act(`/v1/attention/${attentionId}/resend`, {}));

export const dismiss = async (attentionId: string) =>
  DismissAttentionResponse.parse(await act(`/v1/attention/${attentionId}/dismiss`, {}));

/** Names the generation the UI saw, so a command meant for an earlier incarnation is refused. */
export const closeAgent = async (agentId: string, generation: number) =>
  AgentCommandResponse.parse(await act(`/v1/agents/${agentId}/close`, { generation }));

/** Signals a running agent's process, at the generation the UI saw. */
export const signalAgent = async (agentId: string, generation: number, signal: Signal) =>
  AgentCommandResponse.parse(await act(`/v1/agents/${agentId}/signal`, { generation, signal }));

/** Records a closing agent closed without ending anything, once a close came back unconfirmed. */
export const forceCloseAgent = async (agentId: string, generation: number) =>
  AgentCommandResponse.parse(await act(`/v1/agents/${agentId}/close`, { generation, force: true }));

export const respawnAgent = async (agentId: string, generation: number, theme: TuiTheme) =>
  AgentCommandResponse.parse(await act(`/v1/agents/${agentId}/respawn`, { generation, theme }));

/** A new task for the human; assigning it in the same request mails the agent its brief. */
export const createTask = async (
  title: string,
  brief: string,
  assign?: { agentId: string; role: Role },
) =>
  CreateTaskResponse.parse(
    await act("/v1/tasks", { title, brief, ...(assign === undefined ? {} : { assign }) }),
  );

/** A task in full: its brief, note, every assignment it has had, and its subtasks. */
export async function fetchTask(taskId: string): Promise<TaskDetail> {
  const res = await fetch(`/v1/tasks/${encodeURIComponent(taskId)}`);
  const text = await res.text();
  if (!res.ok) throw refusal(res.status, text);
  return TaskDetail.parse(JSON.parse(text));
}

export const assignTask = async (taskId: string, agentId: string, role: Role) =>
  AssignTaskResponse.parse(
    await act(`/v1/tasks/${encodeURIComponent(taskId)}/assign`, { agentId, role }),
  );

export const unassignTask = async (taskId: string, assignmentId: string) =>
  TaskCommandResponse.parse(
    await act(`/v1/tasks/${encodeURIComponent(taskId)}/unassign`, { assignmentId }),
  );

/** Marks the task done or cancelled; `cascade` cancels its open subtasks with it. */
export const finishTask = async (taskId: string, outcome: TaskOutcome, cascade: boolean) =>
  TaskCommandResponse.parse(
    await act(`/v1/tasks/${encodeURIComponent(taskId)}/finish`, {
      outcome,
      ...(cascade ? { cascade } : {}),
    }),
  );
