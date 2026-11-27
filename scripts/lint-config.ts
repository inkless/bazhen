// Generates .oxlintrc.json from the package import matrix below. Edit the matrix, then run
// `make lint-config`; `make lint` fails when the committed file is stale.
//
// oxlint overrides that match the same file replace each other's `no-restricted-imports`
// instead of merging, so every override repeats its package's full matrix.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isMain } from "./is-main.ts";

export type Area = {
  dir: string;
  banned: string[];
  typeOnly?: string[];
  /** Packages it may import only these subpath exports of, named without the package. */
  onlySubpaths?: Record<string, string[]>;
  platformFree?: boolean;
  thirdParty?: string[];
  /**
   * Its `*.test.ts` are medium tests, as docs/standards/testing.md sizes the directory, so the
   * small-test bans don't apply to them.
   */
  medium?: boolean;
  /** Starts processes only through the helpers in this file, which check their environment. */
  startsProcessesVia?: string;
  /** Libraries it may use only through the wrappers in `via`, which is an area of its own. */
  onlyThrough?: { packages: string[]; via: string };
  /** host-guard modules it may import by path, where the rest go only through the package. */
  hostGuardModules?: string[];
  /** Its `*At` and `*With` forms, which take a clock or replace a check, are for its tests alone. */
  seamsForTestsOnly?: boolean;
  /**
   * The files, under `dir`, that may make a ws WebSocketServer; its other product code upgrades
   * through theirs, which hears each socket before a route serves it.
   */
  webSocketServersIn?: string[];
  /**
   * Its module that alone imports Playwright's `test`, extending it with the teardown every test
   * needs; its other files take `test` from that module.
   */
  playwrightTestIn?: string;
};

const PACKAGE_DIR: Record<string, string> = {
  "@bazhen/protocol": "packages/protocol",
  "@bazhen/core": "packages/core",
  "@bazhen/host-guard": "packages/host-guard",
  "@bazhen/runtime-tmux": "packages/runtime-tmux",
  "@bazhen/runtime-holder": "packages/runtime-holder",
  "@bazhen/env-local": "packages/env-local",
  "@bazhen/harness-claude-code": "packages/harness-claude-code",
  "@bazhen/harness-codex": "packages/harness-codex",
  "@bazhen/daemon": "apps/daemon",
  "@bazhen/web": "apps/web",
};

const RUNTIME_LIBS = ["node-pty", "hono", "@hono/*", "ws", "@xterm/*"];
const WIDGET_LIBS = ["react-aria-components", "react-aria-components/*"];
// The protocol's subpaths the web may import: the zod generated from the Rust protocol, with the
// helpers beside it, and the id its build speaks.
const WEB_PROTOCOL = ["web", "id"];

// tech-stack-and-scaffold.md §3. The single source of the import matrix: docs/standards/code.md
// explains it, and scripts/lint-config.medium.test.ts checks each package.json against it.
export const MATRIX: Area[] = [
  {
    dir: "packages/protocol",
    banned: [
      "@bazhen/core",
      "@bazhen/runtime-tmux",
      "@bazhen/runtime-holder",
      "@bazhen/daemon",
      "@bazhen/web",
    ],
    platformFree: true,
    thirdParty: RUNTIME_LIBS,
  },
  {
    dir: "packages/core",
    banned: ["@bazhen/runtime-tmux", "@bazhen/runtime-holder", "@bazhen/daemon", "@bazhen/web"],
    typeOnly: ["@bazhen/protocol"],
    platformFree: true,
    thirdParty: RUNTIME_LIBS,
  },
  // The one place that runs tmux or sends a signal; it depends on nothing of Bazhen's.
  {
    dir: "packages/host-guard",
    seamsForTestsOnly: true,
    banned: [
      "@bazhen/protocol",
      "@bazhen/core",
      "@bazhen/runtime-tmux",
      "@bazhen/runtime-holder",
      "@bazhen/env-local",
      "@bazhen/harness-claude-code",
      "@bazhen/harness-codex",
      "@bazhen/daemon",
      "@bazhen/web",
    ],
    thirdParty: RUNTIME_LIBS,
  },
  {
    dir: "packages/runtime-tmux",
    banned: ["@bazhen/runtime-holder", "@bazhen/daemon", "@bazhen/web"],
    thirdParty: ["node-pty", "hono", "@hono/*", "ws", "@xterm/*"],
  },
  {
    dir: "packages/runtime-holder",
    banned: ["@bazhen/runtime-tmux", "@bazhen/daemon", "@bazhen/web"],
    thirdParty: RUNTIME_LIBS,
  },
  {
    dir: "packages/env-local",
    banned: [
      "@bazhen/runtime-tmux",
      "@bazhen/runtime-holder",
      "@bazhen/harness-claude-code",
      "@bazhen/harness-codex",
      "@bazhen/daemon",
      "@bazhen/web",
    ],
    typeOnly: ["@bazhen/protocol"],
    platformFree: true,
    thirdParty: RUNTIME_LIBS,
  },
  {
    dir: "packages/harness-claude-code",
    banned: [
      "@bazhen/runtime-tmux",
      "@bazhen/runtime-holder",
      "@bazhen/env-local",
      "@bazhen/harness-codex",
      "@bazhen/daemon",
      "@bazhen/web",
    ],
    typeOnly: ["@bazhen/protocol"],
    platformFree: true,
    thirdParty: RUNTIME_LIBS,
  },
  {
    dir: "packages/harness-codex",
    banned: [
      "@bazhen/runtime-tmux",
      "@bazhen/runtime-holder",
      "@bazhen/env-local",
      "@bazhen/harness-claude-code",
      "@bazhen/daemon",
      "@bazhen/web",
    ],
    typeOnly: ["@bazhen/protocol"],
    platformFree: true,
    thirdParty: RUNTIME_LIBS,
  },
  {
    dir: "apps/daemon",
    banned: ["@bazhen/web"],
    webSocketServersIn: ["src/http/connections.ts", "src/testing/**"],
  },
  // The black-box suite: it reaches the daemon only over its public surfaces. It may use
  // @bazhen/host-guard, a dependency-free safety guard rather than a daemon internal, to run tmux.
  {
    dir: "tests/api",
    banned: [
      "@bazhen/core",
      "@bazhen/runtime-tmux",
      "@bazhen/runtime-holder",
      "@bazhen/env-local",
      "@bazhen/harness-claude-code",
      "@bazhen/harness-codex",
      "@bazhen/daemon",
      "@bazhen/web",
    ],
  },
  // The page against the real daemon: it reaches the daemon over its public surfaces too.
  {
    dir: "tests/e2e",
    playwrightTestIn: "page.ts",
    banned: [
      "@bazhen/core",
      "@bazhen/runtime-tmux",
      "@bazhen/runtime-holder",
      "@bazhen/env-local",
      "@bazhen/harness-claude-code",
      "@bazhen/harness-codex",
      "@bazhen/daemon",
      "@bazhen/web",
    ],
  },
  // Holder tests reach no tmux and no daemon: the holder client and runtime, the shared runtime
  // contract and a browser terminal's replay, and tests/support's home and teardown, are all they
  // use. Teardown uses host-guard for them.
  {
    dir: "tests/holder",
    medium: true,
    startsProcessesVia: "tests/support/holder-spawn.ts",
    onlySubpaths: { "@bazhen/core": ["testing"], "@bazhen/daemon": ["testing"] },
    banned: [
      "@bazhen/host-guard",
      "@bazhen/runtime-tmux",
      "@bazhen/env-local",
      "@bazhen/harness-claude-code",
      "@bazhen/harness-codex",
      "@bazhen/web",
    ],
  },
  // The CLI's black-box suite: the CLI (crates/bazhen) as a process, against a fake daemon on its
  // socket. It reaches the CLI only through its command line.
  {
    dir: "tests/cli",
    medium: true,
    banned: [
      "@bazhen/core",
      "@bazhen/host-guard",
      "@bazhen/runtime-tmux",
      "@bazhen/runtime-holder",
      "@bazhen/env-local",
      "@bazhen/harness-claude-code",
      "@bazhen/harness-codex",
      "@bazhen/daemon",
      "@bazhen/web",
    ],
  },
  {
    dir: "apps/web",
    banned: ["@bazhen/core", "@bazhen/runtime-tmux", "@bazhen/runtime-holder", "@bazhen/daemon"],
    onlySubpaths: { "@bazhen/protocol": WEB_PROTOCOL },
    platformFree: true,
    thirdParty: ["node-pty", "hono", "@hono/*", "ws"],
    onlyThrough: { packages: WIDGET_LIBS, via: "apps/web/src/ui" },
  },
  // After apps/web, whose rule it replaces for these files: the one place widgets are wrapped.
  {
    dir: "apps/web/src/ui",
    banned: ["@bazhen/core", "@bazhen/runtime-tmux", "@bazhen/runtime-holder", "@bazhen/daemon"],
    onlySubpaths: { "@bazhen/protocol": WEB_PROTOCOL },
    platformFree: true,
    thirdParty: ["node-pty", "hono", "@hono/*", "ws"],
  },
  // Repository scripts: Node tools with no package bans, listed so their small tests get the
  // small-test bans. The capped runner and the signal-path rules take host-guard by its index's
  // path, as they run where the workspace's packages may not resolve.
  { dir: "scripts", banned: [], hostGuardModules: ["index.ts"] },
];
// Small tests (`*.test.ts`) run in process with no I/O; anything that needs a file, a database or
// a subprocess is a `*.medium.test.ts`.
const SMALL_TEST_BANS = [
  "fs",
  "fs/promises",
  "os",
  "net",
  "http",
  "https",
  "http2",
  "dgram",
  "tls",
  "child_process",
  "worker_threads",
  "sqlite",
].flatMap((m) => [m, `node:${m}`]);

export type Pattern = {
  group: string[];
  message: string;
  allowTypeImports?: boolean;
  importNamePattern?: string;
};
export type Override = {
  files: string[];
  rules: {
    "import/no-nodejs-modules"?: "error";
    "no-restricted-imports"?: Restriction;
    "bazhen/host-guard"?: "off";
    "bazhen/signal-guard"?: "off";
    "bazhen/stdio-guard"?: "error" | "off";
    "bazhen/ws-loads-statically"?: "error" | "off";
    "no-restricted-globals"?: ["error", ...{ name: string; message: string }[]] | "off";
    "no-restricted-properties"?: ["error", ...{ property: string; message: string }[]] | "off";
  };
};
type Restriction = ["error", { patterns: Pattern[] }];

const STORAGES = ["localStorage", "sessionStorage"];
/** The one module in the web app that reaches the browser's storage. */
export const DEVICE_STORAGE = "apps/web/src/storage.ts";
const STORAGE_MESSAGE =
  `Reach storage only through deviceStorage in ${DEVICE_STORAGE}: with site data blocked, ` +
  "even reading it throws, and a throw while rendering takes the whole page down.";

function packagePatterns(name: string, message: string, allowTypeImports: boolean): Pattern {
  const dir = PACKAGE_DIR[name];
  if (dir === undefined) throw new Error(`unknown package ${name}`);
  const short = dir.split("/")[1] ?? dir;
  const pattern: Pattern = {
    group: [name, `${name}/**`, `**/${dir}/**`, `**/${short}/src/**`],
    message,
  };
  if (allowTypeImports) pattern.allowTypeImports = true;
  return pattern;
}

/**
 * Bans importing host-guard by a module's path, outside host-guard: its modules export forms with
 * seams that can vouch for any pid, which only its index leaves out. Known gaps, accepted: a path
 * with a `./` segment in it, a `.mts` or `.js` specifier for the same file, and a dynamic
 * `import()`, none of which the pattern matches.
 */
function hostGuardByPath(where: string, area?: Area): Pattern {
  const allowed = (area?.hostGuardModules ?? []).map((m) => `!**/host-guard/src/${m}`);
  return {
    group: ["**/host-guard/src/**", ...allowed],
    message: `${where} imports host-guard only as @bazhen/host-guard: its modules export forms with seams that can vouch for any pid.`,
  };
}

/**
 * Bans a module's own seams from its siblings' product code: a `*At` form spends or makes a proof
 * at a time its caller picks, so a stale one passes for fresh, and a `*With` form swaps out the
 * check it exists for. Outside the package, `hostGuardByPath` already keeps them out. Named
 * imports, re-exports, `import * as` and `export *` are all caught, by any relative path. Known
 * gaps, accepted: a dynamic `import()` or `require`, and a seam a module exports under a name
 * without the suffix, none of which the pattern matches.
 */
function seamsPattern(where: string): Pattern {
  return {
    group: ["./**", "../**", "**/host-guard/src/**"],
    importNamePattern: "(?:At|With)$",
    message:
      `${where} imports no *At or *With form of a sibling module: those take a clock or replace ` +
      "a check, for tests only. Call the product form; a helper that only happens to end in At " +
      "or With is renamed, not exempted.",
  };
}

/**
 * Bans making a ws WebSocketServer but in the files an area names: ws reports a frame it refuses
 * as an `error` on the socket, so a server that doesn't hear each one lets any client end the
 * process. Its default export carries the server as `.Server`, so it is banned too.
 */
function webSocketServers(where: string, area: Area): Pattern {
  return {
    group: ["ws"],
    importNamePattern: "^(?:WebSocketServer|default)$",
    message: `${where} makes WebSocket servers only through heardWebSockets in ${area.webSocketServersIn?.[0] ?? "its connections module"}, which hears each socket (docs/standards/code.md).`,
  };
}

/** Files an area exempts from one of its bans, as they're the ones it allows that import in. */
type Exempt = { makesWebSocketServers?: boolean; extendsPlaywrightTest?: boolean };

function restrictions(
  area: Area,
  smallTest: boolean,
  test: boolean,
  exempt: Exempt = {},
): Restriction {
  const where = `${area.dir} (tech-stack-and-scaffold.md §3, docs/standards/code.md)`;
  const patterns: Pattern[] = [
    ...area.banned.map((p) => packagePatterns(p, `${where} must not import ${p}.`, false)),
    ...(area.typeOnly ?? []).map((p) =>
      packagePatterns(p, `${where} may import only types from ${p}.`, true),
    ),
    ...Object.entries(area.onlySubpaths ?? {}).map(([p, allowed]) => {
      const pattern = packagePatterns(
        p,
        `${where} may import from ${p} only ${allowed.map((a) => `${p}/${a}`).join(", ")}.`,
        false,
      );
      return { ...pattern, group: [...pattern.group, ...allowed.map((a) => `!${p}/${a}`)] };
    }),
  ];
  if (area.dir !== "packages/host-guard") patterns.push(hostGuardByPath(where, area));
  if (area.seamsForTestsOnly === true && !test) patterns.push(seamsPattern(where));
  if (area.webSocketServersIn !== undefined && !test && exempt.makesWebSocketServers !== true)
    patterns.push(webSocketServers(where, area));
  if (area.playwrightTestIn !== undefined && exempt.extendsPlaywrightTest !== true) {
    patterns.push({
      group: ["@playwright/test"],
      importNamePattern: "^(?:test|default)$",
      message: `${where} takes \`test\` from ${area.dir}/${area.playwrightTestIn}, whose page stops its routes before the test's context closes.`,
    });
  }
  if (area.thirdParty?.length) {
    patterns.push({
      group: area.thirdParty,
      message: `${where} must not import runtime libraries.`,
    });
  }
  if (area.onlyThrough !== undefined) {
    patterns.push({
      group: area.onlyThrough.packages,
      message: `${where} takes widgets from the wrappers in ${area.onlyThrough.via} (docs/standards/ui.md).`,
    });
  }
  if (area.startsProcessesVia !== undefined) {
    patterns.push({
      // Each of these starts a process: `module` through createRequire, `cluster` by forking,
      // and `worker_threads` by running code given as a string.
      group: [
        "node-pty",
        ...["child_process", "module", "cluster", "worker_threads"].flatMap((m) => [
          m,
          `node:${m}`,
        ]),
      ],
      message: `${where} starts processes only through ${area.startsProcessesVia}, which keeps their environment in the run's home (docs/standards/testing.md).`,
    });
  }
  if (smallTest) {
    patterns.push({
      group: ["node-pty", ...SMALL_TEST_BANS],
      message:
        "A *.test.ts is a small test: no files, sockets, processes or databases. Rename it *.medium.test.ts (docs/standards/testing.md).",
    });
  }
  return ["error", { patterns }];
}

function overrides(): Override[] {
  const areas = MATRIX.flatMap((area): Override[] => {
    const base = area.platformFree ? { "import/no-nodejs-modules": "error" as const } : {};
    // The ban on WebSocketServer reads static imports only, so ws is loaded no other way there.
    const wsLoads = (banned: boolean) =>
      area.webSocketServersIn === undefined
        ? {}
        : { "bazhen/ws-loads-statically": banned ? ("error" as const) : ("off" as const) };
    return [
      {
        files: [`${area.dir}/**/*.ts`, `${area.dir}/**/*.tsx`],
        rules: {
          ...base,
          ...wsLoads(true),
          "no-restricted-imports": restrictions(area, false, false),
        },
      },
      // Before the tests' overrides, so that a test among these files keeps the tests' bans.
      ...(area.webSocketServersIn === undefined
        ? []
        : [
            {
              files: area.webSocketServersIn.map((f) => `${area.dir}/${f}`),
              rules: {
                ...base,
                ...wsLoads(false),
                "no-restricted-imports": restrictions(area, false, false, {
                  makesWebSocketServers: true,
                }),
              },
            },
          ]),
      ...(area.playwrightTestIn === undefined
        ? []
        : [
            {
              files: [`${area.dir}/${area.playwrightTestIn}`],
              rules: {
                ...base,
                ...wsLoads(true),
                "no-restricted-imports": restrictions(area, false, false, {
                  extendsPlaywrightTest: true,
                }),
              },
            },
          ]),
      {
        files: [`${area.dir}/**/*.test.ts`, `${area.dir}/**/*.test.tsx`],
        rules: {
          ...base,
          ...wsLoads(false),
          "no-restricted-imports": restrictions(area, area.medium !== true, true),
        },
      },
      {
        files: [`${area.dir}/**/*.medium.test.ts`],
        rules: {
          ...base,
          ...wsLoads(false),
          "no-restricted-imports": restrictions(area, false, true),
        },
      },
    ];
  });
  // Everything no area covers, tests/support and the root's files among them, gets the ban on
  // host-guard by path; an area's own override, later, replaces it for the area's files.
  const rest: Override = {
    files: ["**/*.ts", "**/*.tsx"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [hostGuardByPath("this file")] }],
    },
  };
  // The one package allowed to run tmux, and within it the one module allowed to send signals.
  return [
    rest,
    ...areas,
    { files: ["packages/host-guard/src/**"], rules: { "bazhen/host-guard": "off" } },
    { files: ["packages/host-guard/src/signal.ts"], rules: { "bazhen/signal-guard": "off" } },
    // Product source only: a test's or a script's child ends with the run it belongs to.
    { files: ["apps/*/src/**", "packages/*/src/**"], rules: { "bazhen/stdio-guard": "error" } },
    {
      files: ["**/*.test.ts", "**/*.test.tsx", "**/testing/**"],
      rules: { "bazhen/stdio-guard": "off" },
    },
    // Bare, and as a property of anything: window, globalThis, self, or destructured.
    {
      files: ["apps/web/src/**"],
      rules: {
        "no-restricted-globals": [
          "error",
          ...STORAGES.map((name) => ({ name, message: STORAGE_MESSAGE })),
        ],
        "no-restricted-properties": [
          "error",
          ...STORAGES.map((property) => ({ property, message: STORAGE_MESSAGE })),
        ],
      },
    },
    {
      files: [DEVICE_STORAGE],
      rules: { "no-restricted-globals": "off", "no-restricted-properties": "off" },
    },
  ];
}

export const config = {
  $schema: "./node_modules/oxlint/configuration_schema.json",
  plugins: ["typescript", "unicorn", "import", "react", "react-hooks", "vitest"],
  jsPlugins: ["./scripts/lint-plugin.ts"],
  categories: { correctness: "error", suspicious: "warn" },
  rules: {
    "typescript/no-floating-promises": "error",
    "typescript/no-misused-promises": "error",
    "typescript/no-explicit-any": "error",
    "typescript/switch-exhaustiveness-check": "error",
    "import/no-cycle": "error",
    // A stylesheet is imported only for its effect; any other module must be used.
    "import/no-unassigned-import": ["warn", { allow: ["**/*.css"] }],
    "vitest/no-focused-tests": "error",
    "vitest/no-disabled-tests": "error",
    "vitest/expect-expect": "error",
    "vitest/no-conditional-expect": "error",
    "vitest/no-conditional-in-test": "error",
    "vitest/no-identical-title": "error",
    "vitest/no-standalone-expect": "error",
    "no-console": "off",
    "react/react-in-jsx-scope": "off",
    "bazhen/host-guard": "error",
    "bazhen/signal-guard": "error",
    "bazhen/stdio-guard": "off",
    "bazhen/ws-loads-statically": "off",
  },
  overrides: overrides(),
  ignorePatterns: ["dist/**", "spikes/**", "**/node_modules/**"],
};

if (isMain(import.meta)) {
  const target = fileURLToPath(new URL("../.oxlintrc.json", import.meta.url));
  const generated = `${JSON.stringify(config, null, 2)}\n`;
  if (process.argv.includes("--check")) {
    if (readFileSync(target, "utf8") !== generated) {
      console.error(".oxlintrc.json is stale: run `make lint-config` and commit the result.");
      process.exit(1);
    }
  } else {
    writeFileSync(target, generated);
  }
}
