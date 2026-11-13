// Gives an agent's Claude Code session a conversation to resume, for tests whose agents never
// reach a model: a transcript on disk, named by a hook of that session, as the hook client
// reports one on the daemon's Unix socket.

import { writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";

export async function giveTranscript(
  home: string,
  protocolVersion: string,
  agentId: string,
  sessionId: string,
): Promise<void> {
  const transcript = join(home, `${sessionId}.jsonl`);
  writeFileSync(transcript, "{}\n");
  const body = JSON.stringify({
    protocolVersion,
    agentId,
    event: "UserPromptSubmit",
    pid: process.pid,
    ppid: process.pid,
    payload: { session_id: sessionId, transcript_path: transcript, prompt: "", prompt_id: "p-1" },
  });
  await new Promise<void>((resolve, reject) => {
    const req = request(
      { socketPath: join(home, "run", "bazhen.sock"), method: "POST", path: "/v1/hooks" },
      (res) => res.resume().on("end", resolve),
    );
    req.on("error", reject);
    req.end(body);
  });
}
