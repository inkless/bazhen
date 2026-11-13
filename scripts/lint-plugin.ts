// Oxlint rules no built-in rule covers, loaded through `jsPlugins` (scripts/lint-config.ts).
//
// `host-guard`: only @bazhen/host-guard runs tmux or sends a signal. Elsewhere a process-starting
// call that runs tmux, by name, path, argv or shell string, and any way of reaching `kill` on
// `process`, is an error. One wrong socket or pid ends someone else's work, so it is checked in
// one module and banned everywhere else. The rule follows what a file binds: import aliases,
// namespace imports, `promisify` and constants. It can flag an argument that merely says `tmux`
// to a tool that isn't tmux; rename the argument or move the call into host-guard.

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
  "Send signals only through @bazhen/host-guard (spawnGroup, signalGroup, signalPane, " +
  "TmuxServer.recreateSocket, isAlive) " +
  "(docs/standards/code.md).";

/** child_process's process-starting calls, and the names wrappers of them go by here. */
const STARTS = new Set([
  "exec",
  "execSync",
  "execFile",
  "execFileSync",
  "spawn",
  "spawnSync",
  "fork",
  "run",
  // host-guard's own process starts: none of them can be pointed at tmux either.
  "spawnGroup",
  "runBounded",
  "runNotifier",
]);
const CHILD_PROCESS = new Set(["child_process", "node:child_process"]);
const PROCESS = new Set(["process", "node:process"]);
const GLOBALS = new Set(["globalThis", "global", "window", "self"]);

const isNode = (value: unknown): value is Node =>
  typeof value === "object" && value !== null && typeof Reflect.get(value, "type") === "string";
const nodes = (value: unknown): Node[] => (Array.isArray(value) ? value.filter(isNode) : []);
const nameOf = (node: unknown): string | undefined => {
  if (!isNode(node)) return undefined;
  if (node.type === "Identifier") return String(node["name"]);
  if (node.type === "Literal" && typeof node["value"] === "string") return node["value"];
  return undefined;
};

/** A command that runs tmux: its basename, or `tmux` as a word in a shell string. */
export const runsTmux = (text: string) =>
  text.split("/").at(-1) === "tmux" || /(^|[\s;&|`(/])tmux(\s|$|[;&|)`])/.test(text);

const hostGuard = {
  create(context: Context) {
    const starts = new Set(STARTS);
    const childProcess = new Set<string>();
    const processes = new Set(["process"]);
    const constants = new Map<string, Node>();

    /** The strings an argument holds: itself, a constant's value, or an array's elements. */
    const strings = (node: unknown, depth = 0): string[] => {
      if (!isNode(node) || depth > 3) return [];
      if (node.type === "Literal" && typeof node["value"] === "string") return [node["value"]];
      if (node.type === "TemplateLiteral") {
        return [
          nodes(node["quasis"])
            .map((q) => String(Reflect.get(Object(q["value"]), "raw")))
            .join(" "),
        ];
      }
      if (node.type === "ArrayExpression")
        return nodes(node["elements"]).flatMap((e) => strings(e, depth + 1));
      if (node.type === "Identifier")
        return strings(constants.get(String(node["name"])), depth + 1);
      return [];
    };

    const isProcess = (node: unknown): boolean =>
      isNode(node) &&
      ((node.type === "Identifier" && processes.has(String(node["name"]))) ||
        (node.type === "MemberExpression" &&
          GLOBALS.has(nameOf(node["object"]) ?? "") &&
          nameOf(node["property"]) === "process"));

    /** The call's real arguments if its callee starts a process, else undefined. */
    function startArguments(callee: unknown, args: Node[]): Node[] | undefined {
      if (!isNode(callee)) return undefined;
      if (callee.type === "Identifier")
        return starts.has(String(callee["name"])) ? args : undefined;
      if (callee.type !== "MemberExpression") return undefined;
      const property = nameOf(callee["property"]);
      if (property === "call") return startArguments(callee["object"], args.slice(1));
      if (property === "apply") {
        return startArguments(callee["object"], nodes(isNode(args[1]) ? args[1]["elements"] : []));
      }
      const object = nameOf(callee["object"]);
      return STARTS.has(property ?? "") ||
        (object !== undefined && childProcess.has(object) && property !== undefined)
        ? args
        : undefined;
    }

    return {
      ImportDeclaration(node: Node) {
        const source = isNode(node["source"]) ? String(node["source"]["value"]) : "";
        for (const spec of nodes(node["specifiers"])) {
          const local = nameOf(spec["local"]) ?? "";
          const imported = nameOf(spec["imported"]);
          if (CHILD_PROCESS.has(source)) {
            if (spec.type === "ImportSpecifier" && imported !== undefined) {
              if (STARTS.has(imported)) starts.add(local);
            } else childProcess.add(local);
          }
          if (PROCESS.has(source)) {
            if (spec.type === "ImportSpecifier" && imported === "kill")
              context.report({ node: spec, message: KILL });
            else if (spec.type !== "ImportSpecifier") processes.add(local);
          }
        }
      },
      VariableDeclarator(node: Node) {
        const id = node["id"];
        const init = node["init"];
        if (!isNode(id) || !isNode(init)) return;
        if (id.type === "Identifier") {
          const name = String(id["name"]);
          if (["Literal", "TemplateLiteral", "ArrayExpression"].includes(init.type))
            constants.set(name, init);
          if (init.type === "Identifier" && starts.has(String(init["name"]))) starts.add(name);
          if (init.type === "CallExpression" && nameOf(init["callee"]) === "promisify") {
            if (nodes(init["arguments"]).some((a) => starts.has(nameOf(a) ?? ""))) starts.add(name);
          }
          if (isProcess(init)) processes.add(name);
        }
        if (id.type === "ObjectPattern" && isProcess(init)) {
          const keys = nodes(id["properties"]).map((p) => nameOf(p["key"]));
          if (keys.includes("kill")) context.report({ node, message: KILL });
        }
      },
      MemberExpression(node: Node) {
        if (isProcess(node["object"]) && nameOf(node["property"]) === "kill") {
          context.report({ node, message: KILL });
        }
      },
      CallExpression(node: Node) {
        const args = startArguments(node["callee"], nodes(node["arguments"]));
        if (args?.flatMap((a) => strings(a)).some(runsTmux))
          context.report({ node, message: TMUX });
      },
    };
  },
};

export default { meta: { name: "bazhen" }, rules: { "host-guard": hostGuard } };
