// Real Claude Code and Codex TUIs against local fake model APIs. HOME is never overridden (a fake
// HOME makes Claude Code's `security` calls raise keychain prompts); isolation is
// CLAUDE_CONFIG_DIR, CODEX_HOME and file credential stores only. No real credentials anywhere.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FAKES = new URL("../fakes/", import.meta.url).pathname;
const DUMMY_KEY = "sk-ant-fake-spike-0000000000000000000000";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Launch {
  argv: string[];
  env: Record<string, string>;
  cwd: string;
}

export interface TuiEnv {
  claude: Launch;
  codex: Launch;
  codexNoAlt: Launch;
  cleanup(): void;
}

async function waitFor<T>(fn: () => T | undefined, what: string): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const v = fn();
    if (v !== undefined) return v;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

export async function setupTuis(): Promise<TuiEnv> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "bz-spike-c-tui-")));
  const work = join(root, "work");
  mkdirSync(work);
  execFileSync("git", ["init", "-q"], { cwd: work });
  writeFileSync(join(work, "README.md"), "# scratch repo for the terminal fidelity spike\n");
  const procs: ChildProcess[] = [];

  const portFile = join(root, "anthropic.port");
  procs.push(
    spawn("node", ["--disable-warning=ExperimentalWarning", join(FAKES, "fake-anthropic.ts"), "--port", "0", "--log", join(root, "anthropic.jsonl"), "--port-file", portFile], { stdio: "ignore" }),
  );
  const providerLog = join(root, "provider.jsonl");
  procs.push(spawn("node", ["--disable-warning=ExperimentalWarning", join(FAKES, "fake-provider.ts"), "0", providerLog], { stdio: "ignore" }));
  const aPort = await waitFor(() => (existsSync(portFile) && readFileSync(portFile, "utf8").trim()) || undefined, "fake-anthropic port");
  const pPort = await waitFor(() => {
    if (!existsSync(providerLog)) return undefined;
    const line = readFileSync(providerLog, "utf8").split("\n").find((l) => l.includes('"listening"'));
    return line ? String(JSON.parse(line).port) : undefined;
  }, "fake-provider port");

  const claudeDir = join(root, "claude");
  mkdirSync(claudeDir);
  writeFileSync(
    join(claudeDir, ".claude.json"),
    JSON.stringify({
      hasCompletedOnboarding: true,
      lastOnboardingVersion: "2.1.322",
      theme: "dark",
      customApiKeyResponses: { approved: [DUMMY_KEY.slice(-20)], rejected: [] },
      projects: { [work]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
    }),
  );
  const codexHome = join(root, "codex");
  mkdirSync(codexHome);
  writeFileSync(
    join(codexHome, "config.toml"),
    `approvals_reviewer = "user"
model = "fake-model"
model_provider = "fake"
approval_policy = "on-request"
sandbox_mode = "read-only"
check_for_update_on_startup = false
cli_auth_credentials_store = "file"
mcp_oauth_credentials_store = "file"

[model_providers.fake]
name = "fake"
base_url = "http://127.0.0.1:${pPort}/v1"
wire_api = "responses"
env_key = "BZ_FAKE_KEY"
requires_openai_auth = false

[projects."${work}"]
trust_level = "trusted"
`,
  );

  const term = { COLORTERM: "truecolor", TMUX: "" };
  const claude: Launch = {
    argv: ["claude", "--setting-sources", "project", "--permission-mode", "default"],
    cwd: work,
    env: {
      ...term,
      CLAUDE_CONFIG_DIR: claudeDir,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${aPort}`,
      ANTHROPIC_API_KEY: DUMMY_KEY,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
    },
  };
  const codexEnv = { ...term, CODEX_HOME: codexHome, BZ_FAKE_KEY: "dummy" };
  return {
    claude,
    codex: { argv: ["codex", "--no-daemon"], cwd: work, env: codexEnv },
    codexNoAlt: { argv: ["codex", "--no-daemon", "--no-alt-screen"], cwd: work, env: codexEnv },
    cleanup() {
      for (const p of procs) p.kill();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
