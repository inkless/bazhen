// Smoke test: one plain turn against the fake, every hook recorded, isolation proven.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { recordingHooks, Run, sleep } from "./env.ts";

const run = new Run("smoke");
let ok = false;
try {
  await run.startFake();
  run.writeSettings(recordingHooks());
  run.launch("a", []);
  await run.waitEvent("SessionStart", 0, 30_000);
  await sleep(1500);
  console.log("--- screen after start ---\n" + run.capture("a"));
  await run.type("a", "hello [[fake:plain]]");
  const stop = await run.waitEvent("Stop", 0, 30_000);
  console.log("--- screen after turn ---\n" + run.capture("a"));
  const sessionId = String(stop.payload.session_id);

  // Isolation: the transcript is under the temp config dir, and nothing names this session
  // in the user's own Claude Code projects or triage state.
  const tempProjects = join(run.config, "projects");
  const inTemp = existsSync(tempProjects)
    ? readdirSync(tempProjects, { recursive: true }).filter((f) => String(f).includes(sessionId))
    : [];
  const grep = (dir: string) => {
    if (!existsSync(dir)) return "";
    try {
      return execFileSync("grep", ["-rl", sessionId, dir], { encoding: "utf8" });
    } catch {
      return "";
    }
  };
  const userHits = grep(join(homedir(), ".claude", "projects")) + grep(join(homedir(), ".local", "state", "triage"));
  const userProjectDir = readdirSync(join(homedir(), ".claude", "projects")).filter((d) => d.includes(run.id));
  console.log(JSON.stringify({ sessionId, transcriptInTemp: inTemp, userHits, userProjectDir }, null, 2));
  console.log(
    "events:",
    run
      .hooks()
      .map((h) => h.event)
      .join(" "),
  );
  console.log("requests:", run.requests().map((r) => `${r.method} ${r.path}`).join(", "));
  ok = inTemp.length > 0 && userHits === "" && userProjectDir.length === 0;
  run.keys("a", "C-d");
  await sleep(500);
  run.keys("a", "C-d");
  await run.waitEvent("SessionEnd", 0, 10_000).catch(() => console.log("no SessionEnd seen"));
} finally {
  const res = await run.cleanup();
  console.log(JSON.stringify({ isolationOk: ok, ...res, dir: run.dir }, null, 2));
}
