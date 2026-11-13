// A stand-in for the OpenAI Responses API, so the real Codex TUI can take turns in tests without
// an account. The reply is picked by the latest user text:
//   [[fake:shell:<command>]]  a shell call running <command> outside the sandbox, then "done"
//   [[fake:slow:<ms>]]        the reply, sent <ms> milliseconds late
//   [[fake:ask]]              a request_user_input call: one question, two choices, then "done"
//   anything else             a short text reply echoing it
// Every request is kept, so a test can check what the model was sent.

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

/** One response's stream around the items `emit` writes, the shape Codex reads from a provider. */
function respond(res: ServerResponse, emit: (id: string) => void): void {
  const id = `fake${++ids}`;
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  send(res, { type: "response.created", response: { id: `resp_${id}`, status: "in_progress" } });
  emit(id);
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

const message = (res: ServerResponse, text: string) =>
  respond(res, (id) => {
    const item = { type: "message", id: `msg_${id}`, role: "assistant" };
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
  });

/** How each of Codex's shell tools takes its command, in the order the fake prefers them. */
const SHELL_ARGS = {
  shell_command: (command: string) => ({ command }),
  exec_command: (command: string) => ({ cmd: command }),
  shell: (command: string) => ({ command: ["bash", "-lc", command] }),
};
const SHELL_TOOLS = ["shell_command", "exec_command", "shell"] as const;

/**
 * A call to whichever shell tool Codex offered, asking to run `command` outside the sandbox,
 * which under `approval_policy = "on-request"` raises an approval request.
 */
const shellCall = (res: ServerResponse, tools: unknown, command: string) =>
  respond(res, (id) => {
    const offered = (Array.isArray(tools) ? tools : []).map(
      (t) => field(t, "name") ?? field(t, "type"),
    );
    const name = SHELL_TOOLS.find((n) => offered.includes(n)) ?? "shell";
    const args = {
      ...SHELL_ARGS[name](command),
      sandbox_permissions: "require_escalated",
      justification: "the test asks",
    };
    const item = {
      type: "function_call",
      id: `fc_${id}`,
      call_id: `call_${id}`,
      name,
      arguments: JSON.stringify(args),
      status: "completed",
    };
    send(res, { type: "response.output_item.added", output_index: 0, item });
    send(res, { type: "response.output_item.done", output_index: 0, item });
  });

/** The question `[[fake:ask]]` asks. */
export const FAKE_CODEX_QUESTION = "Which branch should it work on?";

/** A request_user_input call, Codex's tool for asking the human, with one question. */
const askCall = (res: ServerResponse) =>
  respond(res, (id) => {
    const question = {
      id: "branch",
      header: "Branch",
      question: FAKE_CODEX_QUESTION,
      options: [
        { label: "main (Recommended)", description: "The default branch" },
        { label: "dev", description: "Work in progress" },
      ],
    };
    const item = {
      type: "function_call",
      id: `fc_${id}`,
      call_id: `call_${id}`,
      name: "request_user_input",
      arguments: JSON.stringify({ questions: [question] }),
      status: "completed",
    };
    send(res, { type: "response.output_item.added", output_index: 0, item });
    send(res, { type: "response.output_item.done", output_index: 0, item });
  });

export async function startFakeResponses(): Promise<FakeModel> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    void body(req).then((text) => {
      if (req.method !== "POST" || !(req.url ?? "").endsWith("/responses")) {
        res.writeHead(404).end();
        return;
      }
      requests.push(text);
      const request: unknown = JSON.parse(text);
      const input = field(request, "input");
      const items = Array.isArray(input) ? input : [];
      const user = textOf(items.filter((i) => field(i, "role") === "user").at(-1));
      const shell = /\[\[fake:shell:([^\]]+)\]\]/.exec(user)?.[1];
      const slow = Number(/\[\[fake:slow:(\d+)\]\]/.exec(user)?.[1] ?? 0);
      setTimeout(() => {
        if (field(items.at(-1), "type") === "function_call_output") message(res, "done");
        else if (shell !== undefined) shellCall(res, field(request, "tools"), shell);
        else if (user.includes("[[fake:ask]]")) askCall(res);
        else message(res, `echo: ${user.slice(-80)}`);
      }, slow);
    });
  });
  return listenLocal(server, requests);
}
