// Scripted stand-in for the Responses streaming API, so Codex turns are deterministic and free.
// Usage: node fake-provider.ts <port> <log-file>
// The reply depends on the last user message:
//   contains "RUN_CMD"  -> a shell tool call (`echo bz-spike`), which raises an approval
//   contains "LONG:<n>" -> <n> numbered markdown lines (added for Spike C)
//   contains "SLOW"     -> a plain reply streamed over ~10 s
//   anything else       -> a short plain reply echoing the message
// A request whose last input item is a tool result gets a short "tool done" reply.
import { appendFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";

function longText(n: number): string {
  // Spike C addition: numbered markdown lines with wide/combining Unicode, links and code.
  const out = ["# Long reply", "", "```ts", "const x: number = 42; // code block", "```", ""];
  for (let i = 1; i <= n; i++) out.push(`- line ${String(i).padStart(4, "0")} **bold** _it_ \`code\` 日本語 é̃ 🙂 https://example.com/${i}`);
  return out.join("\n");
}

const port = Number(process.argv[2] ?? 0);
const logFile = process.argv[3];

type InputItem = { type?: string; role?: string; content?: unknown; output?: unknown };
type Tool = { type?: string; name?: string };

function log(entry: object): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  if (logFile) appendFileSync(logFile, `${line}\n`);
  else console.log(line);
}

function textOf(item: InputItem): string {
  if (typeof item.content === "string") return item.content;
  if (Array.isArray(item.content)) {
    return item.content
      .map((part: { text?: string }) => (typeof part.text === "string" ? part.text : ""))
      .join("");
  }
  return "";
}

function send(res: ServerResponse, event: { type: string; [key: string]: unknown }): void {
  res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let seq = 0;

async function streamText(res: ServerResponse, id: string, text: string, chunkDelayMs: number) {
  const itemId = `msg_${id}`;
  send(res, {
    type: "response.output_item.added",
    output_index: 0,
    item: { type: "message", id: itemId, role: "assistant", status: "in_progress", content: [] },
  });
  for (const word of text.split(/(?<= )/)) {
    send(res, {
      type: "response.output_text.delta",
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      delta: word,
    });
    if (chunkDelayMs) await sleep(chunkDelayMs);
  }
  send(res, {
    type: "response.output_item.done",
    output_index: 0,
    item: {
      type: "message",
      id: itemId,
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text, annotations: [] }],
    },
  });
}

function toolCall(res: ServerResponse, id: string, tools: Tool[]) {
  const names = tools.map((t) => t.name ?? t.type ?? "");
  const name = ["shell_command", "shell", "exec_command"].find((n) => names.includes(n)) ?? "shell";
  // Asking for escalation makes Codex raise an approval under approval_policy = "on-request".
  const escalate = { sandbox_permissions: "require_escalated", justification: "bz spike approval probe" };
  const args =
    name === "exec_command"
      ? { cmd: "echo bz-spike", ...escalate }
      : name === "shell_command"
        ? { command: "echo bz-spike", ...escalate }
        : { command: ["bash", "-lc", "echo bz-spike"], ...escalate };
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
  return name;
}

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk: Buffer) => (body += chunk.toString()));
  req.on("end", async () => {
    if (req.method !== "POST" || !req.url?.endsWith("/responses")) {
      log({ kind: "unhandled", method: req.method, url: req.url });
      res.writeHead(404).end();
      return;
    }
    const parsed = JSON.parse(body) as { input?: InputItem[]; tools?: Tool[] };
    const input = parsed.input ?? [];
    const last = input.at(-1) ?? {};
    const lastUser = [...input].reverse().find((i) => i.role === "user");
    const userText = lastUser ? textOf(lastUser) : "";
    const id = `${Date.now()}_${++seq}`;
    const userMessages = input.filter((i) => i.role === "user").map(textOf);
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    send(res, {
      type: "response.created",
      response: { id: `resp_${id}`, object: "response", status: "in_progress" },
    });
    let reply: string;
    if (last.type === "function_call_output") {
      reply = "tool done";
      await streamText(res, id, reply, 0);
    } else if (userText.includes("RUN_CMD")) {
      reply = `tool_call:${toolCall(res, id, parsed.tools ?? [])}`;
    } else if (/LONG:(\d+)/.test(userText)) {
      reply = longText(Number(/LONG:(\d+)/.exec(userText)![1]));
      await streamText(res, id, reply, 0);
    } else if (userText.includes("SLOW")) {
      reply = "slow reply streaming one word at a time so that a second writer can land mid turn";
      await streamText(res, id, reply, 600);
    } else {
      reply = `echo: ${userText.slice(-80)}`;
      await streamText(res, id, reply, 0);
    }
    send(res, {
      type: "response.completed",
      response: {
        id: `resp_${id}`,
        object: "response",
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
    log({
      kind: "turn",
      id,
      lastType: last.type ?? last.role,
      userMessages,
      reply,
      tools: (parsed.tools ?? []).map((t) => t.name ?? t.type),
      lastItem: last.type === "function_call_output" ? last : undefined,
    });
  });
});

server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  log({ kind: "listening", port: typeof address === "object" && address ? address.port : port });
});
