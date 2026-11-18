import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
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
  WaitResponse,
} from "@bazhen/protocol";
import { FakeDaemon, type Scene, checkoutWith, scene } from "./cli.ts";
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
const execFileAsync = promisify(execFile);
const PATH = process.env["PATH"] ?? "/usr/bin:/bin";

describe("the command line", () => {
  it("prints the usage of every verb and exits 2 with no verb, or one it doesn't know", async () => {
    const runs = await Promise.all([s.bazhen([]), s.bazhen(["frobnicate"])]);
    expect(runs.map((r) => [r.code, r.stdout])).toEqual([
      [2, ""],
      [2, ""],
    ]);
    expect(runs[0]?.stderr.split("\n")).toEqual(
      expect.arrayContaining([
        "usage: bazhen <start|stop|status|doctor|env refresh> [--home <dir>] [--port <port>]",
        "usage: bazhen devices [list | pair | revoke <id> | dismiss <id>]",
        "usage: bazhen terminals attach <agent|shell|terminal> [--direct] [--home <dir>]",
        "  bazhen agents [list] [--json]",
        "  bazhen agents send <agent> (<text> | --file <path>) [--wait | --reply] [--timeout <seconds>] [--json]",
        "  bazhen agents launch claude-code|codex [--dir <dir>] [--name <name>] [--role <role>] [--compact-window <tokens>] [--json]",
        "  bazhen agents signal <agent> INT|TERM|HUP|KILL [--json]",
        "  bazhen agents wait <agent> <state>|ended|ready|idle [--timeout <seconds>] [--json]",
        "  bazhen tasks create --title <title> (--brief <text> | --brief-file <path>) [--parent <task>] [--assign <agent> [--role <role>]]",
        "  bazhen tasks send <task> (<text> | --file <path>) [--wait [--timeout <seconds>]]",
        "  bazhen tasks wait <task> done [--timeout <seconds>] [--json]",
        "  bazhen inbox escalate <question> [--task <task>]",
        "  bazhen shells open [<agent> | --dir <dir>] [--json]",
        "  bazhen shells wait <shell> <state>|ended [--timeout <seconds>] [--json]",
        "  bazhen events follow [--after <event>] [--json]",
      ]),
    );
    expect(runs[1]?.stderr).toBe(runs[0]?.stderr);
    expect(s.daemon.received).toEqual([]);
  });

  it("refuses each command that has a namespace when it is given without one, sending nothing", async () => {
    const usage = (await s.bazhen([])).stderr;
    const runs = await Promise.all(
      [
        ["send", OTHER, "hi"],
        ["send", "--task", TASK, "hi"],
        ["task", "list"],
        ["whoami"],
        ["rename", OTHER, "reviewer"],
        ["delegate", OTHER, "--title", "t", "--brief", "b"],
        ["escalate", "Pin it?"],
        ["launch", "codex"],
        ["close", OTHER],
        ["respawn", OTHER],
        ["relaunch", OTHER],
        ["signal", OTHER, "INT"],
        ["wait", OTHER, "running"],
        ["attach", OTHER],
        ["pair"],
      ].map((argv) => s.bazhen(argv, { BAZHEN_AGENT_ID: AGENT })),
    );
    expect(runs).toEqual(runs.map(() => ({ code: 2, stdout: "", stderr: usage })));
    expect(s.daemon.received).toEqual([]);
  });

  it("refuses events --follow, whose switch is now the verb follow", async () => {
    const ran = await s.bazhen(["events", "--follow"]);
    expect([ran.code, ran.stdout, ran.stderr.split("\n")[0]]).toEqual([
      2,
      "",
      "unexpected argument '--follow' found",
    ]);
  });

  it("answers a verb a namespace doesn't have, or none, with that namespace's usage alone", async () => {
    const runs = await Promise.all([
      s.bazhen(["tasks", "frobnicate"]),
      s.bazhen(["agents", "frobnicate"]),
      s.bazhen(["inbox"]),
      s.bazhen(["events", "frobnicate"]),
      s.bazhen(["terminals"]),
    ]);
    expect(runs.map((r) => [r.code, r.stdout, r.stderr.split("\n").slice(0, 3)])).toEqual([
      [2, "", ["tasks has no verb frobnicate", "usage:", "  bazhen tasks [list] [--all]"]],
      [2, "", ["agents has no verb frobnicate", "usage:", "  bazhen agents [list] [--json]"]],
      [
        2,
        "",
        ["inbox needs a verb", "usage:", "  bazhen inbox escalate <question> [--task <task>]"],
      ],
      [
        2,
        "",
        [
          "events has no verb frobnicate",
          "usage:",
          "  bazhen events follow [--after <event>] [--json]",
        ],
      ],
      [
        2,
        "",
        [
          "terminals needs a verb",
          "usage: bazhen terminals attach <agent|shell|terminal> [--direct] [--home <dir>]",
          "  Ctrl-\\ Ctrl-\\ detaches; a second kill ends it at once, after which `reset` repairs the terminal",
        ],
      ],
    ]);
    expect(runs.map((r) => r.stderr.includes("bazhen shells"))).toEqual(runs.map(() => false));
    expect(s.daemon.received).toEqual([]);
  });

  it("refuses a word after a verb that takes none, before stopping or starting anything", async () => {
    const runs = await Promise.all(
      [
        ["stop", "agents"],
        ["start", "now"],
        ["status", "x"],
        ["doctor", "x"],
        ["env", "refresh", "x"],
        ["devices", "pair", "x"],
        ["devices", "list", "x"],
        ["devices", "revoke", DEV, "x"],
      ].map((argv) => s.bazhen(argv)),
    );
    expect(runs.map((r) => [r.code, r.stdout, r.stderr.split("\n")[0]])).toEqual([
      [2, "", "stop takes no agents"],
      [2, "", "start takes no now"],
      [2, "", "status takes no x"],
      [2, "", "doctor takes no x"],
      [2, "", "env refresh takes no x"],
      [2, "", "devices pair takes no x"],
      [2, "", "devices list takes no x"],
      [2, "", `devices revoke ${DEV} takes no x`],
    ]);
    expect(s.daemon.received).toEqual([]);
  });

  it("refuses a word after a verb that lists, sending nothing", async () => {
    const runs = await Promise.all(
      [
        ["agents", "list", "all"],
        ["roles", "list", "all"],
        ["tasks", "list", "all"],
        ["agents", "whoami", OTHER],
      ].map((argv) => s.bazhen(argv)),
    );
    expect(runs.map((r) => [r.code, r.stdout, r.stderr.split("\n")[0]])).toEqual([
      [2, "", "agents list takes no all"],
      [2, "", "roles list takes no all"],
      [2, "", "tasks list takes no all"],
      [2, "", `agents whoami takes no ${OTHER}`],
    ]);
    expect(s.daemon.received).toEqual([]);
  });

  it.each([
    [
      ["tasks", "--all"],
      ["tasks", "list", "--all"],
    ],
    [["agents"], ["agents", "list"]],
    [["shells"], ["shells", "list"]],
  ])("lists with %j as with %j", async (bare, listed) => {
    s.daemon.answer("GET /v1/state", StateSnapshot, snapshot());
    const runs = [await s.bazhen(bare), await s.bazhen(listed)];
    expect(runs[0]).toEqual(runs[1]);
    expect(runs[0]?.code).toBe(0);
  });
});

describe("a daemon that isn't running", () => {
  it("exits 3, saying how to start it, for a read and for a command", async () => {
    await s.daemon.close();
    const runs = await Promise.all([
      s.bazhen(["status"]),
      s.bazhen(["tasks", "list"]),
      s.bazhen(["devices", "pair"]),
    ]);
    expect(runs).toEqual(
      Array.from({ length: 3 }, () => ({ code: 3, stdout: "", stderr: NOT_RUNNING })),
    );
  });

  it("exits 3 when it holds a read past five seconds, as one wedged does", async () => {
    s.daemon.hang("GET /v1/state");
    const begun = Date.now();
    const ran = await s.bazhen(["tasks", "list", "--all"]);
    expect(ran).toEqual({ code: 3, stdout: "", stderr: NOT_RUNNING });
    expect(Date.now() - begun).toBeGreaterThanOrEqual(4500);
  });

  it("exits 3 when it holds its answer on who is calling, rather than taking the caller for the human", async () => {
    s.daemon.hang("GET /v1/caller");
    const begun = Date.now();
    const ran = await s.bazhen(["agents", "whoami"]);
    expect([ran, s.daemon.routes()]).toEqual([
      { code: 3, stdout: "", stderr: NOT_RUNNING },
      ["GET /v1/caller"],
    ]);
    expect(Date.now() - begun).toBeGreaterThanOrEqual(4500);
  });
});

describe("a daemon that refuses", () => {
  it("exits 1 on a refused read, saying the path, the status and what the daemon said", async () => {
    const body = { error: "not_found" as const, message: "no task" };
    s.daemon.fail(`GET /v1/tasks/${TASK}`, 404, body);
    const ran = await s.bazhen(["tasks", "show", TASK]);
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
    const assign = await s.bazhen(["tasks", "assign", TASK, OTHER]);
    const pair = await s.bazhen(["devices", "pair"], { BAZHEN_AGENT_ID: AGENT });
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

  it("exits 1 on a route the daemon doesn't have, which it answers in plain text, saying to restart it", async () => {
    const roles = await s.bazhen(["roles"]);
    const caller = await s.bazhen(["agents", "whoami"]);
    expect([roles, caller]).toEqual([
      { code: 1, stdout: "", stderr: `/v1/roles: HTTP 404: 404 Not Found\n${ANOTHER_BUILD}\n` },
      { code: 1, stdout: "", stderr: `/v1/caller: HTTP 404: 404 Not Found\n${ANOTHER_BUILD}\n` },
    ]);
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

/** A second daemon, as an agent's own daemon is to a shell whose BAZHEN_HOME names another. */
async function callers(): Promise<{ daemon: FakeDaemon; env: { BAZHEN_SOCKET: string } }> {
  const run = join(s.dir, "agent-run");
  mkdirSync(run);
  const socket = join(run, "bazhen.sock");
  return { daemon: await FakeDaemon.listen(socket), env: { BAZHEN_SOCKET: socket } };
}

const CONFLICT = (socket: string, home: string) =>
  `--home ${home} names another daemon than BAZHEN_SOCKET ${socket}; run with BAZHEN_SOCKET= to use --home\n`;

describe("the daemon any verb reaches", () => {
  it("is never looked for on a command line that names no command, so it is a usage error first", async () => {
    const elsewhere = { BAZHEN_SOCKET: join(s.root, "elsewhere", "bazhen.sock") };
    const home = ["--home", s.home];
    const status = await s.bazhen(["status", ...home], elsewhere);
    const runs = await Promise.all(
      [["send", OTHER, "hi"], ["events"], ["events", "frobnicate"], ["agents", "frobnicate"]].map(
        (argv) => s.bazhen([...argv, ...home], elsewhere),
      ),
    );
    expect(status).toEqual({
      code: 1,
      stdout: "",
      stderr: CONFLICT(elsewhere.BAZHEN_SOCKET, s.home),
    });
    expect(runs.map((r) => [r.code, r.stdout])).toEqual(runs.map(() => [2, ""]));
    expect(s.daemon.received).toEqual([]);
  });

  it("is the caller's for every verb but start, never the home's", async () => {
    const theirs = await callers();
    try {
      theirs.daemon
        .answer("GET /v1/health", HealthResponse, health())
        .answer("GET /v1/state", StateSnapshot, snapshot({ agents: [agent(AGENT, "a")] }))
        .answer("GET /v1/daemon/doctor", DoctorResponse, doctor())
        .answer("GET /v1/devices", DevicesResponse, { devices: [] })
        .answer("POST /v1/pairing/codes", PairingCodeResponse, {
          code: "ABCD2345",
          expiresAt: "2026-11-16T12:05:00.000Z",
          origins: [],
        })
        .answer("POST /v1/daemon/env", EnvRefreshResponse, {
          capturedAt: "t",
          kept: 1,
          removed: {},
          refused: [],
          unchanged: [],
        })
        .answer("POST /v1/waits", WaitResponse, { verdict: "met", said: "a is running" });
      const verbs = [
        ["tasks", "list", "--all"],
        ["status"],
        ["doctor"],
        ["devices", "pair"],
        ["devices"],
        ["env", "refresh"],
        ["shells", "list"],
        ["agents", "wait", AGENT, "running", "--timeout", "1"],
      ];
      const codes = [];
      for (const verb of verbs) codes.push((await s.bazhen(verb, theirs.env)).code);
      expect([codes, s.daemon.received]).toEqual([verbs.map(() => 0), []]);
      expect(new Set(theirs.daemon.routes())).toEqual(
        new Set([
          "GET /v1/health",
          "GET /v1/state",
          "GET /v1/daemon/doctor",
          "POST /v1/pairing/codes",
          "GET /v1/devices",
          "POST /v1/daemon/env",
          "POST /v1/waits",
        ]),
      );
    } finally {
      await theirs.daemon.close();
    }
  });

  it("is not running when nothing answers on its caller's socket, naming it and the way to the home's", async () => {
    state().answer("GET /v1/health", HealthResponse, health());
    const gone = { BAZHEN_SOCKET: join(s.dir, "gone.sock") };
    const notRunning = {
      code: 3,
      stdout: "",
      stderr:
        `bazhen is not running on BAZHEN_SOCKET ${gone.BAZHEN_SOCKET}; run with BAZHEN_SOCKET= ` +
        "to reach the daemon your home names\n",
    };
    const listed = await s.bazhen(["tasks", "list"], gone);
    const status = await s.bazhen(["status"], gone);
    expect([listed, status, s.daemon.received]).toEqual([notRunning, notRunning, []]);
  });

  it("is the one the home names when BAZHEN_SOCKET is empty", async () => {
    state().answer("GET /v1/health", HealthResponse, health());
    const listed = await s.bazhen(["tasks", "list", "--all"], { BAZHEN_SOCKET: "" });
    const status = await s.bazhen(["status"], { BAZHEN_SOCKET: "" });
    expect([listed.code, status.code, s.daemon.routes().toSorted()]).toEqual([
      0,
      0,
      ["GET /v1/health", "GET /v1/state", "GET /v1/state"],
    ]);
  });

  it("is none when --home names another daemon than BAZHEN_SOCKET, refused on stderr alone", async () => {
    const theirs = await callers();
    try {
      theirs.daemon.answer("GET /v1/state", StateSnapshot, snapshot());
      state();
      const refused = { code: 1, stdout: "", stderr: CONFLICT(theirs.env.BAZHEN_SOCKET, s.home) };
      const stop = await s.bazhen(["stop", "--home", s.home], theirs.env);
      const json = await s.bazhen(["shells", "list", "--json", "--home", s.home], theirs.env);
      const listed = await s.bazhen(["tasks", "list", "--home", s.home], theirs.env);
      expect([stop, json, listed, theirs.daemon.received, s.daemon.received]).toEqual([
        refused,
        refused,
        refused,
        [],
        [],
      ]);
    } finally {
      await theirs.daemon.close();
    }
  });

  it("is refused for a --home naming another daemon, not one naming BAZHEN_SOCKET's by another spelling or a symlink", async () => {
    state().answer("GET /v1/health", HealthResponse, health());
    const linked = join(s.root, "linked-home");
    symlinkSync(s.home, linked);
    const env = { BAZHEN_SOCKET: s.socket };
    const other = join(s.root, "other-home");
    const runs = [
      await s.bazhen(["status", "--home", other], env),
      await s.bazhen(["status", "--home", `${s.home}/`], env),
      await s.bazhen(["status", "--home", linked], env),
    ];
    expect(runs.map((r) => [r.code, r.stderr])).toEqual([
      [1, CONFLICT(s.socket, other)],
      [0, ""],
      [0, ""],
    ]);
  });

  it("is none for a BAZHEN_SOCKET no daemon would set: relative, or with a stray newline", async () => {
    const relative = await s.bazhen(["status"], { BAZHEN_SOCKET: "run/bazhen.sock" });
    const newline = await s.bazhen(["status"], { BAZHEN_SOCKET: `${s.socket}\n` });
    expect([relative, newline, s.daemon.received]).toEqual([
      {
        code: 1,
        stdout: "",
        stderr: 'BAZHEN_SOCKET must be an absolute path, not "run/bazhen.sock"\n',
      },
      {
        code: 1,
        stdout: "",
        stderr: `BAZHEN_SOCKET must be an absolute path, not "${s.socket}\\n"\n`,
      },
      [],
    ]);
  });

  it("is ignored by start alone, which runs the daemon of the home --home names", async () => {
    const binary = checkoutWith(
      join(s.root, "checkout"),
      "process.stdout.write(`home=${process.env.BAZHEN_HOME}`);\n",
    );
    const start = (socket: string) =>
      execFileAsync(binary, ["start", "--home", s.home], {
        env: { PATH, HOME: s.root, BAZHEN_SOCKET: socket },
        cwd: s.dir,
      });
    const elsewhere = join(s.dir, "agent-run", "bazhen.sock");
    const other = await start(elsewhere);
    const relative = await start("relative.sock");
    const status = await s.bazhen(["status", "--home", s.home], { BAZHEN_SOCKET: elsewhere });
    expect([other, relative, status.code, s.daemon.received]).toEqual([
      { stdout: `home=${s.home}`, stderr: "" },
      { stdout: `home=${s.home}`, stderr: "" },
      1,
      [],
    ]);
  });

  it("is under --home over BAZHEN_HOME, and under a home given with a trailing slash", async () => {
    state();
    const flag = await s.bazhen(["tasks", "list", "--all", "--home", s.home], {
      BAZHEN_HOME: join(s.dir, "other"),
    });
    const slash = await s.bazhen(["tasks", "list", "--all"], { BAZHEN_HOME: `${s.home}/` });
    expect([flag.code, slash.code, s.daemon.routes()]).toEqual([
      0,
      0,
      ["GET /v1/state", "GET /v1/state"],
    ]);
  });

  it("refuses a home that isn't an absolute path, reaching no daemon", async () => {
    const ran = await s.bazhen(["tasks", "list", "--home", "relative/home"]);
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
      const ran = await s.bare(["tasks", "list", "--all"], { XDG_RUNTIME_DIR: runtime });
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
      const ran = await s.bazhen(["tasks", "list", "--all"], { BAZHEN_HOME: home });
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
    "devices pair",
    ["devices", "pair"],
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
    "tasks list",
    ["tasks", "list", "--all"],
    (d) => d.answer("GET /v1/state", StateSnapshot, snapshot()),
  ],
  [
    "tasks assign",
    ["tasks", "assign", TASK, OTHER],
    (d) =>
      d.answer(`POST /v1/tasks/${TASK}/assign`, AssignTaskResponse, {
        assignmentId: "asgn_0190c3b2a1d47a3b8c1d2e3f4a5b6c7d",
        eventIds: [1],
      }),
  ],
  [
    "agents send --wait",
    ["agents", "send", OTHER, "hi", "--wait"],
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
    "agents rename",
    ["agents", "rename", OTHER, "reviewer"],
    (d) =>
      d.answer(`POST /v1/agents/${OTHER}/rename`, AgentCommandResponse, {
        agentId: OTHER,
        eventIds: [1],
      }),
  ],
  [
    "tasks create",
    ["tasks", "create", "--title", "t", "--brief", "b"],
    (d) =>
      d.answer("POST /v1/tasks", CreateTaskResponse, {
        taskId: TASK,
        assignmentId: null,
        eventIds: [1],
      }),
  ],
  [
    "tasks show",
    ["tasks", "show", TASK],
    (d) =>
      d
        .answer(`GET /v1/tasks/${TASK}`, TaskDetail, detail())
        .answer("GET /v1/state", StateSnapshot, snapshot()),
  ],
  [
    "tasks unassign",
    ["tasks", "unassign", TASK, "asgn_0190c3b2a1d47a3b8c1d2e3f4a5b6c7d"],
    (d) => d.answer(`POST /v1/tasks/${TASK}/unassign`, TaskCommandResponse, { eventIds: [1] }),
  ],
  [
    "tasks done",
    ["tasks", "done", TASK],
    (d) => d.answer(`POST /v1/tasks/${TASK}/finish`, TaskCommandResponse, { eventIds: [1] }),
  ],
  [
    "tasks cancel",
    ["tasks", "cancel", TASK],
    (d) => d.answer(`POST /v1/tasks/${TASK}/finish`, TaskCommandResponse, { eventIds: [1] }),
  ],
  [
    "tasks note",
    ["tasks", "note", TASK, "Tests pass."],
    (d) => d.answer(`POST /v1/tasks/${TASK}/notes`, TaskCommandResponse, { eventIds: [1] }),
  ],
  [
    "inbox escalate",
    ["inbox", "escalate", "Pin it?"],
    (d) =>
      d.answer("POST /v1/escalations", EscalateResponse, {
        attentionId: "attn_0190c3b2a1d47a3b8c1d2e3f4a5b6c7d",
      }),
  ],
  [
    "tasks delegate",
    ["tasks", "delegate", OTHER, "--title", "t", "--brief", "b"],
    (d) =>
      d.answer("POST /v1/tasks/delegate", CreateTaskResponse, {
        taskId: TASK,
        assignmentId: null,
        eventIds: [1],
      }),
  ],
  [
    "agents send",
    ["agents", "send", OTHER, "hi"],
    (d) =>
      d.answer(`POST /v1/agents/${OTHER}/messages`, SendMessageResponse, {
        messageId: MSG,
        eventIds: [1],
      }),
  ],
  [
    "tasks send",
    ["tasks", "send", TASK, "hi"],
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
    await s.bazhen(["tasks", "list"], { BAZHEN_AGENT_ID: AGENT, BAZHEN_AGENT_AUTH_FILE: file });
    expect(asking()).toEqual([[AGENT, undefined, undefined]]);
  });

  it("sends no token when the file can't be read, and still runs", async () => {
    state();
    const ran = await s.bazhen(["tasks", "list", "--all"], {
      BAZHEN_AGENT_ID: AGENT,
      BAZHEN_AGENT_AUTH_FILE: join(s.dir, "missing"),
    });
    expect([ran.code, asking()]).toEqual([0, [[AGENT, undefined, undefined]]]);
  });

  it("refuses an agent id no request header can carry, before calling the daemon", async () => {
    state();
    const ran = await s.bazhen(["tasks", "list", "--all"], { BAZHEN_AGENT_ID: "agént" });
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
    await s.bazhen(["tasks", "list", "--all"], { BAZHEN_AGENT_ID: "" });
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
    const ran = await s.bazhen(["agents", "whoami"], {
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
    const ran = await s.bazhen(["tasks", "list", "--all"], {
      BAZHEN_AGENT_ID: AGENT,
      BAZHEN_AGENT_AUTH_FILE: file,
    });
    expect([ran.code, asking()]).toEqual([0, [[AGENT, undefined, undefined]]]);
  });
});
