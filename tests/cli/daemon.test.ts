import { linkSync, renameSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DevicesResponse,
  DismissNoticeResponse,
  DoctorResponse,
  EnvRefreshResponse,
  HealthResponse,
  type Notice,
  PairingCodeResponse,
  RevokeDeviceResponse,
  StateSnapshot,
  StopResponse,
} from "@bazhen/protocol";
import { FakeDaemon, type Scene, holdLock, scene } from "./cli.ts";
import {
  AGENT,
  ANOTHER_BUILD,
  OTHER,
  SHORT_ID,
  THIRD,
  UUID,
  agent,
  doctor,
  health,
  snapshot,
} from "./fixtures.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Closes `daemon` but leaves its socket file, which refuses connections, as a daemon that stops
 * listening before it removes its socket does. `close` removes the file, so a second link to it is
 * put back in its place.
 */
async function closeLeavingSocket(daemon: FakeDaemon, socket: string): Promise<void> {
  const kept = `${socket}.kept`;
  linkSync(socket, kept);
  await daemon.close();
  renameSync(kept, socket);
}

let s: Scene;
beforeEach(async () => {
  s = await scene();
});
afterEach(async () => {
  await s.cleanup();
});

const lines = (text: string) => text.split("\n");

/** `/v1/health` as a daemon from before protocol ids answered it. */
const OLDER_HEALTH = JSON.stringify({
  status: "ok",
  appVersion: "0.1.0",
  protocolVersion: "1.55",
  schemaVersion: 30,
  runtime: { kind: "tmux", state: "healthy", version: "3.4" },
});

describe("bazhen status", () => {
  it("says the daemon's version, each runtime, and its agents counted by state", async () => {
    s.daemon
      .answer(
        "GET /v1/health",
        HealthResponse,
        health({
          runtimes: [
            { kind: "tmux", state: "healthy", version: "3.4" },
            { kind: "holder", state: "not-running", version: null },
          ],
        }),
      )
      .answer(
        "GET /v1/state",
        StateSnapshot,
        snapshot({
          agents: [agent(AGENT, "a"), agent(OTHER, "b", { state: "closed" }), agent(THIRD, "c")],
        }),
      );
    const ran = await s.bazhen(["status"]);
    expect([ran.code, lines(ran.stdout)]).toEqual([
      0,
      [
        `bazhen 0.1.0 (protocol ${SHORT_ID}), running`,
        "tmux: healthy 3.4",
        "holder: not-running",
        "agents: 2 running, 1 closed",
        "",
      ],
    ]);
  });

  it("says a runtime the daemon didn't read is unused, and no agents", async () => {
    s.daemon
      .answer(
        "GET /v1/health",
        HealthResponse,
        health({
          runtimes: [
            { kind: "holder", state: "healthy", version: "holder/1.2" },
            { kind: "tmux", state: "unused", version: null },
          ],
        }),
      )
      .answer("GET /v1/state", StateSnapshot, snapshot());
    const ran = await s.bazhen(["status"]);
    expect(lines(ran.stdout).slice(1)).toEqual([
      "holder: healthy holder/1.2",
      "tmux: unused",
      "agents: none",
      "",
    ]);
  });

  it("says a daemon speaking another protocol is another build, to restart", async () => {
    s.daemon
      .answer("GET /v1/health", HealthResponse, health({ protocolId: "f".repeat(64) }))
      .answer("GET /v1/state", StateSnapshot, snapshot());
    const ran = await s.bazhen(["status"]);
    expect([ran.code, lines(ran.stdout).slice(0, 2)]).toEqual([
      0,
      [
        "bazhen 0.1.0 (protocol ffffffffffff), running",
        `  warning: this CLI speaks protocol ${SHORT_ID}; ${ANOTHER_BUILD}`,
      ],
    ]);
  });

  it("fails against a daemon from before protocol ids, saying to restart it", async () => {
    s.daemon
      .raw("GET /v1/health", 200, OLDER_HEALTH)
      .answer("GET /v1/state", StateSnapshot, snapshot());
    const ran = await s.bazhen(["status"]);
    expect([ran.code, ran.stdout, ran.stderr.trimEnd().split("\n").at(-1)]).toEqual([
      1,
      "",
      ANOTHER_BUILD,
    ]);
  });
});

const web = async (w: NonNullable<DoctorResponse["web"]>) => {
  s.daemon
    .answer("GET /v1/health", HealthResponse, health())
    .answer("GET /v1/daemon/doctor", DoctorResponse, doctor({ web: w }));
  const out = lines((await s.bazhen(["doctor"])).stdout);
  return out.slice(out.indexOf("config: /home/u/.config/bazhen/config.toml") + 2, -3);
};

const tail = async (over: Partial<DoctorResponse>) => {
  s.daemon
    .answer("GET /v1/health", HealthResponse, health())
    .answer("GET /v1/daemon/doctor", DoctorResponse, doctor(over));
  return lines((await s.bazhen(["doctor"])).stdout).slice(5, -3);
};

const on = (build: string | null, protocol = ["1.2"]) => ({ terminalId: "t", build, protocol });

/** A holder runtime, and tmux in `state`. */
const withTmux = (state: "healthy" | "unused") => [
  { kind: "holder", state: "healthy" as const, version: "holder/1.2" },
  { kind: "tmux", state, version: state === "unused" ? null : "3.4" },
];

/** `bazhen doctor` against a daemon whose doctor names `peerReader` as the peer reader. */
const doctorWith = (peerReader: DoctorResponse["peerReader"]) => {
  s.daemon
    .answer("GET /v1/health", HealthResponse, health())
    .answer("GET /v1/daemon/doctor", DoctorResponse, doctor({ peerReader }));
  return s.bazhen(["doctor"]);
};

/** The doctor lines about the bazhen agents find, from a daemon that reports `agentCli`. */
const agentCliLines = async (agentCli: DoctorResponse["agentCli"]) => {
  s.daemon
    .answer("GET /v1/health", HealthResponse, health())
    .answer("GET /v1/daemon/doctor", DoctorResponse, doctor({ agentCli }));
  return lines((await s.bazhen(["doctor"])).stdout).filter((l) =>
    /agent CLI|that is not|no bazhen/.test(l),
  );
};

/** The doctor's codex line and the one after it, from a daemon whose Codex reads as `toolCalls`. */
const codexLines = async (toolCalls: "marked" | "unmarked" | "unread" | null) => {
  s.daemon
    .answer("GET /v1/health", HealthResponse, health())
    .answer(
      "GET /v1/daemon/doctor",
      DoctorResponse,
      doctor({ codex: { daemon: "0.169.0", cli: "0.169.0", toolCalls } }),
    );
  const out = lines((await s.bazhen(["doctor"])).stdout);
  const at = out.indexOf("codex: app-server 0.169.0 (as last connected), cli 0.169.0");
  return out.slice(at, at + 2);
};

describe("bazhen doctor", () => {
  it("shows what the daemon runs with, and passes when every runtime answers", async () => {
    s.daemon.answer("GET /v1/health", HealthResponse, health()).answer(
      "GET /v1/daemon/doctor",
      DoctorResponse,
      doctor({
        runtimes: [
          { kind: "tmux", state: "healthy", version: "3.4" },
          { kind: "holder", state: "healthy", version: "holder/1.2" },
        ],
        agents: { shell: "login", loginShell: "/bin/zsh" },
        codex: { daemon: null, cli: "0.166.0" },
        notifications: { desktop: true, notifier: "notify-send" },
      }),
    );
    const ran = await s.bazhen(["doctor"]);
    expect([ran.code, lines(ran.stdout)]).toEqual([
      0,
      [
        `bazhen 0.1.0 (protocol ${SHORT_ID})`,
        "tmux: healthy 3.4",
        "holder: healthy holder/1.2",
        "hook client: /repo/target/release/bazhen-hook",
        "config: /home/u/.config/bazhen/config.toml",
        "agents.shell: login (/bin/zsh)",
        "codex: app-server not connected yet, cli 0.166.0",
        "desktop notifications: on",
        "environment: captured 2026-11-16T12:00:00.000Z at start, 40 variables kept",
        "  removed: secrets 2, session 1",
        "",
      ],
    ]);
  });

  it("warns of the hook script, a missing config, and a capture by refresh", async () => {
    s.daemon.answer("GET /v1/health", HealthResponse, health()).answer(
      "GET /v1/daemon/doctor",
      DoctorResponse,
      doctor({
        hookClient: { path: "/repo/hook.sh", fallback: true },
        config: { path: "/c.toml", found: false },
        codex: { daemon: "0.160.0", cli: null },
        env: { capturedAt: "t", source: "refresh", kept: 3, removed: {} },
      }),
    );
    const out = lines((await s.bazhen(["doctor"])).stdout);
    expect(out).toEqual(
      expect.arrayContaining([
        "hook client: /repo/hook.sh",
        "  warning: bazhen-hook is not built; hooks use the slower curl script",
        "config: /c.toml (none; defaults)",
        "agents.shell: direct",
        "codex: app-server 0.160.0 (as last connected), cli not found",
        "environment: captured t by bazhen env refresh, 3 variables kept",
        "  removed: none",
      ]),
    );
  });

  it("warns when Codex's app-server can't be told for one, so a Codex agent's commands could pass as yours", async () => {
    const codex = "codex: app-server 0.169.0 (as last connected), cli 0.169.0";
    expect([
      await codexLines("marked"),
      await codexLines(null),
      await codexLines("unmarked"),
      await codexLines("unread"),
    ]).toEqual([
      [codex, expect.not.stringContaining("warning")],
      [codex, expect.not.stringContaining("warning")],
      [
        codex,
        "  warning: the peer reader doesn't know this app-server for Codex's, so a live Codex agent's commands could pass as yours",
      ],
      [
        codex,
        "  warning: the peer reader can't read Codex's app-server, so whether a live Codex agent's commands pass as yours is unknown",
      ],
    ]);
  });

  it("says which program reads who calls on its socket, and warns when none is installed", async () => {
    const found = lines((await doctorWith({ path: "/r/target/release/bazhen-peer" })).stdout);
    const none = lines((await doctorWith(null)).stdout);
    expect(found.slice(2, 4)).toEqual([
      "hook client: /repo/target/release/bazhen-hook",
      "peer reader: /r/target/release/bazhen-peer",
    ]);
    expect(none.slice(3, 5)).toEqual([
      "peer reader: none",
      "  warning: the daemon can't read which process calls on its socket, so a call from inside an agent that presents nothing passes as yours; moon run :build builds bazhen-peer, so this install is incomplete",
    ]);
  });

  it("says which bazhen agents find, and warns when it is none or another build", async () => {
    expect(await agentCliLines({ expected: "/r/bazhen", onPath: "/r/bazhen" })).toEqual([
      "agent CLI: /r/bazhen",
    ]);
    expect(await agentCliLines({ expected: "/r/bazhen", onPath: "/h/bazhen" })).toEqual([
      "agent CLI: /h/bazhen",
      "  warning: that is not the bazhen built with this daemon (/r/bazhen), so agents may speak another protocol; link /r/bazhen into a directory on the PATH agents start with",
    ]);
    expect(await agentCliLines({ expected: "/r/bazhen", onPath: null })).toEqual([
      "agent CLI: none",
      "  warning: no bazhen on the PATH agents start with, so they can't run it; link /r/bazhen into a directory on it",
    ]);
    expect(await agentCliLines(undefined)).toEqual([]);
  });

  it("fails when any runtime can't be read, not only tmux", async () => {
    s.daemon.answer("GET /v1/health", HealthResponse, health()).answer(
      "GET /v1/daemon/doctor",
      DoctorResponse,
      doctor({
        runtimes: [
          { kind: "tmux", state: "healthy", version: "3.4" },
          { kind: "holder", state: "unreachable", version: "holder/1.2" },
        ],
      }),
    );
    const ran = await s.bazhen(["doctor"]);
    expect([ran.code, lines(ran.stdout).slice(1, 3)]).toEqual([
      1,
      ["tmux: healthy 3.4", "holder: unreachable holder/1.2"],
    ]);
  });

  it("passes with a runtime it didn't read, which is unused, not unreachable", async () => {
    s.daemon.answer("GET /v1/health", HealthResponse, health()).answer(
      "GET /v1/daemon/doctor",
      DoctorResponse,
      doctor({
        runtimes: [
          { kind: "holder", state: "healthy", version: "holder/1.2" },
          { kind: "tmux", state: "unused", version: null },
        ],
      }),
    );
    const ran = await s.bazhen(["doctor"]);
    expect([ran.code, lines(ran.stdout).slice(1, 3)]).toEqual([
      0,
      ["holder: healthy holder/1.2", "tmux: unused"],
    ]);
  });

  it("fails, saying the daemon isn't running, when nothing answers", async () => {
    await s.daemon.close();
    const ran = await s.bazhen(["doctor"]);
    expect([ran.code, ran.stdout]).toEqual([1, `daemon: not running (no answer on ${s.socket})\n`]);
  });

  describe("on the web", () => {
    it("says loopback alone serves, where the app is, and the risk of no pairing", async () => {
      expect(
        await web({
          externalOrigins: [],
          from: null,
          allowInsecureOrigins: false,
          pairing: { mode: "auto", required: false },
          app: null,
        }),
      ).toEqual([
        "external origins: none (loopback only)",
        "web app: not built; `moon run :build` builds it, and the daemon serves only the API until then",
        'pairing: not required on loopback (web.pairing = "auto", no external origins); a request a proxy forwards from another machine must still pair',
        `  warning: any local process or other user of this machine who can reach the daemon's port on 127.0.0.1 controls the agents; set web.pairing = "always" on a shared machine`,
      ]);
    });

    it("names external origins, warns of plain HTTP to another host, and requires pairing", async () => {
      expect(
        await web({
          externalOrigins: [
            "https://box.tail.ts.net",
            "http://192.168.1.5:7900",
            "http://localhost:7901",
          ],
          from: "config",
          allowInsecureOrigins: true,
          pairing: { mode: "always", required: true },
          app: "/repo/apps/web/dist",
        }),
      ).toEqual([
        "external origins: https://box.tail.ts.net, http://192.168.1.5:7900, http://localhost:7901 (from config)",
        "  warning: plain HTTP to another host (http://192.168.1.5:7900); anyone on the network can read the traffic, device tokens included",
        "web app: served from /repo/apps/web/dist",
        'pairing: required on every origin (web.pairing = "always"); `bazhen devices pair`',
      ]);
    });

    const lan = {
      url: "https://my-mac.local:7942",
      allow: ["192.168.1.0/24"],
      certificate: {
        fingerprint: "ab cd",
        path: "/s/tls/lan.crt",
        expiresAt: "2029-02-11T00:00:00.000Z",
      },
      error: null,
      subnets: [{ interface: "eno1", cidr: "192.168.1.0/24" }],
    };
    const base = { externalOrigins: [], from: null, allowInsecureOrigins: false };

    it("shows where the LAN listener serves and the certificate to trust", async () => {
      expect(await web({ ...base, lan })).toEqual([
        "external origins: none (loopback only)",
        "LAN: https://my-mac.local:7942, to 192.168.1.0/24",
        "  certificate SHA-256: ab cd",
        "  certificate: /s/tls/lan.crt, expires 2029-02-11T00:00:00.000Z",
        "  this host's subnets: 192.168.1.0/24 (eno1)",
      ]);
    });

    it("says the LAN listener isn't serving when it stopped, or its certificate couldn't be used", async () => {
      expect(
        await web({
          ...base,
          lan: {
            ...lan,
            certificate: null,
            error: "the LAN certificate can't be used",
            subnets: [],
          },
        }),
      ).toEqual([
        "external origins: none (loopback only)",
        "LAN: https://my-mac.local:7942, to 192.168.1.0/24",
        "  not serving: the LAN certificate can't be used",
        "  this host's subnets: none",
      ]);
    });

    it("says the LAN listener isn't serving before its certificate, when it stopped with one loaded", async () => {
      expect(await web({ ...base, lan: { ...lan, error: "listen EADDRINUSE" } })).toEqual([
        "external origins: none (loopback only)",
        "LAN: https://my-mac.local:7942, to 192.168.1.0/24",
        "  not serving: listen EADDRINUSE",
        "  certificate SHA-256: ab cd",
        "  certificate: /s/tls/lan.crt, expires 2029-02-11T00:00:00.000Z",
        "  this host's subnets: 192.168.1.0/24 (eno1)",
      ]);
    });
  });

  describe("on terminals and holders", () => {
    it("shows the open count against the budget, and the machine's PTYs", async () => {
      expect(
        await tail({
          terminals: {
            open: 3,
            max: 100,
            host: { used: 37, max: 4096, exact: true },
            refusing: null,
          },
        }),
      ).toEqual([
        "terminals: 3 open, at most 100 (terminals.max_open)",
        "  machine PTYs: 37 of 4096 in use",
      ]);
    });

    it("says new terminals are refused at the budget, and when the machine is short of PTYs", async () => {
      expect(
        await tail({ terminals: { open: 4, max: 4, host: null, refusing: "budget" } }),
      ).toEqual([
        "terminals: 4 open, at most 4 (terminals.max_open)",
        "  new agents and shells are refused until one is closed",
        "  machine PTYs: can't be counted here",
      ]);
      expect(
        await tail({
          terminals: {
            open: 1,
            max: 100,
            host: { used: 40, max: 511, exact: false },
            refusing: "host",
          },
        }),
      ).toEqual([
        "terminals: 1 open, at most 100 (terminals.max_open)",
        "  new agents and shells are refused: the machine is short of PTYs",
        "  machine PTYs: as many as 40 of 511 in use (the count includes closed ones)",
      ]);
    });

    const NEW = "3f9a0c1d2e4b5a67";
    const OLD = "81ce22d09b7f4410";

    it("says why no holder is installed", async () => {
      expect(
        await tail({ holder: { binary: null, build: null, reason: "x isn't built", holders: [] } }),
      ).toEqual(["holder: none installed (x isn't built)"]);
    });

    it("counts terminals by the holder build they run, marking older and unknown builds", async () => {
      const binary = `/s/holder/${NEW}/bazhen-holder`;
      const holders = [on(NEW), on(OLD), on(NEW), on(null), on(OLD, ["1.3", "1.2"])];
      expect(await tail({ holder: { binary, build: NEW, reason: null, holders } })).toEqual([
        `holder: build ${NEW} (${binary})`,
        `  2 terminals on ${NEW}, protocol 1.2`,
        `  1 terminal on ${OLD} (older build; restart to upgrade), protocol 1.2`,
        "  1 terminal on an unknown build, protocol 1.2",
        `  1 terminal on ${OLD} (older build; restart to upgrade), protocol 1.3, 1.2`,
      ]);
    });

    it("lists each holder with its pid, memory and socket, once the daemon says them", async () => {
      const binary = `/s/holder/${NEW}/bazhen-holder`;
      const MiB = 1 << 20;
      const holders = [
        {
          ...on(NEW),
          terminalId: "term_a",
          socket: "/r/holders/term_a.sock",
          holderPid: 4242,
          stats: { engineBytes: 2 * MiB, rss: 9.75 * MiB, ringBytes: MiB, historyLines: 812 },
        },
        {
          ...on(NEW),
          terminalId: "term_b",
          socket: "/r/holders/term_b.sock",
          holderPid: 4243,
          stats: { engineBytes: 0, rss: null, ringBytes: 0, historyLines: 0 },
        },
        {
          ...on(NEW),
          terminalId: "term_c",
          socket: "/r/holders/term_c.sock",
          holderPid: 4244,
          stats: null,
        },
        {
          ...on(null, ["0.9"]),
          terminalId: "term_d",
          socket: "/r/holders/term_d.sock",
          holderPid: null,
          stats: null,
        },
        on(NEW),
      ];
      expect(await tail({ holder: { binary, build: NEW, reason: null, holders } })).toEqual([
        `holder: build ${NEW} (${binary})`,
        `  4 terminals on ${NEW}, protocol 1.2`,
        "  1 terminal on an unknown build, protocol 0.9",
        "  term_a: pid 4242, 9.8 MiB resident (engine 2.0 MiB, ring 1.0 MiB), 812 history lines (/r/holders/term_a.sock)",
        "  term_b: pid 4243, resident size unknown (engine 0.0 MiB, ring 0.0 MiB), 0 history lines (/r/holders/term_b.sock)",
        "  term_c: pid 4244, memory not reported (/r/holders/term_c.sock)",
        "  term_d: shares no protocol with this build; restart it (/r/holders/term_d.sock)",
      ]);
    });

    it("warns under a runtime of each defect Bazhen works around there", async () => {
      const runtimes = [
        {
          kind: "tmux",
          state: "healthy" as const,
          version: "3.4",
          workarounds: [
            "tmux 3.4 crashes when a dead pane's focus changes; Bazhen keeps focus off dead panes",
          ],
        },
        { kind: "holder", state: "healthy" as const, version: "holder/1.2", workarounds: [] },
      ];
      s.daemon
        .answer("GET /v1/health", HealthResponse, health())
        .answer("GET /v1/daemon/doctor", DoctorResponse, doctor({ runtimes }));
      expect(lines((await s.bazhen(["doctor"])).stdout).slice(1, 4)).toEqual([
        "tmux: healthy 3.4",
        "  warning: tmux 3.4 crashes when a dead pane's focus changes; Bazhen keeps focus off dead panes",
        "holder: healthy holder/1.2",
      ]);
    });

    const GIB = 1024 ** 3;
    const scoped = {
      state: "scoped" as const,
      systemd: 255,
      oomPolicy: true,
      terminal: { asked: "50%", bytes: 31 * GIB },
      total: { asked: "infinity", bytes: null },
      swap: { asked: "0", bytes: 0 },
    };

    it("says each holder terminal runs in a scope of its own, with its caps", async () => {
      const said = await tail({ containment: scoped, runtimes: withTmux("healthy") });
      expect(said.slice(1)).toEqual([
        "containment: each holder terminal in a systemd scope of its own, at most 50% (31.0 GiB) each with 0 (none) of swap, and infinity (no cap) together",
        "  tmux terminals are not contained",
      ]);
    });

    it("says nothing of tmux terminals' containment while tmux is unused", async () => {
      const said = await tail({ containment: scoped, runtimes: withTmux("unused") });
      expect(said.slice(1)).toEqual([
        "containment: each holder terminal in a systemd scope of its own, at most 50% (31.0 GiB) each with 0 (none) of swap, and infinity (no cap) together",
      ]);
    });

    it("rounds a cap's GiB half up, as it is said, and notes a systemd too old for OOMPolicy", async () => {
      const quarter = {
        ...scoped,
        oomPolicy: false,
        systemd: 249,
        terminal: { asked: "256M", bytes: GIB / 4 },
        total: { asked: "1.15G", bytes: Math.round(1.15 * GIB) },
      };
      expect(
        await tail({
          containment: quarter,
          runtimes: [{ kind: "holder", state: "healthy", version: null }],
        }),
      ).toEqual([
        "containment: each holder terminal in a systemd scope of its own, at most 256M (0.3 GiB) each with 0 (none) of swap, and 1.15G (1.2 GiB) together",
        "  note: systemd 249 predates OOMPolicy for scopes (253), so the kernel alone decides what dies past a cap",
      ]);
    });

    it("counts holder terminals running outside a scope, and says to restart them only when scopes are made", async () => {
      const holders = [
        { ...on("b"), contained: false },
        { ...on("b"), contained: false },
        { ...on("b"), contained: true },
        { ...on("b"), contained: null },
        on("b"),
      ];
      const holder = { binary: "/h", build: "b", reason: null, holders };
      const one = {
        binary: "/h",
        build: "b",
        reason: null,
        holders: [{ ...on("b"), contained: false }],
      };
      const runtimes = [{ kind: "holder", state: "healthy" as const, version: null }];
      expect(await tail({ containment: scoped, holder, runtimes })).toContain(
        "  2 holder terminals run outside a scope; restart them to contain them",
      );
      expect(await tail({ containment: scoped, holder: one, runtimes })).toContain(
        "  1 holder terminal runs outside a scope; restart it to contain it",
      );
      expect(
        await tail({
          containment: { state: "uncontained", why: "no systemd user manager" },
          holder: one,
          runtimes,
        }),
      ).toEqual([
        "holder: build b (/h)",
        "  1 terminal on b, protocol 1.2",
        "containment: none (no systemd user manager)",
        "  warning: one terminal's runaway memory can end every other terminal",
        "  1 holder terminal runs outside a scope",
      ]);
    });

    it("says containment hasn't been checked before a holder terminal starts", async () => {
      const said = await tail({
        containment: { state: "unchecked" },
        runtimes: withTmux("healthy"),
      });
      expect(said.slice(1)).toEqual([
        "containment: not checked yet (no holder terminal has started since the daemon did)",
        "  tmux terminals are not contained",
      ]);
    });
  });
});

describe("bazhen stop", () => {
  it("stops a daemon from before protocol ids", async () => {
    s.daemon
      .raw("GET /v1/health", 200, OLDER_HEALTH)
      .answerWith("POST /v1/daemon/stop", StopResponse, () => {
        const { daemon } = s;
        setTimeout(() => void daemon.close(), 100);
        return {};
      });
    const ran = await s.bazhen(["stop"]);
    expect([ran.code, ran.stdout]).toEqual([0, "bazhen stopped; agents keep running\n"]);
  });

  it("stops the daemon, and waits until it no longer answers", async () => {
    s.daemon
      .answer("GET /v1/health", HealthResponse, health())
      .answerWith("POST /v1/daemon/stop", StopResponse, () => {
        const { daemon } = s;
        setTimeout(() => void daemon.close(), 300);
        return {};
      });
    const begun = Date.now();
    const ran = await s.bazhen(["stop"]);
    expect([ran.code, ran.stdout]).toEqual([0, "bazhen stopped; agents keep running\n"]);
    expect(Date.now() - begun).toBeGreaterThanOrEqual(300);
    const routes = s.daemon.routes();
    expect(routes.slice(0, 2)).toEqual(["GET /v1/health", "POST /v1/daemon/stop"]);
    expect(routes.slice(2).length).toBeGreaterThan(0);
    expect(new Set(routes.slice(2))).toEqual(new Set(["GET /v1/health"]));
  });

  it("says it isn't running, and succeeds: stopping is idempotent", async () => {
    await s.daemon.close();
    const ran = await s.bazhen(["stop"]);
    expect([ran.code, ran.stdout]).toEqual([0, "bazhen is not running\n"]);
  });

  describe.skipIf(process.platform !== "linux")(
    "when a daemon holds the start-up lock and has no socket",
    () => {
      it("waits for the lock to free, then says it stopped", async () => {
        await s.daemon.close();
        const release = await holdLock(s.socket);
        const ran = s.bazhen(["stop"]);
        await sleep(500);
        await release();
        expect(await ran).toEqual({
          code: 0,
          stdout: "bazhen stopped; agents keep running\n",
          stderr: "",
        });
      });

      it("tells the daemon to stop once its socket answers", async () => {
        await s.daemon.close();
        const release = await holdLock(s.socket);
        const ran = s.bazhen(["stop"]);
        await sleep(500);
        const starting = await FakeDaemon.listen(s.socket);
        try {
          starting
            .answer("GET /v1/health", HealthResponse, health())
            .answerWith("POST /v1/daemon/stop", StopResponse, () => {
              setTimeout(() => void starting.close().then(release), 100);
              return {};
            });
          expect(await ran).toEqual({
            code: 0,
            stdout: "bazhen stopped; agents keep running\n",
            stderr: "",
          });
          expect(starting.routes()).toContain("POST /v1/daemon/stop");
        } finally {
          await starting.close();
          await release();
        }
      });

      it("fails once the wait runs out with the lock still held", async () => {
        await s.daemon.close();
        const release = await holdLock(s.socket);
        try {
          const begun = Date.now();
          const ran = await s.bazhen(["stop"]);
          expect(ran).toEqual({
            code: 1,
            stdout: "",
            stderr: `bazhen is stopping or still starting: a daemon holds ${s.socket}.lock but has no socket; try again in a moment\n`,
          });
          expect(Date.now() - begun).toBeGreaterThanOrEqual(5900);
        } finally {
          await release();
        }
      }, 20_000);
    },
  );

  it.skipIf(process.platform !== "linux")(
    "says it stopped only once the daemon lets go of the start-up lock, though its socket is gone",
    async () => {
      const release = await holdLock(s.socket);
      s.daemon
        .answer("GET /v1/health", HealthResponse, health())
        .answerWith("POST /v1/daemon/stop", StopResponse, () => {
          const { daemon } = s;
          setTimeout(() => void daemon.close(), 100);
          return {};
        });
      let finished = Infinity;
      const ran = s.bazhen(["stop"]).then((r) => {
        finished = Date.now();
        return r;
      });
      await sleep(1000);
      const released = Date.now();
      await release();
      expect(await ran).toEqual({
        code: 0,
        stdout: "bazhen stopped; agents keep running\n",
        stderr: "",
      });
      expect(finished).toBeGreaterThanOrEqual(released);
    },
  );

  it.skipIf(process.platform !== "linux")(
    "says it stopped only once the daemon lets go of the start-up lock, though its socket still refuses",
    async () => {
      const release = await holdLock(s.socket);
      const closed = Promise.withResolvers<void>();
      s.daemon
        .answer("GET /v1/health", HealthResponse, health())
        .answerWith("POST /v1/daemon/stop", StopResponse, () => {
          const { daemon, socket } = s;
          closed.resolve(sleep(100).then(() => closeLeavingSocket(daemon, socket)));
          return {};
        });
      let finished = Infinity;
      const ran = s.bazhen(["stop"]).then((r) => {
        finished = Date.now();
        return r;
      });
      await closed.promise;
      await sleep(500);
      const released = Date.now();
      await release();
      expect(await ran).toEqual({
        code: 0,
        stdout: "bazhen stopped; agents keep running\n",
        stderr: "",
      });
      expect(finished).toBeGreaterThanOrEqual(released);
    },
  );

  it.skipIf(process.platform !== "linux")(
    "says it stopped when another daemon answers on the socket before the stopped one lets go of the lock",
    async () => {
      const release = await holdLock(s.socket);
      const closed = Promise.withResolvers<void>();
      s.daemon
        .answer("GET /v1/health", HealthResponse, health())
        .answerWith("POST /v1/daemon/stop", StopResponse, () => {
          const { daemon } = s;
          closed.resolve(sleep(100).then(() => daemon.close()));
          return {};
        });
      const ran = s.bazhen(["stop"]);
      await closed.promise;
      // Only a daemon that takes no start-up lock, as the TypeScript one on macOS, binds while the
      // stopped one still holds it. Its first health goes unanswered, so stop has seen the socket
      // go quiet before anything answers there; else it would take the answer for the stopped one.
      const next = await FakeDaemon.listen(s.socket);
      next.answerAfter("GET /v1/health", 1, HealthResponse, health());
      try {
        expect(await ran).toEqual({
          code: 0,
          stdout: `bazhen stopped; agents keep running\nanother daemon now answers on ${s.socket}\n`,
          stderr: "",
        });
        expect(next.routes()).not.toContain("POST /v1/daemon/stop");
      } finally {
        await next.close();
        await release();
      }
    },
    15_000,
  );

  it("fails when the daemon still answers five seconds after it was told to stop", async () => {
    s.daemon
      .answer("GET /v1/health", HealthResponse, health())
      .answer("POST /v1/daemon/stop", StopResponse, {});
    const ran = await s.bazhen(["stop"]);
    expect([ran.code, ran.stdout, ran.stderr]).toEqual([
      1,
      "",
      "bazhen is still answering after 5 s\n",
    ]);
  }, 15_000);
});

describe("bazhen env refresh", () => {
  it("sends this shell's whole environment, and says what was kept, removed, refused and unchanged", async () => {
    s.daemon.answer("POST /v1/daemon/env", EnvRefreshResponse, {
      capturedAt: "t",
      kept: 12,
      removed: { secrets: 2 },
      refused: ["BAD=NAME"],
      unchanged: [AGENT, OTHER],
    });
    const ran = await s.bazhen(["env", "refresh"], { FOO_TOKEN: "rotated" });
    expect([ran.code, lines(ran.stdout)]).toEqual([
      0,
      [
        "environment refreshed: 12 variables kept; removed: secrets 2",
        "  left as they were (tmux can't take them as data): BAD=NAME",
        "  2 running agents keep their environment until respawned:",
        `    ${AGENT}`,
        `    ${OTHER}`,
        "",
      ],
    ]);
    expect(s.daemon.calls("POST /v1/daemon/env")[0]?.body).toEqual({
      env: expect.objectContaining({ FOO_TOKEN: "rotated", BAZHEN_HOME: s.home }),
    });
  });

  it("says nothing was removed, refused or left unchanged when nothing was", async () => {
    s.daemon.answer("POST /v1/daemon/env", EnvRefreshResponse, {
      capturedAt: "t",
      kept: 3,
      removed: {},
      refused: [],
      unchanged: [],
    });
    const ran = await s.bazhen(["env", "refresh"]);
    expect(ran.stdout).toBe("environment refreshed: 3 variables kept; removed: none\n");
  });

  it("wants refresh after env", async () => {
    const ran = await s.bazhen(["env"]);
    expect([ran.code, ran.stdout, ran.stderr]).toEqual([
      2,
      "",
      expect.stringContaining("usage: bazhen"),
    ]);
  });
});

describe("bazhen devices pair", () => {
  it("shows a code to enter, until when it works, and where to open", async () => {
    s.daemon.answer("POST /v1/pairing/codes", PairingCodeResponse, {
      code: "ABCD2345",
      expiresAt: "2026-11-16T12:05:00.000Z",
      origins: ["https://box.tail.ts.net"],
    });
    const ran = await s.bazhen(["devices", "pair"]);
    const out = lines(ran.stdout);
    expect([ran.code, out[0], out.slice(2)]).toEqual([
      0,
      "pairing code: ABCD-2345",
      ["  open https://box.tail.ts.net", ""],
    ]);
    expect(out[1]).toMatch(/^enter it in the browser to pair; it works once, until \S.*$/);
  });

  it("shows the LAN address and the certificate fingerprint to check before trusting it", async () => {
    s.daemon.answer("POST /v1/pairing/codes", PairingCodeResponse, {
      code: "ABCD2345",
      expiresAt: "2026-11-16T12:05:00.000Z",
      origins: [],
      lan: {
        url: "https://my-mac.local:7942",
        fingerprint: "AB:CD",
        expiresAt: "2029-02-11T00:00:00.000Z",
      },
    });
    const out = lines((await s.bazhen(["devices", "pair"])).stdout);
    expect(out.slice(2, 5)).toEqual([
      "  on the LAN, open https://my-mac.local:7942",
      "  before trusting its certificate, check that its SHA-256 is",
      "    AB:CD",
    ]);
    expect(out[5]).toMatch(/^ {2}\(the certificate lasts until \S+\)$/);
    expect(out.slice(6)).toEqual(["  and if it isn't, don't trust it or pair", ""]);
  });
});

const device = (id: string, name: string, expiresAt: string) => ({
  id,
  name,
  pairedAt: "2026-11-01T00:00:00.000Z",
  lastSeenAt: "2026-11-02T00:00:00.000Z",
  expiresAt,
});

describe("bazhen devices", () => {
  const DEV = "dev_0190c3b2a1d47a3b8c1d2e3f4a5b6c7d";
  const DEV2 = "dev_0190c3b2a1d47a3b8c1d2e3f4a5b6c8d";
  const NTC = "ntc_0190c3b2a1d47a3b8c1d2e3f4a5b6c7d";
  const notice = (deviceId: string, state: "open" | "closed"): Notice => ({
    id: NTC,
    kind: "device_paired",
    state,
    closeReason: null,
    summary: "A device paired",
    openedAt: "2026-11-01T00:00:00.000Z",
    device: { id: deviceId, name: "phone", origin: "https://box.tail.ts.net", address: null },
    actions: ["dismiss"],
    closedBy: null,
    closedFrom: null,
  });

  it("lists paired devices, marking an expired one and a new one, with names made safe to print", async () => {
    s.daemon
      .answer("GET /v1/devices", DevicesResponse, {
        devices: [
          device(DEV, "\u001b[2Jphone​", "2099-01-01T00:00:00.000Z"),
          device(DEV2, "old laptop", "2020-01-01T00:00:00.000Z"),
        ],
      })
      .answer("GET /v1/state", StateSnapshot, snapshot({ notices: [notice(DEV, "open")] }));
    const ran = await s.bazhen(["devices"]);
    expect(lines(ran.stdout)).toEqual([
      `${DEV}  ?[2Jphone?  paired 2026-11-01T00:00:00.000Z, last used 2026-11-02T00:00:00.000Z (new: \`bazhen devices dismiss\` once you know it)`,
      `${DEV2}  old laptop  paired 2026-11-01T00:00:00.000Z, last used 2026-11-02T00:00:00.000Z (expired)`,
      "",
    ]);
  });

  it("says how to pair when none is", async () => {
    s.daemon
      .answer("GET /v1/devices", DevicesResponse, { devices: [] })
      .answer("GET /v1/state", StateSnapshot, snapshot());
    expect((await s.bazhen(["devices"])).stdout).toBe(
      "no paired devices; pair one with `bazhen devices pair`\n",
    );
  });

  it("revokes a device", async () => {
    s.daemon.answer(`POST /v1/devices/${DEV}/revoke`, RevokeDeviceResponse, {});
    const ran = await s.bazhen(["devices", "revoke", DEV]);
    expect([ran.code, ran.stdout]).toEqual([0, `revoked ${DEV}; its open views are closed\n`]);
  });

  it("says the daemon's refusal of a revoke, rather than that the device is revoked", async () => {
    const unknown = { error: "not_found" as const, message: `no device ${DEV}` };
    s.daemon.fail(`POST /v1/devices/${DEV}/revoke`, 404, unknown);
    expect(await s.bazhen(["devices", "revoke", DEV])).toEqual({
      code: 1,
      stdout: "",
      stderr: `/v1/devices/${DEV}/revoke: HTTP 404: ${JSON.stringify(unknown)}\n`,
    });
  });

  it("dismisses a device's open pairing notice, and fails when it has none", async () => {
    s.daemon
      .answer(
        "GET /v1/state",
        StateSnapshot,
        snapshot({
          notices: [
            notice(DEV, "open"),
            { ...notice(DEV2, "closed"), id: "ntc_0190c3b2a1d47a3b8c1d2e3f4a5b6c8d" },
          ],
        }),
      )
      .answer(`POST /v1/notices/${NTC}/dismiss`, DismissNoticeResponse, { eventIds: [4] });
    const dismissed = await s.bazhen(["devices", "dismiss", DEV]);
    const none = await s.bazhen(["devices", "dismiss", DEV2]);
    expect([dismissed.code, dismissed.stdout]).toEqual([
      0,
      `dismissed the pairing notice of ${DEV}\n`,
    ]);
    expect(s.daemon.calls(`POST /v1/notices/${NTC}/dismiss`).map((r) => r.body)).toEqual([
      { idempotencyKey: expect.stringMatching(UUID) },
    ]);
    expect([none.code, none.stdout, none.stderr]).toEqual([
      1,
      "",
      `no open pairing notice for ${DEV2}\n`,
    ]);
  });

  it("wants the device for revoke and dismiss, and refuses another word", async () => {
    const runs = await Promise.all([
      s.bazhen(["devices", "revoke"]),
      s.bazhen(["devices", "dismiss"]),
      s.bazhen(["devices", "forget", DEV]),
    ]);
    expect(runs.map((r) => [r.code, r.stdout, r.stderr.split("\n")[0]])).toEqual([
      [2, "", "usage: bazhen devices revoke <id>"],
      [2, "", "usage: bazhen devices dismiss <id>"],
      [2, "", "devices has no verb forget"],
    ]);
    expect(s.daemon.received).toEqual([]);
  });
});
