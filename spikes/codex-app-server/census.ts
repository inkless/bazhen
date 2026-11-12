// Census: what the installed Codex's protocol declares, and what the probe runs actually saw.
// Usage: node census.ts   (regenerates schema/ from the installed CLI first)
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const schemaDir = join(here, "schema");
// A throwaway CODEX_HOME, so generating the schema never touches the user's.
const codexHome = mkdtempSync("/tmp/bz-spike-census-");
execFileSync("codex", ["app-server", "generate-json-schema", "--out", schemaDir], {
  env: { ...process.env, CODEX_HOME: codexHome },
});
console.log("codex:", execFileSync("codex", ["--version"], { encoding: "utf8" }).trim());

type Variant = { properties?: { method?: { enum?: string[] } } };
const methods = (file: string) =>
  (JSON.parse(readFileSync(join(schemaDir, file), "utf8")) as { oneOf: Variant[] }).oneOf.map(
    (v) => v.properties?.method?.enum?.[0] ?? "?",
  );
const defs = (
  JSON.parse(readFileSync(join(schemaDir, "codex_app_server_protocol.v2.schemas.json"), "utf8")) as {
    definitions: Record<string, unknown>;
  }
).definitions;

const notifications = methods("ServerNotification.json");
const serverRequests = methods("ServerRequest.json");
const clientRequests = methods("ClientRequest.json");
console.log("\nThreadStatus:", JSON.stringify(defs["ThreadStatus"]));
console.log("ThreadActiveFlag:", JSON.stringify(defs["ThreadActiveFlag"]));
console.log("\nserver requests:", serverRequests.join(", "));
const pick = (list: string[], re: RegExp) => list.filter((m) => re.test(m)).join(", ");
console.log("turn/item notifications:", pick(notifications, /^(turn|item)\//));
console.log("usage notifications:", pick(notifications, /tokenUsage|rateLimits/));
console.log("thread client requests:", pick(clientRequests, /^(thread|turn)\//));

const seen = new Map<string, number>();
const statuses = new Map<string, number>();
const runs = join(here, "runs");
for (const file of readdirSync(runs).filter((f) => f.endsWith(".jsonl"))) {
  for (const line of readFileSync(join(runs, file), "utf8").split("\n").filter(Boolean)) {
    const entry = JSON.parse(line) as {
      dir?: string;
      msg?: { method?: string; params?: { status?: { type: string; activeFlags?: string[] } } };
    };
    const method = entry.msg?.method;
    if (entry.dir !== "in" || !method) continue;
    seen.set(method, (seen.get(method) ?? 0) + 1);
    const status = entry.msg?.params?.status;
    if (method === "thread/status/changed" && status) {
      const key = `${status.type}${status.activeFlags?.length ? `[${status.activeFlags.join(",")}]` : ""}`;
      statuses.set(key, (statuses.get(key) ?? 0) + 1);
    }
  }
}
console.log("\nobserved in runs/:");
for (const [method, n] of [...seen].sort()) console.log(`  ${n}\t${method}`);
console.log("observed thread statuses:", Object.fromEntries(statuses));
