// Generates .oxlintrc.json from the package import matrix below. Edit the matrix, then run
// `pnpm lint:config`; `pnpm lint` fails when the committed file is stale.
//
// oxlint overrides that match the same file replace each other's `no-restricted-imports`
// instead of merging, so every override repeats its package's full matrix.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

type Area = {
  dir: string;
  banned: string[];
  typeOnly?: string[];
  platformFree?: boolean;
  thirdParty?: string[];
};

const PACKAGE_DIR: Record<string, string> = {
  "@bazhen/protocol": "packages/protocol",
  "@bazhen/core": "packages/core",
  "@bazhen/runtime-tmux": "packages/runtime-tmux",
  "@bazhen/daemon": "apps/daemon",
  "@bazhen/web": "apps/web",
};

const RUNTIME_LIBS = ["node-pty", "hono", "@hono/*", "ws", "@xterm/*"];

// tech-stack-and-scaffold.md §3.
const MATRIX: Area[] = [
  {
    dir: "packages/protocol",
    banned: ["@bazhen/core", "@bazhen/runtime-tmux", "@bazhen/daemon", "@bazhen/web"],
    platformFree: true,
    thirdParty: RUNTIME_LIBS,
  },
  {
    dir: "packages/core",
    banned: ["@bazhen/runtime-tmux", "@bazhen/daemon", "@bazhen/web"],
    typeOnly: ["@bazhen/protocol"],
    platformFree: true,
    thirdParty: RUNTIME_LIBS,
  },
  {
    dir: "packages/runtime-tmux",
    banned: ["@bazhen/daemon", "@bazhen/web"],
    thirdParty: ["node-pty", "hono", "@hono/*", "ws", "@xterm/*"],
  },
  { dir: "apps/daemon", banned: ["@bazhen/web"] },
  {
    dir: "apps/web",
    banned: ["@bazhen/core", "@bazhen/runtime-tmux", "@bazhen/daemon"],
    platformFree: true,
    thirdParty: ["node-pty", "hono", "@hono/*", "ws"],
  },
];

// Small tests (`*.test.ts`) run in process with no I/O; anything that needs a file, a database or
// a subprocess is a `*.medium.test.ts`.
const SMALL_TEST_BANS = ["fs", "fs/promises", "os", "net", "child_process", "sqlite"].flatMap(
  (m) => [m, `node:${m}`],
);

type Pattern = { group: string[]; message: string; allowTypeImports?: boolean };

function packagePatterns(name: string, message: string, allowTypeImports: boolean): Pattern {
  const dir = PACKAGE_DIR[name];
  if (dir === undefined) throw new Error(`unknown package ${name}`);
  const pattern: Pattern = { group: [name, `${name}/**`, `**/${dir}/**`], message };
  if (allowTypeImports) pattern.allowTypeImports = true;
  return pattern;
}

function restrictions(area: Area, smallTest: boolean): unknown {
  const where = `${area.dir} (tech-stack-and-scaffold.md §3, docs/standards/code.md)`;
  const patterns: Pattern[] = [
    ...area.banned.map((p) => packagePatterns(p, `${where} must not import ${p}.`, false)),
    ...(area.typeOnly ?? []).map((p) =>
      packagePatterns(p, `${where} may import only types from ${p}.`, true),
    ),
  ];
  if (area.thirdParty?.length) {
    patterns.push({
      group: area.thirdParty,
      message: `${where} must not import runtime libraries.`,
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

function overrides(): unknown[] {
  return MATRIX.flatMap((area) => {
    const base = area.platformFree ? { "import/no-nodejs-modules": "error" } : {};
    return [
      {
        files: [`${area.dir}/**/*.ts`, `${area.dir}/**/*.tsx`],
        rules: { ...base, "no-restricted-imports": restrictions(area, false) },
      },
      {
        files: [`${area.dir}/**/*.test.ts`, `${area.dir}/**/*.test.tsx`],
        rules: { ...base, "no-restricted-imports": restrictions(area, true) },
      },
      {
        files: [`${area.dir}/**/*.medium.test.ts`],
        rules: { ...base, "no-restricted-imports": restrictions(area, false) },
      },
    ];
  });
}

const config = {
  $schema: "./node_modules/oxlint/configuration_schema.json",
  plugins: ["typescript", "unicorn", "import", "react", "react-hooks", "vitest"],
  categories: { correctness: "error", suspicious: "warn" },
  rules: {
    "typescript/no-floating-promises": "error",
    "typescript/no-misused-promises": "error",
    "typescript/no-explicit-any": "error",
    "typescript/switch-exhaustiveness-check": "error",
    "import/no-cycle": "error",
    "vitest/no-focused-tests": "error",
    "vitest/no-disabled-tests": "error",
    "vitest/expect-expect": "error",
    "vitest/no-conditional-expect": "error",
    "vitest/no-conditional-in-test": "error",
    "vitest/no-identical-title": "error",
    "vitest/no-standalone-expect": "error",
    "no-console": "off",
    "react/react-in-jsx-scope": "off",
  },
  overrides: overrides(),
  ignorePatterns: ["dist/**", "spikes/**", "**/node_modules/**"],
};

const target = fileURLToPath(new URL("../.oxlintrc.json", import.meta.url));
const generated = `${JSON.stringify(config, null, 2)}\n`;

if (process.argv.includes("--check")) {
  if (readFileSync(target, "utf8") !== generated) {
    console.error(".oxlintrc.json is stale: run `pnpm lint:config` and commit the result.");
    process.exit(1);
  }
} else {
  writeFileSync(target, generated);
}
