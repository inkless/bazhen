// The hook client: `node hook-client.ts <event>`, which a harness runs for each of Bazhen's
// hooks (foundation-design §5.6). It holds no logic and knows no harness format: it forwards the
// hook's input over the daemon's socket and prints the reply verbatim. Outside a Bazhen agent,
// or with the daemon unreachable, it exits 0 at once, so the harness carries on as without
// Bazhen and a permission request falls through to the harness's own prompt.

import { request } from "node:http";
import { HookReply, PROTOCOL_VERSION } from "@bazhen/protocol";

const agentId = process.env["BAZHEN_AGENT_ID"];
const socketPath = process.env["BAZHEN_SOCKET"];
const event = process.argv[2];

/** The waiter outlives a daemon restart by reconnecting, and gives up before its hook's timeout. */
const WAIT_FOR_MS = 23 * 3600_000;
/** Only a backstop: the harness's own timeout for each hook, set at launch, ends it first. */
const HOOK_DEADLINE_MS = 10 * 60_000;

function post(path: string, body: unknown, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = request(
      { socketPath, path, method: "POST", headers: { "content-type": "application/json" } },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (text += chunk));
        res.on("end", () => {
          // A reply that isn't the daemon's JSON is a failure like any other: the hook fails open.
          try {
            resolve(JSON.parse(text));
          } catch (err) {
            reject(err);
          }
        });
        res.on("error", reject);
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error("deadline")));
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

async function readStdin(): Promise<unknown> {
  let text = "";
  for await (const chunk of process.stdin) text += String(chunk);
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function ask(envelope: unknown): Promise<HookReply | null> {
  if (event !== "wait") {
    return post("/v1/hooks", envelope, HOOK_DEADLINE_MS).then(
      (r) => HookReply.parse(r),
      () => null,
    );
  }
  for (const deadline = Date.now() + WAIT_FOR_MS; Date.now() < deadline;) {
    try {
      return HookReply.parse(await post("/v1/hooks", envelope, deadline - Date.now()));
    } catch {
      // The daemon is restarting or gone: try again, as the waiter must still hand out mail.
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  return null;
}

if (agentId === undefined || socketPath === undefined || event === undefined) process.exit(0);
const reply = await ask({
  protocolVersion: PROTOCOL_VERSION,
  agentId,
  event,
  pid: process.pid,
  ppid: process.ppid,
  payload: await readStdin(),
});
if (reply === null) process.exit(0);
process.stdout.write(reply.stdout);
process.stderr.write(reply.stderr);
if (reply.offered.length > 0) {
  await post("/v1/hooks/ack", { agentId, offered: reply.offered }, 5000).catch(() => undefined);
}
process.exit(reply.exitCode);
