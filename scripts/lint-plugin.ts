// Oxlint rules no built-in rule covers, loaded through `jsPlugins` (scripts/lint-config.ts).
//
// `host-guard`: only @bazhen/host-guard runs tmux or sends a signal. Elsewhere, a call whose
// command is tmux, or any `process.kill`, is an error. One wrong socket or pid there ends someone
// else's work, so it is checked in one module and banned everywhere else.

interface Node {
  readonly type: string;
  readonly [key: string]: unknown;
}
interface Context {
  report(problem: { node: Node; message: string }): void;
}

const TMUX =
  "Run tmux only through @bazhen/host-guard (TmuxServer), which names its server by a socket " +
  "path the caller owns (docs/standards/code.md).";
const KILL =
  "Send signals only through @bazhen/host-guard (spawnGroup, signalGroup, signalPane, isAlive) " +
  "(docs/standards/code.md).";

const isNode = (value: unknown): value is Node =>
  typeof value === "object" && value !== null && typeof Reflect.get(value, "type") === "string";

const named = (node: unknown, name: string) =>
  isNode(node) &&
  ((node.type === "Identifier" && node["name"] === name) ||
    (node.type === "Literal" && node["value"] === name));

/** The text an argument starts with, when it is a literal: a string, template or array's first. */
function leadingText(node: unknown): string | undefined {
  if (!isNode(node)) return undefined;
  if (node.type === "Literal" && typeof node["value"] === "string") return node["value"];
  if (node.type === "TemplateLiteral" && Array.isArray(node["quasis"])) {
    const first: unknown = node["quasis"][0];
    const value = isNode(first) ? first["value"] : undefined;
    const raw = typeof value === "object" && value !== null ? Reflect.get(value, "raw") : undefined;
    return typeof raw === "string" ? raw : undefined;
  }
  if (node.type === "ArrayExpression" && Array.isArray(node["elements"])) {
    return leadingText(node["elements"][0]);
  }
  return undefined;
}

export const isTmuxCommand = (text: string | undefined) =>
  text !== undefined && /^tmux(\s|$)/.test(text);

/** What starts a process here: child_process's calls, a PTY's spawn, and a promisified `run`. */
const STARTS = new Set([
  "exec",
  "execSync",
  "execFile",
  "execFileSync",
  "spawn",
  "spawnSync",
  "fork",
  "run",
]);

function startsProcess(callee: unknown): boolean {
  if (!isNode(callee)) return false;
  const name = callee.type === "MemberExpression" ? callee["property"] : callee;
  return isNode(name) && name.type === "Identifier" && STARTS.has(String(name["name"]));
}

const hostGuard = {
  create(context: Context) {
    return {
      MemberExpression(node: Node) {
        if (named(node["object"], "process") && named(node["property"], "kill")) {
          context.report({ node, message: KILL });
        }
      },
      CallExpression(node: Node) {
        const [first] = Array.isArray(node["arguments"]) ? node["arguments"] : [];
        if (startsProcess(node["callee"]) && isTmuxCommand(leadingText(first))) {
          context.report({ node, message: TMUX });
        }
      },
    };
  },
};

export default { meta: { name: "bazhen" }, rules: { "host-guard": hostGuard } };
