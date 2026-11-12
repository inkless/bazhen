// A stand-in for the OpenAI Responses API, so the real Codex TUI can take turns in tests without
// an account. Every turn gets a short text reply echoing the latest user text. Every request is
// kept, so a test can check what the model was sent.

import { createServer, type ServerResponse } from "node:http";
import { body, listenLocal, type FakeModel } from "./fake-model.ts";

const field = (value: unknown, name: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined;

/** An input item's text, whether its content is a string or a list of parts. */
function textOf(item: unknown): string {
  const content = field(item, "content");
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => field(part, "text"))
    .filter((text) => typeof text === "string")
    .join("");
}

function send(res: ServerResponse, event: { type: string; [key: string]: unknown }): void {
  res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

let ids = 0;

/** Streams one assistant message, the shape Codex reads from a Responses provider. */
function reply(res: ServerResponse, text: string): void {
  const id = `fake${++ids}`;
  const item = { type: "message", id: `msg_${id}`, role: "assistant" };
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  send(res, { type: "response.created", response: { id: `resp_${id}`, status: "in_progress" } });
  send(res, {
    type: "response.output_item.added",
    output_index: 0,
    item: { ...item, status: "in_progress", content: [] },
  });
  send(res, {
    type: "response.output_text.delta",
    item_id: item.id,
    output_index: 0,
    content_index: 0,
    delta: text,
  });
  send(res, {
    type: "response.output_item.done",
    output_index: 0,
    item: {
      ...item,
      status: "completed",
      content: [{ type: "output_text", text, annotations: [] }],
    },
  });
  send(res, {
    type: "response.completed",
    response: {
      id: `resp_${id}`,
      status: "completed",
      usage: {
        input_tokens: 10,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 5,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 15,
      },
    },
  });
  res.end();
}

export async function startFakeResponses(): Promise<FakeModel> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    void body(req).then((text) => {
      if (req.method !== "POST" || !(req.url ?? "").endsWith("/responses")) {
        res.writeHead(404).end();
        return;
      }
      requests.push(text);
      const input = field(JSON.parse(text), "input");
      const user = (Array.isArray(input) ? input : [])
        .filter((i) => field(i, "role") === "user")
        .at(-1);
      reply(res, `echo: ${textOf(user).slice(-80)}`);
    });
  });
  return listenLocal(server, requests);
}
