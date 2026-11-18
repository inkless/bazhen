// Runs the generated .oxlintrc.json through the real oxlint on fixture files laid out like the
// repository, so the import matrix is checked as oxlint applies it, not just as JSON. Then checks
// that no package.json declares a workspace package its area bans: pnpm lets a package import
// what it declares, so a banned dependency there would contradict the matrix.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MATRIX } from "./lint-config.ts";

const repo = fileURLToPath(new URL("..", import.meta.url));

const FIXTURES: Record<string, string> = {
  "apps/web/src/a.ts":
    'export { a } from "../../../packages/core/src/ids.ts";\n' +
    'export { b } from "../../core/src/ids.ts";\n',
  "apps/daemon/src/b.medium.test.ts":
    'export { readFileSync } from "node:fs";\nexport { web } from "@bazhen/web";\n',
  "packages/core/src/c.test.ts": 'export { readFileSync } from "node:fs";\n',
  "apps/web/src/d.tsx": 'export { Button } from "react-aria-components";\n',
  "apps/web/src/ui/e.tsx": 'export { Button } from "react-aria-components";\n',
  "tests/e2e/h.spec.ts":
    'export { TmuxServer } from "@bazhen/host-guard";\n' +
    'export { sessionName } from "@bazhen/runtime-tmux";\n' +
    'export { isId } from "../../packages/core/src/ids.ts";\n',
  "tests/holder/f.test.ts":
    'export { TmuxServer } from "@bazhen/host-guard";\n' +
    'export { a } from "../../packages/runtime-tmux/src/index.ts";\n' +
    'export { connectHolder } from "@bazhen/runtime-holder";\n',
  "tests/support/i.ts":
    'export { startHolderWith } from "../../packages/host-guard/src/holder.ts";\n',
  "tests/integration/j.ts":
    'export { killHolderAt } from "../../packages/host-guard/src/signal.ts";\n',
  "k.ts": 'export { vouchHolderWith } from "./packages/host-guard/src/holder.ts";\n',
  "scripts/l.ts":
    'export { dieBy } from "../packages/host-guard/src/index.ts";\n' +
    'export { killHolderAt } from "../packages/host-guard/src/signal.ts";\n',
  "packages/host-guard/src/m.ts": 'export { startHolder } from "./holder.ts";\n',
  "packages/host-guard/src/n.ts":
    'export { signalPaneAt } from "./signal.ts";\n' +
    'export { startHolderWith as start } from "./holder";\n',
  "packages/host-guard/src/o.ts": 'import * as signal from "./signal.ts";\nexport { signal };\n',
  "packages/host-guard/src/r.ts": 'export * from "./signal.ts";\n',
  "packages/host-guard/src/s.ts":
    'export { vouchAt } from "../src/signal.ts";\n' +
    'export { killHolderAt } from "../../host-guard/src/signal.ts";\n',
  "packages/host-guard/src/t.ts":
    'export { vouch } from "./signal.ts";\nexport { formatWith } from "node:util";\n',
  "packages/host-guard/src/p.test.ts":
    'export { signalPaneAt } from "./signal.ts";\nexport { vouchHolderWith } from "./holder.ts";\n',
  "packages/host-guard/src/q.medium.test.ts": 'export { killHolderAt } from "./signal.ts";\n',
  "apps/daemon/src/u.ts":
    'export { WebSocketServer } from "ws";\n' +
    'import ws from "ws";\nexport const server = ws.Server;\n' +
    'export type { WebSocket as Socket } from "ws";\n',
  "apps/daemon/src/http/connections.ts": 'export { WebSocketServer } from "ws";\n',
  "apps/daemon/src/testing/v.ts": 'export { WebSocketServer } from "ws";\n',
  "apps/daemon/src/w.medium.test.ts": 'export { WebSocketServer } from "ws";\n',
  "tests/holder/g.test.ts":
    'export { spawn } from "node:child_process";\nexport { spawn as pty } from "node-pty";\n' +
    'export { createRequire } from "node:module";\nexport { fork } from "cluster";\n' +
    'export { Worker } from "node:worker_threads";\n',
};

type Diagnostic = { code?: string; filename?: string };

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bz-lint-config-"));
  for (const [file, text] of Object.entries(FIXTURES)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
  const config: Record<string, unknown> = JSON.parse(
    readFileSync(join(repo, ".oxlintrc.json"), "utf8"),
  );
  delete config["$schema"];
  // A plugin path is relative to the config, which moves here.
  const plugins = config["jsPlugins"];
  if (Array.isArray(plugins)) config["jsPlugins"] = plugins.map((p) => join(repo, String(p)));
  writeFileSync(join(dir, ".oxlintrc.json"), JSON.stringify(config));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Rule codes oxlint reports for each fixture file, sorted. */
function ruleHits(): Record<string, string[]> {
  const out = spawnSync(
    join(repo, "node_modules/.bin/oxlint"),
    ["-c", ".oxlintrc.json", "--format", "json", ...Object.keys(FIXTURES)],
    { cwd: dir, encoding: "utf8" },
  );
  const parsed: { diagnostics: Diagnostic[] } = JSON.parse(out.stdout);
  const hits: Record<string, string[]> = Object.fromEntries(
    Object.keys(FIXTURES).map((file) => [file, []]),
  );
  for (const d of parsed.diagnostics) (hits[d.filename ?? "?"] ??= []).push(d.code ?? "?");
  return Object.fromEntries(Object.entries(hits).map(([file, codes]) => [file, codes.toSorted()]));
}

describe("the generated oxlint config, run by oxlint", () => {
  it("enforces the import matrix and the small-test bans by path", () => {
    expect(ruleHits()).toEqual({
      "apps/web/src/a.ts": ["eslint(no-restricted-imports)", "eslint(no-restricted-imports)"],
      "apps/daemon/src/b.medium.test.ts": ["eslint(no-restricted-imports)"],
      "packages/core/src/c.test.ts": ["eslint(no-restricted-imports)", "import(no-nodejs-modules)"],
      "apps/web/src/d.tsx": ["eslint(no-restricted-imports)"],
      "apps/web/src/ui/e.tsx": [],
      "tests/e2e/h.spec.ts": ["eslint(no-restricted-imports)", "eslint(no-restricted-imports)"],
      "tests/holder/f.test.ts": ["eslint(no-restricted-imports)", "eslint(no-restricted-imports)"],
      // The re-export of `spawn` hands a start to files the tmux guard can't read it in.
      "tests/holder/g.test.ts": [
        "bazhen(host-guard)",
        ...Array(5).fill("eslint(no-restricted-imports)"),
      ],
      "tests/support/i.ts": ["eslint(no-restricted-imports)"],
      "tests/integration/j.ts": ["eslint(no-restricted-imports)"],
      "k.ts": ["eslint(no-restricted-imports)"],
      "scripts/l.ts": ["eslint(no-restricted-imports)"],
      "packages/host-guard/src/m.ts": [],
      // A clock or a check swapped out is for host-guard's tests, never its product modules.
      "packages/host-guard/src/n.ts": [
        "eslint(no-restricted-imports)",
        "eslint(no-restricted-imports)",
      ],
      "packages/host-guard/src/o.ts": ["eslint(no-restricted-imports)"],
      "packages/host-guard/src/r.ts": ["eslint(no-restricted-imports)"],
      "packages/host-guard/src/s.ts": [
        "eslint(no-restricted-imports)",
        "eslint(no-restricted-imports)",
      ],
      "packages/host-guard/src/t.ts": [],
      "packages/host-guard/src/p.test.ts": [],
      "packages/host-guard/src/q.medium.test.ts": [],
      // A WebSocket server is made only where each socket is heard, and in tests.
      "apps/daemon/src/u.ts": ["eslint(no-restricted-imports)", "eslint(no-restricted-imports)"],
      "apps/daemon/src/http/connections.ts": [],
      "apps/daemon/src/testing/v.ts": [],
      "apps/daemon/src/w.medium.test.ts": [],
    });
  });
});

const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "peerDependencies"] as const;

type Manifest = Partial<Record<(typeof DEPENDENCY_FIELDS)[number], Record<string, string>>>;

/** For each matrix area that has a package.json, the banned packages it declares. */
function bannedDeclarations(): Record<string, string[]> {
  return Object.fromEntries(
    MATRIX.filter((area) => existsSync(join(repo, area.dir, "package.json"))).map((area) => {
      const manifest: Manifest = JSON.parse(
        readFileSync(join(repo, area.dir, "package.json"), "utf8"),
      );
      const declared = DEPENDENCY_FIELDS.flatMap((field) => Object.keys(manifest[field] ?? {}));
      return [area.dir, declared.filter((name) => area.banned.includes(name))];
    }),
  );
}

describe("each package.json, against the import matrix", () => {
  it("declares no workspace package that its area bans", () => {
    expect(bannedDeclarations()).toEqual({
      "packages/protocol": [],
      "packages/core": [],
      "packages/host-guard": [],
      "packages/runtime-tmux": [],
      "packages/runtime-holder": [],
      "packages/env-local": [],
      "packages/harness-claude-code": [],
      "packages/harness-codex": [],
      "apps/daemon": [],
      "apps/web": [],
      "tests/api": [],
      "tests/e2e": [],
      "tests/holder": [],
      "tests/cli": [],
    });
  });
});
