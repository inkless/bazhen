// A stand-in for the Anthropic Messages API, so the real Claude Code TUI can take turns in tests
// without an account. Each reply is picked by a marker in the latest user text:
//   [[fake:bash:<command>]]  a Bash tool call running <command>, then "done" once it has run
//   [[fake:slow:<ms>]]       a short text reply, sent <ms> milliseconds late
//   [[fake:error]]           an API error Claude Code doesn't retry, ending the turn in StopFailure
//   anything else            a short text reply
// Every request is kept, so a test can check what the model was sent.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

interface Block {
  readonly type: string;
  readonly text?: string;
  readonly content?: unknown;
}
interface Turn {
  readonly role: string;
  readonly content: string | Block[];
}
interface Request {
  readonly model?: string;
  readonly stream?: boolean;
  readonly messages?: Turn[];
}

export interface FakeModel {
  readonly url: string;
  /** Every Messages request, with its body as JSON text. */
  readonly requests: string[];
  close(): Promise<void>;
}

const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .map((b: Block) => (b.type === "text" ? (b.text ?? "") : textOf(b.content)))
          .join("\n")
      : "";

/** The reply to a request: a Bash call for a fresh `bash` marker, otherwise text. */
function reply(req: Request): { tool?: { command: string }; text: string } {
  const users = (req.messages ?? []).filter((m) => m.role === "user");
  const last = users.at(-1);
  const continuing =
    Array.isArray(last?.content) && last.content.some((b) => b.type === "tool_result");
  const marker = [
    ...users
      .map((m) => textOf(m.content))
      .join("\n")
      .matchAll(/\[\[fake:bash:([^\]]+)\]\]/g),
  ].at(-1);
  if (marker !== undefined && !continuing && textOf(last?.content).includes(marker[0])) {
    return { tool: { command: marker[1] ?? "true" }, text: "" };
  }
  return { text: continuing ? "done" : "ok" };
}

let ids = 0;
const nextId = (prefix: string) => `${prefix}_fake${String(++ids).padStart(6, "0")}`;

function stream(res: ServerResponse, req: Request, answer: ReturnType<typeof reply>): void {
  const event = (name: string, data: unknown) =>
    res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  event("message_start", {
    type: "message_start",
    message: {
      id: nextId("msg"),
      type: "message",
      role: "assistant",
      model: req.model ?? "fake",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 1 },
    },
  });
  const block = answer.tool
    ? { type: "tool_use", id: nextId("toolu"), name: "Bash", input: {} }
    : { type: "text", text: "" };
  event("content_block_start", { type: "content_block_start", index: 0, content_block: block });
  event("content_block_delta", {
    type: "content_block_delta",
    index: 0,
    delta: answer.tool
      ? {
          type: "input_json_delta",
          partial_json: JSON.stringify({
            command: answer.tool.command,
            description: "test command",
          }),
        }
      : { type: "text_delta", text: answer.text },
  });
  event("content_block_stop", { type: "content_block_stop", index: 0 });
  event("message_delta", {
    type: "message_delta",
    delta: { stop_reason: answer.tool ? "tool_use" : "end_turn", stop_sequence: null },
    usage: { output_tokens: 5 },
  });
  event("message_stop", { type: "message_stop" });
  res.end();
}

export async function body(r: IncomingMessage): Promise<string> {
  let text = "";
  for await (const chunk of r) text += String(chunk);
  return text;
}

/** Answers a request with `answer`, streamed if it asked for a stream. */
function respond(res: ServerResponse, req: Request, answer: ReturnType<typeof reply>): void {
  if (req.stream) return stream(res, req, answer);
  const content = answer.tool
    ? [
        {
          type: "tool_use",
          id: nextId("toolu"),
          name: "Bash",
          input: { command: answer.tool.command },
        },
      ]
    : [{ type: "text", text: answer.text }];
  res.writeHead(200, { "content-type": "application/json" }).end(
    JSON.stringify({
      id: nextId("msg"),
      type: "message",
      role: "assistant",
      model: req.model ?? "fake",
      content,
      stop_reason: answer.tool ? "tool_use" : "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    }),
  );
}

/** How late to answer: a fresh `slow` marker in the latest user text delays the reply. */
function delayOf(req: Request): number {
  const last = (req.messages ?? []).filter((m) => m.role === "user").at(-1);
  return Number(/\[\[fake:slow:(\d+)\]\]/.exec(textOf(last?.content))?.[1] ?? 0);
}

/** Whether a fresh `error` marker in the latest user text asks for an API error. */
function failsOn(req: Request): boolean {
  const last = (req.messages ?? []).filter((m) => m.role === "user").at(-1);
  return textOf(last?.content).includes("[[fake:error]]");
}

export async function startFakeModel(): Promise<FakeModel> {
  const requests: string[] = [];
  const server = createServer((r, res) => {
    void body(r).then((text) => {
      const path = (r.url ?? "").split("?")[0] ?? "";
      if (path.endsWith("/v1/messages/count_tokens")) {
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ input_tokens: 100 }));
        return;
      }
      if (!path.endsWith("/v1/messages")) {
        res.writeHead(404, { "content-type": "application/json" }).end("{}");
        return;
      }
      requests.push(text);
      const req: Request = text === "" ? {} : JSON.parse(text);
      if (failsOn(req)) {
        res.writeHead(400, { "content-type": "application/json" }).end(
          JSON.stringify({
            type: "error",
            error: { type: "invalid_request_error", message: "fake error" },
          }),
        );
        return;
      }
      const answer = reply(req);
      setTimeout(() => respond(res, req, answer), delayOf(req));
    });
  });
  return listenLocal(server, requests);
}

/** Starts a fake on a free loopback port, keeping the requests it records. */
export async function listenLocal(server: Server, requests: string[]): Promise<FakeModel> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
