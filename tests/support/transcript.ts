// Gives an agent's Claude Code session a conversation to resume, for tests whose agents never
// reach a model: a transcript on disk, named by a hook of that session, as the hook client
// reports one on the daemon's Unix socket, with the agent's token.

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { HOOK_PROTOCOL_VERSION } from "@bazhen/protocol";

export async function giveTranscript(
  home: string,
  agentId: string,
  sessionId: string,
): Promise<void> {
  const transcript = join(home, `${sessionId}.jsonl`);
  writeFileSync(transcript, `${JSON.stringify({ type: "user", sessionId })}\n`);
  const body = JSON.stringify({
    protocolVersion: HOOK_PROTOCOL_VERSION,
    agentId,
    event: "UserPromptSubmit",
    pid: process.pid,
    ppid: process.pid,
    payload: { session_id: sessionId, transcript_path: transcript, prompt: "", prompt_id: "p-1" },
  });
  await new Promise<void>((resolve, reject) => {
    const req = request(
      {
        socketPath: join(home, "run", "bazhen.sock"),
        method: "POST",
        path: "/v1/hooks",
        headers: { "bazhen-agent-token": agentToken(home, agentId) },
      },
      (res) => res.resume().on("end", resolve),
    );
    req.on("error", reject);
    req.end(body);
  });
}

/** The token of the agent's latest start, as its environment's file holds it. */
function agentToken(home: string, agentId: string): string {
  const dir = join(home, "run", "agents");
  const files = readdirSync(dir)
    .filter((name) => name.startsWith(`${agentId}.`) && name.endsWith(".token"))
    .map((name) => join(dir, name));
  const latest = files.toSorted((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  if (latest === undefined) throw new Error(`no token file for ${agentId} in ${dir}`);
  return readFileSync(latest, "utf8");
}
