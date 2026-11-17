import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AgentCommandResponse,
  AssignTaskResponse,
  BroadcastMessageResponse,
  CreateTaskResponse,
  EscalateResponse,
  RolesResponse,
  TaskCommandResponse,
  TaskDetail,
  DevicesResponse,
  DismissNoticeResponse,
  DoctorResponse,
  EnvRefreshResponse,
  HealthResponse,
  PairingCodeResponse,
  RevokeDeviceResponse,
  SendMessageResponse,
  StateSnapshot,
  StopResponse,
  WaitMessagesResponse,
} from "@bazhen/protocol";
import { FakeDaemon, type Scene, scene } from "./cli.ts";
import {
  AGENT,
  ANOTHER_BUILD,
  MSG,
  OTHER,
  TASK,
  agent,
  assigned,
  detail,
  doctor,
  health,
  snapshot,
  task,
} from "./fixtures.ts";

let s: Scene;
beforeEach(async () => {
  s = await scene();
});
afterEach(async () => {
  await s.cleanup();
});

const NOT_RUNNING = "bazhen is not running; start it with `bazhen start`\n";

describe("the command line", () => {
  it("prints the usage of every verb and exits 2 with no verb, or one it doesn't know", async () => {
    const runs = await Promise.all([s.bazhen([]), s.bazhen(["frobnicate"])]);
    expect(runs.map((r) => [r.code, r.stdout])).toEqual([
      [2, ""],
      [2, ""],
    ]);
    expect(runs[0]?.stderr.split("\n")).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^usage: bazhen <start\|stop\|status\|doctor\|env refresh\|pair\|/),
        "  bazhen agents [--json]",
        "  bazhen task create --title <title> (--brief <text> | --brief-file <path>) [--parent <task>] [--assign <agent> [--role <role>]]",
        "  bazhen send (<agent> | --task <task>) (<text> | --file <path>) [--wait [--timeout <seconds>]]",
      ]),
    );
    expect(runs[1]?.stderr).toBe(runs[0]?.stderr);
    expect(s.daemon.received).toEqual([]);
  });

  it("refuses a task verb it doesn't know", async () => {
    const ran = await s.bazhen(["task", "frobnicate"]);
    expect(ran).toEqual({
      code: 2,
      stdout: "",
      stderr: expect.stringContaining("unknown task verb frobnicate"),
    });
  });
});

describe("a daemon that isn't running", () => {
  it("exits 3, saying how to start it, for a read and for a command", async () => {
    await s.daemon.close();
    const runs = await Promise.all([
      s.bazhen(["status"]),
      s.bazhen(["task", "list"]),
      s.bazhen(["pair"]),
    ]);
    expect(runs).toEqual(
      Array.from({ length: 3 }, () => ({ code: 3, stdout: "", stderr: NOT_RUNNING })),
    );
  });

  it("exits 3 when it holds a read past five seconds, as one wedged does", async () => {
    s.daemon.hang("GET /v1/state");
    const begun = Date.now();
    const ran = await s.bazhen(["task", "list", "--all"]);
    expect(ran).toEqual({ code: 3, stdout: "", stderr: NOT_RUNNING });
    expect(Date.now() - begun).toBeGreaterThanOrEqual(4500);
  });
});

describe("a daemon that refuses", () => {
  it("exits 1 on a refused read, saying the path, the status and what the daemon said", async () => {
    const body = { error: "not_found" as const, message: "no task" };
    s.daemon.fail(`GET /v1/tasks/${TASK}`, 404, body);
    const ran = await s.bazhen(["task", "show", TASK]);
    expect(ran).toEqual({
      code: 1,
      stdout: "",
      stderr: `/v1/tasks/${TASK}: HTTP 404: ${JSON.stringify(body)}\n`,
    });
  });

  it("exits 1 on a refused command, and on one a caller inside an agent may not run", async () => {
    const conflict = { error: "conflict" as const, message: "the task is done" };
    const forbidden = { error: "forbidden" as const, message: "an agent can't pair a device" };
    s.daemon
      .fail(`POST /v1/tasks/${TASK}/assign`, 409, conflict)
      .fail("POST /v1/pairing/codes", 403, forbidden);
    const assign = await s.bazhen(["task", "assign", TASK, OTHER]);
    const pair = await s.bazhen(["pair"], { BAZHEN_AGENT_ID: AGENT });
    expect([assign, pair]).toEqual([
      {
        code: 1,
        stdout: "",
        stderr: `/v1/tasks/${TASK}/assign: HTTP 409: ${JSON.stringify(conflict)}\n`,
      },
      {
        code: 1,
        stdout: "",
        stderr: `/v1/pairing/codes: HTTP 403: ${JSON.stringify(forbidden)}\n`,
      },
    ]);
  });

  it("exits 1 on a route the daemon doesn't have, which it answers in plain text", async () => {
    const ran = await s.bazhen(["roles"]);
    expect(ran).toEqual({ code: 1, stdout: "", stderr: "/v1/roles: HTTP 404: 404 Not Found\n" });
  });

  it("exits 1 on an answer this CLI can't read, as from a daemon of another build", async () => {
    const body = JSON.stringify({ agents: "not a list" });
    s.daemon.raw("GET /v1/state", 200, body);
    const ran = await s.bazhen(["agents"]);
    expect(ran).toEqual({
      code: 1,
      stdout: "",
      stderr: `/v1/state: HTTP 200: ${body}\n${ANOTHER_BUILD}\n`,
    });
  });
});

const state = () => s.daemon.answer("GET /v1/state", StateSnapshot, snapshot());

describe("the daemon a task verb reaches", () => {
  it("is the one whose socket started its caller, over BAZHEN_HOME and --home", async () => {
    const elsewhere = join(s.dir, "agent-run");
    mkdirSync(elsewhere);
    const theirs = await FakeDaemon.listen(join(elsewhere, "bazhen.sock"));
    try {
      theirs.answer("GET /v1/state", StateSnapshot, snapshot());
      state();
      const socket = { BAZHEN_SOCKET: join(elsewhere, "bazhen.sock") };
      const byEnv = await s.bazhen(["task", "list", "--all"], socket);
      const byFlag = await s.bazhen(["task", "list", "--all", "--home", s.home], socket);
      expect([byEnv.code, byFlag.code, theirs.routes(), s.daemon.routes()]).toEqual([
        0,
        0,
        ["GET /v1/state", "GET /v1/state"],
        [],
      ]);
    } finally {
      await theirs.close();
    }
  });

  it("is not running when nothing answers on its caller's socket, though the home's daemon does", async () => {
    state();
    const ran = await s.bazhen(["task", "list"], { BAZHEN_SOCKET: join(s.dir, "gone.sock") });
    expect([ran, s.daemon.received]).toEqual([{ code: 3, stdout: "", stderr: NOT_RUNNING }, []]);
  });

  it("is the one the home names when BAZHEN_SOCKET is empty", async () => {
    state();
    const ran = await s.bazhen(["task", "list", "--all"], { BAZHEN_SOCKET: "" });
    expect([ran.code, s.daemon.routes()]).toEqual([0, ["GET /v1/state"]]);
  });
});

describe("the daemon any verb reaches", () => {
  it("is always the home's for a daemon verb, whatever BAZHEN_SOCKET says", async () => {
    state().answer("GET /v1/health", HealthResponse, health());
    const ran = await s.bazhen(["status"], { BAZHEN_SOCKET: join(s.dir, "nothing.sock") });
    expect([ran.code, s.daemon.routes().toSorted()]).toEqual([
      0,
      ["GET /v1/health", "GET /v1/state"],
    ]);
  });

  it("is under --home over BAZHEN_HOME, and under a home given with a trailing slash", async () => {
    state();
    const flag = await s.bazhen(["task", "list", "--all", "--home", s.home], {
      BAZHEN_HOME: join(s.dir, "other"),
    });
    const slash = await s.bazhen(["task", "list", "--all"], { BAZHEN_HOME: `${s.home}/` });
    expect([flag.code, slash.code, s.daemon.routes()]).toEqual([
      0,
      0,
      ["GET /v1/state", "GET /v1/state"],
    ]);
  });

  it("refuses a home that isn't an absolute path, reaching no daemon", async () => {
    const ran = await s.bazhen(["task", "list", "--home", "relative/home"]);
    expect([ran.code, ran.stdout, ran.stderr]).toEqual([
      1,
      "",
      expect.stringContaining("absolute path"),
    ]);
    expect(s.daemon.received).toEqual([]);
  });

  it("is under XDG_RUNTIME_DIR with no home given", async () => {
    const runtime = join(s.root, "xdg");
    mkdirSync(join(runtime, "bazhen"), { recursive: true });
    const theirs = await FakeDaemon.listen(join(runtime, "bazhen", "bazhen.sock"));
    try {
      theirs.answer("GET /v1/state", StateSnapshot, snapshot());
      const ran = await s.bare(["task", "list", "--all"], { XDG_RUNTIME_DIR: runtime });
      expect([ran.code, theirs.routes()]).toEqual([0, ["GET /v1/state"]]);
    } finally {
      await theirs.close();
    }
  });

  it("is in a short directory of its own under /tmp when the home's socket path would be too long", async () => {
    const home = join(s.root, "h".repeat(100));
    const hash = createHash("sha256").update(join(home, "run")).digest("hex").slice(0, 8);
    const run = `/tmp/bazhen-${userInfo().uid}-${hash}`;
    mkdirSync(run, { mode: 0o700 });
    try {
      const theirs = await FakeDaemon.listen(join(run, "bazhen.sock"));
      theirs.answer("GET /v1/state", StateSnapshot, snapshot());
      const ran = await s.bazhen(["task", "list", "--all"], { BAZHEN_HOME: home });
      await theirs.close();
      expect([ran.code, theirs.routes()]).toEqual([0, ["GET /v1/state"]]);
    } finally {
      rmSync(run, { recursive: true, force: true });
    }
  });

  it("is /tmp/bazhen-<uid>'s with no home and no absolute XDG_RUNTIME_DIR", async ({ skip }) => {
    const socket = `/tmp/bazhen-${userInfo().uid}/bazhen.sock`;
    skip(existsSync(socket), `a daemon may be listening on ${socket}`);
    const ran = await s.bare(["doctor"], { XDG_RUNTIME_DIR: "relative/is/ignored" });
    expect([ran.code, ran.stdout]).toEqual([1, `daemon: not running (no answer on ${socket})\n`]);
  });
});

const TOKEN = `${"t".repeat(42)}_`;
const DEV = "dev_0190c3b2a1d47a3b8c1d2e3f4a5b6c7d";
const NTC = "ntc_0190c3b2a1d47a3b8c1d2e3f4a5b6c7d";
const AT = "2026-11-16T12:00:00.000Z";

const pairingNotice = {
  id: NTC,
  kind: "device_paired",
  state: "open" as const,
  closeReason: null,
  summary: "s",
  openedAt: AT,
  device: { id: DEV, name: "p", origin: "o", address: null },
  actions: ["dismiss"],
  closedBy: null,
  closedFrom: null,
};

/** Each verb that calls the daemon, and the routes it needs answered. */
const VERBS: readonly (readonly [string, readonly string[], (d: FakeDaemon) => unknown])[] = [
  [
    "status",
    ["status"],
    (d) =>
      d
        .answer("GET /v1/health", HealthResponse, health())
        .answer("GET /v1/state", StateSnapshot, snapshot()),
  ],
  [
    "doctor",
    ["doctor"],
    (d) =>
      d
        .answer("GET /v1/health", HealthResponse, health())
        .answer("GET /v1/daemon/doctor", DoctorResponse, doctor()),
  ],
  [
    "stop",
    ["stop"],
    (d) =>
      d
        .answer("GET /v1/health", HealthResponse, health())
        .answerWith("POST /v1/daemon/stop", StopResponse, () => {
          setTimeout(() => void d.close(), 200);
          return {};
        }),
  ],
  [
    "env refresh",
    ["env", "refresh"],
    (d) =>
      d.answer("POST /v1/daemon/env", EnvRefreshResponse, {
        capturedAt: "t",
        kept: 1,
        removed: {},
        refused: [],
        unchanged: [],
      }),
  ],
  [
    "pair",
    ["pair"],
    (d) =>
      d.answer("POST /v1/pairing/codes", PairingCodeResponse, {
        code: "ABCD2345",
        expiresAt: AT,
        origins: [],
      }),
  ],
  [
    "devices",
    ["devices"],
    (d) =>
      d
        .answer("GET /v1/devices", DevicesResponse, { devices: [] })
        .answer("GET /v1/state", StateSnapshot, snapshot()),
  ],
  [
    "devices revoke",
    ["devices", "revoke", DEV],
    (d) => d.answer(`POST /v1/devices/${DEV}/revoke`, RevokeDeviceResponse, {}),
  ],
  [
    "devices dismiss",
    ["devices", "dismiss", DEV],
    (d) =>
      d
        .answer("GET /v1/state", StateSnapshot, snapshot({ notices: [pairingNotice] }))
        .answer(`POST /v1/notices/${NTC}/dismiss`, DismissNoticeResponse, { eventIds: [1] }),
  ],
  [
    "task list",
    ["task", "list", "--all"],
    (d) => d.answer("GET /v1/state", StateSnapshot, snapshot()),
  ],
  [
    "task assign",
    ["task", "assign", TASK, OTHER],
    (d) =>
      d.answer(`POST /v1/tasks/${TASK}/assign`, AssignTaskResponse, {
        assignmentId: "asgn_0190c3b2a1d47a3b8c1d2e3f4a5b6c7d",
        eventIds: [1],
      }),
  ],
  [
    "send --wait",
    ["send", OTHER, "hi", "--wait"],
    (d) =>
      d
        .answer(`POST /v1/agents/${OTHER}/messages`, SendMessageResponse, {
          messageId: MSG,
          eventIds: [1],
        })
        .answer("POST /v1/messages/wait", WaitMessagesResponse, {
          messages: [{ id: MSG, agentId: OTHER, state: "seen" }],
        }),
  ],
  ["agents", ["agents", "--json"], (d) => d.answer("GET /v1/state", StateSnapshot, snapshot())],
  [
    "roles",
    ["roles"],
    (d) => d.answer("GET /v1/roles", RolesResponse, { roles: [], problems: [] }),
  ],
  [
    "rename",
    ["rename", OTHER, "reviewer"],
    (d) =>
      d.answer(`POST /v1/agents/${OTHER}/rename`, AgentCommandResponse, {
        agentId: OTHER,
        eventIds: [1],
      }),
  ],
  [
    "task create",
    ["task", "create", "--title", "t", "--brief", "b"],
    (d) =>
      d.answer("POST /v1/tasks", CreateTaskResponse, {
        taskId: TASK,
        assignmentId: null,
        eventIds: [1],
      }),
  ],
  [
    "task show",
    ["task", "show", TASK],
    (d) =>
      d
        .answer(`GET /v1/tasks/${TASK}`, TaskDetail, detail())
        .answer("GET /v1/state", StateSnapshot, snapshot()),
  ],
  [
    "task unassign",
    ["task", "unassign", TASK, "asgn_0190c3b2a1d47a3b8c1d2e3f4a5b6c7d"],
    (d) => d.answer(`POST /v1/tasks/${TASK}/unassign`, TaskCommandResponse, { eventIds: [1] }),
  ],
  [
    "task done",
    ["task", "done", TASK],
    (d) => d.answer(`POST /v1/tasks/${TASK}/finish`, TaskCommandResponse, { eventIds: [1] }),
  ],
  [
    "task cancel",
    ["task", "cancel", TASK],
    (d) => d.answer(`POST /v1/tasks/${TASK}/finish`, TaskCommandResponse, { eventIds: [1] }),
  ],
  [
    "task note",
    ["task", "note", TASK, "Tests pass."],
    (d) => d.answer(`POST /v1/tasks/${TASK}/notes`, TaskCommandResponse, { eventIds: [1] }),
  ],
  [
    "escalate",
    ["escalate", "Pin it?"],
    (d) =>
      d.answer("POST /v1/escalations", EscalateResponse, {
        attentionId: "attn_0190c3b2a1d47a3b8c1d2e3f4a5b6c7d",
      }),
  ],
  [
    "delegate",
    ["delegate", OTHER, "--title", "t", "--brief", "b"],
    (d) =>
      d.answer("POST /v1/tasks/delegate", CreateTaskResponse, {
        taskId: TASK,
        assignmentId: null,
        eventIds: [1],
      }),
  ],
  [
    "send",
    ["send", OTHER, "hi"],
    (d) =>
      d.answer(`POST /v1/agents/${OTHER}/messages`, SendMessageResponse, {
        messageId: MSG,
        eventIds: [1],
      }),
  ],
  [
    "send --task",
    ["send", "--task", TASK, "hi"],
    (d) =>
      d.answer(`POST /v1/tasks/${TASK}/messages`, BroadcastMessageResponse, {
        sent: [{ agentId: OTHER, messageId: MSG }],
        skipped: [],
        eventIds: [1],
      }),
  ],
];
const asking = () =>
  s.daemon.received.map((r) => [
    r.headers["bazhen-agent-id"],
    r.headers["bazhen-agent-token"],
    r.headers["bazhen-device-id"],
  ]);

describe("who is asking", () => {
  it.each(VERBS)(
    "names the agent, proves it with its token, and names the paired device, on every call of %s",
    async (_name, argv, answer) => {
      answer(s.daemon);
      const file = join(s.dir, "token");
      writeFileSync(file, `${TOKEN}\n`);
      const ran = await s.bazhen(argv, {
        BAZHEN_AGENT_ID: AGENT,
        BAZHEN_DEVICE_ID: DEV,
        BAZHEN_AGENT_AUTH_FILE: file,
      });
      expect(ran.code).toBe(0);
      expect(s.daemon.received.length).toBeGreaterThan(0);
      expect(asking()).toEqual(s.daemon.received.map(() => [AGENT, TOKEN, DEV]));
    },
  );

  it.each(VERBS)(
    "names no agent or device on any call of %s run outside both",
    async (_name, argv, answer) => {
      answer(s.daemon);
      const ran = await s.bazhen(argv);
      expect(ran.code).toBe(0);
      expect(asking()).toEqual(s.daemon.received.map(() => [undefined, undefined, undefined]));
    },
  );

  it.each([
    ["a file holding no token", "not a token\n"],
    ["a token one character short", TOKEN.slice(1)],
    ["a token with a header after it", `${TOKEN}\r\nbazhen-agent-id: agent_x`],
    ["a file far larger than any token", "t".repeat(1 << 20)],
    ["a token followed by more of the file", `${TOKEN}\n${"x".repeat(100)}`],
  ])("sends no token from %s", async (_name, content) => {
    state();
    const file = join(s.dir, "token");
    writeFileSync(file, content);
    await s.bazhen(["task", "list"], { BAZHEN_AGENT_ID: AGENT, BAZHEN_AGENT_AUTH_FILE: file });
    expect(asking()).toEqual([[AGENT, undefined, undefined]]);
  });

  it("sends no token when the file can't be read, and still runs", async () => {
    state();
    const ran = await s.bazhen(["task", "list", "--all"], {
      BAZHEN_AGENT_ID: AGENT,
      BAZHEN_AGENT_AUTH_FILE: join(s.dir, "missing"),
    });
    expect([ran.code, asking()]).toEqual([0, [[AGENT, undefined, undefined]]]);
  });

  it("refuses an agent id no request header can carry, before calling the daemon", async () => {
    state();
    const ran = await s.bazhen(["task", "list", "--all"], { BAZHEN_AGENT_ID: "agént" });
    expect([ran, s.daemon.received]).toEqual([
      {
        code: 1,
        stdout: "",
        stderr: "BAZHEN_AGENT_ID holds a character outside printable ASCII\n",
      },
      [],
    ]);
  });

  it("names an empty agent when BAZHEN_AGENT_ID is set but empty", async () => {
    state();
    await s.bazhen(["task", "list", "--all"], { BAZHEN_AGENT_ID: "" });
    expect(asking()).toEqual([["", undefined, undefined]]);
  });

  it("names the agent, proves it with its token, and names the paired device, on whoami's calls", async () => {
    s.daemon.takes(AGENT).answer(
      "GET /v1/state",
      StateSnapshot,
      snapshot({
        agents: [agent(AGENT, "BZ-127")],
        tasks: [task(TASK, "t")],
        assignments: [assigned(TASK, AGENT)],
      }),
    );
    const file = join(s.dir, "token");
    writeFileSync(file, TOKEN);
    const ran = await s.bazhen(["whoami"], {
      BAZHEN_AGENT_ID: AGENT,
      BAZHEN_DEVICE_ID: DEV,
      BAZHEN_AGENT_AUTH_FILE: file,
    });
    expect([ran.code, s.daemon.routes(), asking()]).toEqual([
      0,
      ["GET /v1/caller", "GET /v1/state"],
      [
        [AGENT, TOKEN, DEV],
        [AGENT, TOKEN, DEV],
      ],
    ]);
  });

  it("sends no token from a file it may not read, and still runs", async ({ skip }) => {
    skip(process.getuid?.() === 0, "root reads a file of mode 000");
    state();
    const file = join(s.dir, "token");
    writeFileSync(file, TOKEN);
    chmodSync(file, 0o000);
    const ran = await s.bazhen(["task", "list", "--all"], {
      BAZHEN_AGENT_ID: AGENT,
      BAZHEN_AGENT_AUTH_FILE: file,
    });
    expect([ran.code, asking()]).toEqual([0, [[AGENT, undefined, undefined]]]);
  });
});
