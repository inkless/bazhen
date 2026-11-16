import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { newId } from "@bazhen/core";
import { launchAgent } from "../agents/launch.ts";
import { Lifecycle } from "../agents/lifecycle.ts";
import { AgentQueue } from "../agents/queue.ts";
import { MIGRATIONS } from "../store/migrations.ts";
import { Store } from "../store/store.ts";
import {
  fakeEnvironment,
  quietStartAgain,
  tempDb,
  unlimited,
  untokened,
  withAgent,
} from "../testing/fixtures.ts";
import { AgentTokens, startWithToken } from "./callers.ts";

const uid = process.getuid?.() ?? 0;

async function tokens() {
  const { path, store, agentId, environment } = await withAgent();
  const dir = join(mkdtempSync(join(tmpdir(), "bz-tokens-")), "agents");
  return { path, store, agentId, environment, dir, tokens: new AgentTokens(store, dir, uid) };
}

const tokenDir = () => join(mkdtempSync(join(tmpdir(), "bz-tokens-")), "agents");

/** A store with an agent launched at the schema before tokens, then upgraded. */
async function upgraded() {
  const path = tempDb();
  const before = Store.open(path, MIGRATIONS.slice(0, -1));
  const { agentId } = await launchAgent(
    {
      store: before,
      environment: fakeEnvironment(before),
      size: { cols: 80, rows: 24 },
      home: tmpdir(),
      queue: new AgentQueue(),
      budget: unlimited,
      tokens: untokened,
    },
    { idempotencyKey: "launch", harness: "claude-code", cwd: "~" },
  );
  before.close();
  return { store: Store.open(path), agentId };
}

const mode = (path: string) => statSync(path).mode & 0o777;
const read = (path: string) => readFileSync(path, "utf8");

describe("AgentTokens", () => {
  it("writes each token alone in a 0600 file, in a 0700 directory, and knows its agent by it", async () => {
    const { agentId, dir, tokens: t } = await tokens();
    const { file } = t.mint(agentId);
    expect([mode(dir), mode(file), t.agentOf(read(file))]).toEqual([0o700, 0o600, agentId]);
  });

  it("gives each start a file of its own, so the last start's never holds the next token", async () => {
    const { agentId, tokens: t } = await tokens();
    const first = t.mint(agentId);
    first.kept();
    const firstToken = read(first.file);
    const second = t.mint(agentId);
    expect([second.file === first.file, read(first.file) === firstToken]).toEqual([false, true]);
    expect([t.agentOf(firstToken), t.agentOf(read(second.file))]).toEqual([undefined, agentId]);
  });

  it("removes the earlier starts' files once a start goes ahead", async () => {
    const { agentId, tokens: t } = await tokens();
    const first = t.mint(agentId);
    first.kept();
    const second = t.mint(agentId);
    second.kept();
    expect([existsSync(first.file), existsSync(second.file)]).toEqual([false, true]);
  });

  it("gives the running process its token back when a start is refused", async () => {
    const { agentId, tokens: t } = await tokens();
    const running = t.mint(agentId);
    running.kept();
    const refused = t.mint(agentId);
    refused.abandoned();
    expect([t.agentOf(read(running.file)), existsSync(refused.file)]).toEqual([agentId, false]);
  });

  it("keeps an agent started before agents had tokens known by its id when its restart is refused", async () => {
    const { store, agentId } = await upgraded();
    const t = new AgentTokens(store, tokenDir(), uid);
    const start = startWithToken(t, agentId, () => Promise.reject(new Error("refused")));
    await expect(start).rejects.toThrow("refused");
    expect(t.untokened(agentId)).toBe(true);
  });

  it("knows an agent started before agents had tokens by its id no more once a start of its own goes ahead", async () => {
    const { store, agentId } = await upgraded();
    const t = new AgentTokens(store, tokenDir(), uid);
    await startWithToken(t, agentId, async () => {});
    expect(t.untokened(agentId)).toBe(false);
  });

  it("knows an agent from before agents had tokens by its id no more once it is closed", async () => {
    const { store, agentId } = await upgraded();
    const t = new AgentTokens(store, tokenDir(), uid);
    await new Lifecycle(store, fakeEnvironment(store), new AgentQueue(), quietStartAgain).close(
      agentId,
      { idempotencyKey: "close", generation: 0 },
    );
    expect(t.untokened(agentId)).toBe(false);
  });

  it("knows no agent started since agents had tokens by its id", async () => {
    const { agentId, tokens: t } = await tokens();
    expect(t.untokened(agentId)).toBe(false);
  });

  it("keeps the token of a start that goes ahead, and drops the last start's file", async () => {
    const { agentId, tokens: t } = await tokens();
    const last = t.mint(agentId);
    last.kept();
    const file = await startWithToken(t, agentId, async (tokenFile) => tokenFile);
    expect([t.agentOf(read(file)), existsSync(last.file)]).toEqual([agentId, false]);
  });

  it("keeps no token in the database, only its hash", async () => {
    const { path, store, agentId, tokens: t } = await tokens();
    const token = read(t.mint(agentId).file);
    store.close();
    expect(readFileSync(path).includes(token)).toBe(false);
  });

  it("knows no agent by a closed agent's token, and the close removes its file", async () => {
    const { store, agentId, environment, tokens: t } = await tokens();
    const { file } = t.mint(agentId);
    const token = read(file);
    const lifecycle = new Lifecycle(store, environment, new AgentQueue(), {
      ...quietStartAgain,
      tokens: t,
    });
    await lifecycle.close(agentId, { idempotencyKey: "close", generation: 0 });
    expect([t.agentOf(token), existsSync(file)]).toEqual([undefined, false]);
  });

  it("sweeps the token files of agents that ended or that it doesn't know, and nothing else", async () => {
    const { store, agentId, environment, dir, tokens: t } = await tokens();
    const live = t.mint(agentId).file;
    writeFileSync(join(dir, `${newId("agent")}.00.token`), "x");
    writeFileSync(join(dir, `${agentId}.01.token.tmp`), "x");
    writeFileSync(join(dir, "notes.txt"), "not a token");
    const { agentId: closed } = await launchAgent(
      {
        store,
        environment,
        size: { cols: 80, rows: 24 },
        home: tmpdir(),
        queue: new AgentQueue(),
        budget: unlimited,
        tokens: t,
      },
      { idempotencyKey: "second", harness: "claude-code", cwd: "~" },
    );
    // Closed as reconciliation closes one, leaving its file.
    await new Lifecycle(store, environment, new AgentQueue(), quietStartAgain).close(closed, {
      idempotencyKey: "close",
      generation: 0,
    });
    t.sweep();
    expect(readdirSync(dir).toSorted()).toEqual([basename(live), "notes.txt"].toSorted());
  });

  it("knows an agent running from before agents had tokens by its id, once upgraded", async () => {
    const { store, agentId } = await upgraded();
    expect(new AgentTokens(store, tokenDir(), uid).untokened(agentId)).toBe(true);
  });
});
