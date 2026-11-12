// A fake Anthropic Messages API for driving a real Claude Code TUI without an account.
//
// Usage:  node fake-anthropic.ts --port 0 --log <requests.jsonl> [--port-file <path>]
// Point Claude Code at it with ANTHROPIC_BASE_URL=http://127.0.0.1:<port> and any
// ANTHROPIC_API_KEY. Every request body is appended to the log, one JSON object per line.
//
// The reply is chosen by a marker in the latest user text (see `pickScript`):
//   [[fake:plain]]        a short text reply (also the default)
//   [[fake:slow:<sec>]]   a text reply streamed over <sec> seconds
//   [[fake:bash:<cmd>]]   a Bash tool call running <cmd>, then "done" after the result
//   [[fake:error:<status>]] an HTTP error response (400 invalid_request, 5xx api_error, 529 overloaded)
//   [[fake:big:<tokens>]] a text reply reporting <tokens> input tokens (drives auto-compaction)
//   [[fake:agent]]        an Agent (subagent) tool call whose prompt asks for a Bash call
//   [[fake:tools:<n>]]    <n> sequential Bash `echo` calls, one per turn step
// A request whose last user message is a tool_result continues the script that issued it.
// A compaction request (system or user text asking for a summary) gets a fixed summary.
import { appendFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "0" },
    log: { type: "string" },
    "port-file": { type: "string" },
  },
});
const logPath = values.log;

type Block = { type: string; text?: string; content?: unknown; [k: string]: unknown };
type Msg = { role: string; content: string | Block[] };
type Req = {
  model?: string;
  stream?: boolean;
  system?: string | Block[];
  messages?: Msg[];
  tools?: { name: string }[];
};

let idCounter = 0;
const nextId = (p: string) => `${p}_fake${String(++idCounter).padStart(6, "0")}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function textOf(content: string | Block[] | undefined): string {
  if (content === undefined) return "";
  if (typeof content === "string") return content;
  return content
    .map((b) => {
      if (b.type === "text") return b.text ?? "";
      if (b.type === "tool_result") {
        const c = b.content;
        return typeof c === "string" ? c : textOf(c as Block[]);
      }
      return "";
    })
    .join("\n");
}

function lastUser(req: Req): Msg | undefined {
  const msgs = req.messages ?? [];
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i]!.role === "user") return msgs[i];
  return undefined;
}

function isToolResult(m: Msg | undefined): boolean {
  return Array.isArray(m?.content) && m.content.some((b) => b.type === "tool_result");
}

/** The most recent marker in any user message, scanning newest first. */
function latestMarker(req: Req): string | undefined {
  const msgs = req.messages ?? [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]!.role !== "user") continue;
    const found = [...textOf(msgs[i]!.content).matchAll(/\[\[fake:([^\]]*)\]\]/g)];
    if (found.length > 0) return found[found.length - 1]![1];
  }
  return undefined;
}

/** How many tool_use blocks the assistant has issued since the last marker-bearing user text. */
function toolStepsSinceMarker(req: Req): number {
  const msgs = req.messages ?? [];
  let n = 0;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!;
    if (m.role === "user" && /\[\[fake:/.test(textOf(m.content)) && !isToolResult(m)) break;
    if (m.role === "assistant" && Array.isArray(m.content))
      n += m.content.filter((b) => b.type === "tool_use").length;
  }
  return n;
}

function isCompaction(req: Req): boolean {
  const sys = typeof req.system === "string" ? req.system : textOf(req.system);
  const last = textOf(lastUser(req)?.content);
  return /summar/i.test(last) && /(compact|conversation so far|detailed summary)/i.test(last + sys);
}

type Reply =
  | { kind: "text"; text: string; seconds?: number; inputTokens?: number }
  | { kind: "tool"; name: string; input: Record<string, unknown>; preface?: string }
  | { kind: "error"; status: number };

function toolName(req: Req, wanted: string[]): string {
  const names = new Set((req.tools ?? []).map((t) => t.name));
  return wanted.find((w) => names.has(w)) ?? wanted[0]!;
}

function pickScript(req: Req): Reply {
  if (isCompaction(req))
    return {
      kind: "text",
      text: "<summary>Fake compaction summary: the user ran hook probes.</summary>",
    };
  // A background subagent's completion arrives as a user turn holding <task-id>; acknowledge it
  // instead of replaying the marker that spawned the subagent.
  if (/<task-id>/.test(textOf(lastUser(req)?.content))) return { kind: "text", text: "noted" };
  const marker = latestMarker(req) ?? "plain";
  const continuing = isToolResult(lastUser(req));
  const [kind, ...rest] = marker.split(":");
  const arg = rest.join(":");
  switch (kind) {
    case "error":
      return { kind: "error", status: Number(arg) || 400 };
    case "big":
      return { kind: "text", text: "big context reply", inputTokens: Number(arg) || 190_000 };
    case "slow":
      return {
        kind: "text",
        text: "Slow reply. ".repeat(20).trim(),
        seconds: Number(arg) || 8,
      };
    case "bash":
      if (continuing) return { kind: "text", text: "done" };
      return {
        kind: "tool",
        name: "Bash",
        input: { command: arg || "echo probe", description: "probe command" },
      };
    case "tools": {
      const total = Number(arg) || 3;
      const done = toolStepsSinceMarker(req);
      if (done >= total) return { kind: "text", text: "done" };
      return {
        kind: "tool",
        name: "Bash",
        input: { command: `echo step-${done + 1}`, description: `probe step ${done + 1}` },
      };
    }
    case "agent":
      if (continuing) return { kind: "text", text: "subagent finished" };
      return {
        kind: "tool",
        name: toolName(req, ["Agent", "Task"]),
        input: {
          description: "probe subagent",
          prompt: `Run the probe. [[fake:bash:${arg || "echo from-subagent"}]]`,
          subagent_type: "general-purpose",
        },
      };
    default:
      return { kind: "text", text: continuing ? "done" : "ok" };
  }
}

function sse(res: ServerResponse, event: string, data: unknown) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function stream(res: ServerResponse, req: Req, reply: Reply) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const usage = {
    input_tokens: reply.kind === "text" && reply.inputTokens ? reply.inputTokens : 10,
    output_tokens: 1,
  };
  sse(res, "message_start", {
    type: "message_start",
    message: {
      id: nextId("msg"),
      type: "message",
      role: "assistant",
      model: req.model ?? "fake",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage,
    },
  });
  if (reply.kind === "text") {
    sse(res, "content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    });
    const words = reply.text.split(/(?<= )/);
    const delay = reply.seconds ? (reply.seconds * 1000) / words.length : 0;
    for (const w of words) {
      if (res.destroyed) return;
      sse(res, "content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: w },
      });
      if (delay) await sleep(delay);
    }
    sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
    sse(res, "message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: {
        output_tokens: words.length,
        ...(reply.inputTokens ? { input_tokens: reply.inputTokens } : {}),
      },
    });
  } else {
    sse(res, "content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: nextId("toolu"), name: reply.name, input: {} },
    });
    sse(res, "content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(reply.input) },
    });
    sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
    sse(res, "message_delta", {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 5 },
    });
  }
  sse(res, "message_stop", { type: "message_stop" });
  res.end();
}

function nonStreaming(res: ServerResponse, req: Req, reply: Reply) {
  const content =
    reply.kind === "text"
      ? [{ type: "text", text: reply.text }]
      : [{ type: "tool_use", id: nextId("toolu"), name: reply.name, input: reply.input }];
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      id: nextId("msg"),
      type: "message",
      role: "assistant",
      model: req.model ?? "fake",
      content,
      stop_reason: reply.kind === "text" ? "end_turn" : "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    }),
  );
}

function readBody(r: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let s = "";
    r.setEncoding("utf8");
    r.on("data", (c) => (s += c));
    r.on("end", () => resolve(s));
    r.on("error", reject);
  });
}

const server = createServer(async (r, res) => {
  const body = await readBody(r);
  let parsed: Req = {};
  try {
    parsed = body ? (JSON.parse(body) as Req) : {};
  } catch {}
  const path = (r.url ?? "").split("?")[0]!;
  const entry: Record<string, unknown> = {
    at: new Date().toISOString(),
    method: r.method,
    path,
  };
  if (path.endsWith("/v1/messages")) {
    const reply = pickScript(parsed);
    entry.reply = reply;
    entry.body = parsed;
    if (logPath) appendFileSync(logPath, JSON.stringify(entry) + "\n");
    if (reply.kind === "error") {
      const type = reply.status === 529 ? "overloaded_error" : reply.status >= 500 ? "api_error" : "invalid_request_error";
      res.writeHead(reply.status, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type, message: `fake ${reply.status}` } }));
      return;
    }
    if (parsed.stream) await stream(res, parsed, reply);
    else nonStreaming(res, parsed, reply);
    return;
  }
  if (path.endsWith("/v1/messages/count_tokens")) {
    if (logPath) appendFileSync(logPath, JSON.stringify(entry) + "\n");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ input_tokens: 100 }));
    return;
  }
  entry.body = body.slice(0, 2000);
  if (logPath) appendFileSync(logPath, JSON.stringify(entry) + "\n");
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: path } }));
});

server.listen(Number(values.port), "127.0.0.1", () => {
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  if (values["port-file"]) writeFileSync(values["port-file"], String(port));
  process.stdout.write(`fake-anthropic listening on http://127.0.0.1:${port}\n`);
});
