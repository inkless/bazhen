// Oxlint rules no built-in rule covers, loaded through `jsPlugins` (scripts/lint-config.ts).
//
// `host-guard`: only @bazhen/host-guard runs tmux; elsewhere a process-starting call that runs
// tmux, by name, path, argv or shell string, is an error. `signal-guard`: only host-guard's
// signal.ts sends a signal; elsewhere, host-guard's other modules included, any way of reaching
// `kill` or `abort` on `process` is an error. One wrong socket or pid ends someone else's work, so each is
// checked in one place and banned everywhere else. The rule follows what a file binds: import aliases,
// namespace imports, `promisify` and constants. It can flag an argument that merely says `tmux`
// to a tool that isn't tmux; rename the argument or move the call into host-guard. A start it
// can't read the argv of is an error too: one imported from child_process or host-guard used
// other than as a call (`Reflect.apply`, a seam object, an export), and either module loaded other
// than by a static import (`require`, `import()`, a re-export). `stdio-guard`: in product source,
// each async child_process start is wrapped in host-guard's `heard()` where it is made.

import { CHILD_PROCESS_MODULES, CHILD_PROCESS_STARTS } from "./child-process.ts";

interface Node {
  readonly type: string;
  readonly [key: string]: unknown;
}
interface Reference {
  readonly identifier: Node;
  isWrite(): boolean;
  isRead(): boolean;
}
interface Variable {
  readonly references: readonly Reference[];
}
interface Context {
  report(problem: { node: Node; message: string }): void;
  readonly sourceCode: { getDeclaredVariables(node: Node): readonly Variable[] };
}

const TMUX =
  "Run tmux only through @bazhen/host-guard (TmuxServer), which names its server by a socket " +
  "path the caller owns (docs/standards/code.md).";
const KILL =
  "Send signals only through @bazhen/host-guard (spawnGroup, signalGroup, signalOwnChild, " +
  "signalPane, TmuxServer.recreateSocket, isAlive) " +
  "(docs/standards/code.md).";
const UNFOLLOWED =
  "Call a process start by its name, or as a member of its module imported statically, so this " +
  "rule can read whether it runs tmux; run tmux only through @bazhen/host-guard " +
  "(docs/standards/code.md).";

/** host-guard's own process starts: none of them can be pointed at tmux either. */
const HOST_GUARD_STARTS = new Set([
  "spawnGroup",
  "runBounded",
  "runIn",
  "runInScope",
  "runWatched",
  "runOwned",
  "runThrough",
  "linuxNotifier",
  "macNotifier",
]);
const CHILD_PROCESS_STARTERS = new Set<string>(CHILD_PROCESS_STARTS);
/** Process-starting calls, and the names wrappers of them go by here. */
const STARTS = new Set([...CHILD_PROCESS_STARTERS, "run", ...HOST_GUARD_STARTS]);
const CHILD_PROCESS = new Set<string>(CHILD_PROCESS_MODULES);
/** host-guard by its package, a subpath of it, or a relative path into its sources. */
const isHostGuard = (source: string) =>
  source === "@bazhen/host-guard" ||
  source.startsWith("@bazhen/host-guard/") ||
  (source.startsWith(".") && /(?:^|\/)host-guard\/src(?:\/|$)/.test(source));
/** The starts a module exports, if it is child_process or host-guard. */
const startsOf = (source: string): ReadonlySet<string> | undefined =>
  CHILD_PROCESS.has(source)
    ? CHILD_PROCESS_STARTERS
    : isHostGuard(source)
      ? HOST_GUARD_STARTS
      : undefined;
const PROCESS = new Set(["process", "node:process"]);
const GLOBALS = new Set(["globalThis", "global", "window", "self"]);
/** What on `process` sends a signal: `kill` and `_kill` to any pid, `abort` SIGABRT to this one. */
const SENDS = new Set(["kill", "_kill", "abort"]);

const isNode = (value: unknown): value is Node =>
  typeof value === "object" && value !== null && typeof Reflect.get(value, "type") === "string";
const nodes = (value: unknown): Node[] => (Array.isArray(value) ? value.filter(isNode) : []);
const nameOf = (node: unknown): string | undefined => {
  if (!isNode(node)) return undefined;
  if (node.type === "Identifier") return String(node["name"]);
  if (node.type === "Literal" && typeof node["value"] === "string") return node["value"];
  return undefined;
};
const parentOf = (node: Node): Node | undefined => {
  const parent = node["parent"];
  return isNode(parent) ? parent : undefined;
};
/** A member's name: its property's, or a computed key's that is a string literal. */
const memberName = (member: Node): string | undefined => {
  const property = member["property"];
  if (member["computed"] !== true) return nameOf(property);
  return isNode(property) && property.type === "Literal" ? nameOf(property) : undefined;
};
/** A callee's name: a function's, or a method's. */
const calleeName = (callee: unknown): string | undefined =>
  isNode(callee) && callee.type === "MemberExpression" ? memberName(callee) : nameOf(callee);
const isPromisify = (callee: unknown) => calleeName(callee) === "promisify";
const isCreateRequire = (init: Node) =>
  init.type === "CallExpression" && calleeName(init["callee"]) === "createRequire";
/** Whether `node` is the callee of a call, or the object of a `.call` or `.apply` that is called. */
const isCalled = (node: Node): boolean => {
  const parent = parentOf(node);
  if (parent?.type === "CallExpression") return parent["callee"] === node;
  if (parent?.type !== "MemberExpression" || parent["object"] !== node) return false;
  const name = memberName(parent);
  return (
    (name === "call" || name === "apply") &&
    parentOf(parent)?.type === "CallExpression" &&
    parentOf(parent)?.["callee"] === parent
  );
};

/**
 * Whether `id` is read for its type alone: a `typeof`, or a type named through it, as in
 * `cp.SpawnOptions`. `import ef = cp.execFile` is qualified too, but binds the start.
 */
const isTypeOf = (id: Node): boolean => {
  let parent = parentOf(id);
  if (parent?.type === "UnaryExpression" && parent["operator"] === "typeof") return true;
  while (parent?.type === "TSQualifiedName") parent = parentOf(parent);
  return parent?.type === "TSTypeQuery" || parent?.type === "TSTypeReference";
};

/** The `const x = <id>` or `const x = promisify(<id>)` binding `x` to what `id` starts, if any. */
const aliasing = (id: Node): Node | undefined => {
  const parent = parentOf(id);
  const init = parent?.type === "CallExpression" && isPromisify(parent["callee"]) ? parent : id;
  const declarator = parentOf(init);
  return declarator?.type === "VariableDeclarator" &&
    declarator["init"] === init &&
    isNode(declarator["id"]) &&
    declarator["id"].type === "Identifier"
    ? declarator
    : undefined;
};
const isExported = (declarator: Node) => {
  const declaration = parentOf(declarator);
  return declaration !== undefined && parentOf(declaration)?.type === "ExportNamedDeclaration";
};

/** An `.apply`'s arguments not written as an array, read as a spread of them. */
const UNLISTED: Node = { type: "SpreadElement" };

/** A command that runs tmux: its basename, or `tmux` as a word in a shell string. */
export const runsTmux = (text: string) =>
  text.split("/").at(-1) === "tmux" || /(^|[\s;&|`(/])tmux(\s|$|[;&|)`])/.test(text);

/** A rule reporting tmux runs, kill calls, or both: tmux and signals are guarded apart. */
const guard = (reports: { tmux: boolean; signals: boolean }) => ({
  create(context: Context) {
    const starts = new Set(STARTS);
    const childProcess = new Set<string>();
    const hostGuards = new Set<string>();
    const processes = new Set(["process"]);
    const constants = new Map<string, Node>();
    /** Names a call of which loads the module its first argument names. */
    const loaders = new Set(["require"]);
    const declarators: { name: string; init: Node }[] = [];
    const calls: Node[] = [];
    /** What this file exports, each with the value it exports, read once every alias is known. */
    const exports: { node: Node; value: unknown }[] = [];
    /** The variables a start or a module whole is bound to, with the starts that module has. */
    const bound: { variable: Variable; starters?: ReadonlySet<string> }[] = [];
    const seen = new Set<Variable>();
    const bind = (node: Node, starters?: ReadonlySet<string>) => {
      for (const variable of context.sourceCode.getDeclaredVariables(node)) {
        if (!seen.has(variable)) {
          seen.add(variable);
          bound.push(starters === undefined ? { variable } : { variable, starters });
        }
      }
    };
    const unfollowed = (node: Node) => {
      if (reports.tmux) context.report({ node, message: UNFOLLOWED });
    };

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
    const namesModule = (node: unknown) => strings(node).some((s) => startsOf(s) !== undefined);

    const isProcess = (node: unknown): boolean =>
      isNode(node) &&
      ((node.type === "Identifier" && processes.has(String(node["name"]))) ||
        (node.type === "MemberExpression" &&
          GLOBALS.has(nameOf(node["object"]) ?? "") &&
          nameOf(node["property"]) === "process"));

    /**
     * How a callee starts a process, if it does: `known` a start by its name, or as a member of
     * child_process or host-guard imported whole; `named` a member of anything else named like
     * one, as a PTY's `spawn` or a statement's `run` is.
     */
    function startKind(callee: Node): "known" | "named" | undefined {
      if (callee.type === "Identifier")
        return starts.has(String(callee["name"])) ? "known" : undefined;
      if (callee.type !== "MemberExpression") return undefined;
      const property = nameOf(callee["property"]);
      const object = nameOf(callee["object"]) ?? "";
      if (property === undefined) return undefined;
      if (childProcess.has(object) || (hostGuards.has(object) && STARTS.has(property)))
        return "known";
      return STARTS.has(property) ? "named" : undefined;
    }

    /**
     * The call's real arguments if its callee starts a process, else undefined; `"unread"` where
     * a known start's can't all be read: one spread, or `.apply`'s not written as an array.
     */
    function startArguments(callee: unknown, args: Node[]): Node[] | "unread" | undefined {
      if (!isNode(callee)) return undefined;
      if (callee.type === "MemberExpression") {
        const property = nameOf(callee["property"]);
        if (property === "call") return startArguments(callee["object"], args.slice(1));
        if (property === "apply") {
          const list = args[1];
          const listed = list === undefined || list.type === "ArrayExpression";
          return startArguments(callee["object"], listed ? nodes(list?.["elements"]) : [UNLISTED]);
        }
      }
      const kind = startKind(callee);
      if (kind === undefined) return undefined;
      return kind === "known" && args.some((a) => a.type === "SpreadElement") ? "unread" : args;
    }

    /** Whether a call loads a module: by `require`, a loader's name or result, or a member. */
    const loads = (callee: unknown) =>
      isNode(callee) &&
      ((callee.type === "Identifier" && loaders.has(String(callee["name"]))) ||
        callee.type === "CallExpression" ||
        (callee.type === "MemberExpression" &&
          ["require", "getBuiltinModule"].includes(calleeName(callee) ?? "")));

    /** Each alias, `promisify` or loader a declarator binds, to a fixpoint: order doesn't matter. */
    function resolveNames() {
      for (let grew = true; grew;) {
        grew = false;
        for (const { name, init } of declarators) {
          const start =
            (init.type === "Identifier" && starts.has(String(init["name"]))) ||
            (init.type === "CallExpression" &&
              isPromisify(init["callee"]) &&
              nodes(init["arguments"]).some((a) => starts.has(nameOf(a) ?? "")));
          if (start && !starts.has(name)) grew = Boolean(starts.add(name));
          const loader =
            (init.type === "Identifier" && loaders.has(String(init["name"]))) ||
            isCreateRequire(init);
          if (loader && !loaders.has(name)) grew = Boolean(loaders.add(name));
        }
      }
    }

    /**
     * Each reference to a bound start that isn't a call, a `typeof`, or the alias or `promisify`
     * binding it, whose own references are then followed; each to a bound module but as a member,
     * a start or `default` of which must be called.
     */
    function followReferences() {
      for (const { variable, starters } of bound) {
        for (const reference of variable.references) {
          const id = reference.identifier;
          const parent = parentOf(id);
          if ((reference.isWrite() && !reference.isRead()) || parent === undefined) continue;
          if (isTypeOf(id)) continue;
          if (starters !== undefined) {
            const name =
              parent.type === "MemberExpression" && parent["object"] === id
                ? memberName(parent)
                : undefined;
            const start = name !== undefined && (starters.has(name) || name === "default");
            if (name === undefined || (start && !isCalled(parent))) unfollowed(id);
            continue;
          }
          if (isCalled(id)) continue;
          const declarator = aliasing(id);
          // Exported, it is called in files that don't bind it, where no call of it is read.
          if (declarator === undefined || isExported(declarator)) unfollowed(declarator ?? id);
          else bind(declarator);
        }
      }
    }

    return {
      ImportDeclaration(node: Node) {
        const source = isNode(node["source"]) ? String(node["source"]["value"]) : "";
        const starters = startsOf(source);
        for (const spec of nodes(node["specifiers"])) {
          const local = nameOf(spec["local"]) ?? "";
          const imported = nameOf(spec["imported"]);
          const named = spec.type === "ImportSpecifier" && imported !== "default";
          if (CHILD_PROCESS.has(source)) {
            if (named && imported !== undefined) {
              if (STARTS.has(imported)) starts.add(local);
            } else childProcess.add(local);
          }
          if (
            starters !== undefined &&
            node["importKind"] !== "type" &&
            spec["importKind"] !== "type" &&
            (!named || starters.has(imported ?? ""))
          ) {
            bind(spec, named ? undefined : starters);
            if (named) starts.add(local);
          }
          if (isHostGuard(source) && !named) hostGuards.add(local);
          if (PROCESS.has(source)) {
            if (spec.type === "ImportSpecifier" && SENDS.has(imported ?? "")) {
              if (reports.signals) context.report({ node: spec, message: KILL });
            } else if (!named) {
              processes.add(local);
            }
          }
        }
      },
      ImportExpression(node: Node) {
        if (namesModule(node["source"])) unfollowed(node);
      },
      TSImportEqualsDeclaration(node: Node) {
        const reference = node["moduleReference"];
        if (
          node["importKind"] !== "type" &&
          isNode(reference) &&
          reference.type === "TSExternalModuleReference" &&
          namesModule(reference["expression"])
        ) {
          unfollowed(node);
        }
      },
      ExportAllDeclaration(node: Node) {
        const source = isNode(node["source"]) ? String(node["source"]["value"]) : "";
        if (node["exportKind"] !== "type" && startsOf(source) !== undefined) unfollowed(node);
        if (reports.signals && node["exportKind"] !== "type" && PROCESS.has(source))
          context.report({ node, message: KILL });
      },
      ExportDefaultDeclaration(node: Node) {
        exports.push({ node, value: node["declaration"] });
      },
      TSExportAssignment(node: Node) {
        exports.push({ node, value: node["expression"] });
      },
      ExportNamedDeclaration(node: Node) {
        const source = isNode(node["source"]) ? String(node["source"]["value"]) : "";
        const starters = startsOf(source);
        for (const spec of nodes(node["specifiers"])) {
          const local = nameOf(spec["local"]) ?? "";
          if (reports.signals && PROCESS.has(source) && (SENDS.has(local) || local === "default"))
            context.report({ node: spec, message: KILL });
          if (!isNode(node["source"]) && node["exportKind"] !== "type")
            exports.push({ node: spec, value: spec["local"] });
          if (
            starters !== undefined &&
            node["exportKind"] !== "type" &&
            spec["exportKind"] !== "type" &&
            (starters.has(local) || local === "default")
          ) {
            unfollowed(spec);
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
          declarators.push({ name, init });
          if (isProcess(init)) processes.add(name);
          if (isExported(node)) exports.push({ node, value: init });
        }
        if (id.type === "ObjectPattern" && isProcess(init)) {
          const keys = nodes(id["properties"]).map((p) => nameOf(p["key"]));
          if (keys.some((k) => SENDS.has(k ?? "")) && reports.signals)
            context.report({ node, message: KILL });
        }
      },
      MemberExpression(node: Node) {
        if (
          reports.signals &&
          isProcess(node["object"]) &&
          SENDS.has(nameOf(node["property"]) ?? "")
        ) {
          context.report({ node, message: KILL });
        }
      },
      CallExpression(node: Node) {
        calls.push(node);
      },
      "Program:exit"() {
        resolveNames();
        for (const node of calls) {
          const args = nodes(node["arguments"]);
          const started = startArguments(node["callee"], args);
          if (started === "unread") unfollowed(node);
          else if (reports.tmux && started?.flatMap((a) => strings(a)).some(runsTmux))
            context.report({ node, message: TMUX });
          if (loads(node["callee"]) && namesModule(args[0])) unfollowed(node);
        }
        if (reports.tmux) followReferences();
        // Exported, process is reached in files that don't bind it, where no kill on it is read.
        for (const { node, value } of exports)
          if (reports.signals && isProcess(value)) context.report({ node, message: KILL });
      },
    };
  },
});

const UNHEARD =
  "Wrap a child_process start in heard() from @bazhen/host-guard where it is made, so a stdio " +
  "stream that breaks can't end this process (docs/standards/code.md).";
/** The starts that return a child with streams: the sync ones return when the child has gone. */
const ASYNC_STARTS = new Set(["spawn", "exec", "execFile", "fork"]);

/**
 * `stdio-guard`: each async child_process start, by its name, an import alias, a `promisify` of
 * it, or a member of child_process imported whole, is called as the one argument of `heard(`.
 * A child's stdio streams are sockets this process holds, and one that fails with no listener
 * throws out of the event loop. A start reached other than by a call is `host-guard`'s to flag.
 */
const stdioGuard = {
  create(context: Context) {
    const starts = new Set<string>();
    const modules = new Set<string>();
    const declarators: { name: string; init: Node }[] = [];
    const calls: Node[] = [];
    /** Whether `node` names an async start: a bound name, or a member of child_process whole. */
    const isStart = (node: unknown): boolean =>
      isNode(node) &&
      ((node.type === "Identifier" && starts.has(String(node["name"]))) ||
        (node.type === "MemberExpression" &&
          modules.has(nameOf(node["object"]) ?? "") &&
          ASYNC_STARTS.has(memberName(node) ?? "")));
    const isHeard = (call: Node) => {
      const parent = parentOf(call);
      return (
        parent?.type === "CallExpression" &&
        calleeName(parent["callee"]) === "heard" &&
        nodes(parent["arguments"]).length === 1 &&
        nodes(parent["arguments"])[0] === call
      );
    };
    return {
      ImportDeclaration(node: Node) {
        const source = isNode(node["source"]) ? String(node["source"]["value"]) : "";
        if (!CHILD_PROCESS.has(source) || node["importKind"] === "type") return;
        for (const spec of nodes(node["specifiers"])) {
          const local = nameOf(spec["local"]) ?? "";
          const imported = nameOf(spec["imported"]);
          if (spec.type !== "ImportSpecifier" || imported === "default") modules.add(local);
          else if (spec["importKind"] !== "type" && ASYNC_STARTS.has(imported ?? ""))
            starts.add(local);
        }
      },
      VariableDeclarator(node: Node) {
        const id = node["id"];
        const init = node["init"];
        if (isNode(id) && id.type === "Identifier" && isNode(init))
          declarators.push({ name: String(id["name"]), init });
      },
      CallExpression(node: Node) {
        calls.push(node);
      },
      "Program:exit"() {
        for (let grew = true; grew;) {
          grew = false;
          for (const { name, init } of declarators) {
            const start =
              isStart(init) ||
              (init.type === "CallExpression" &&
                isPromisify(init["callee"]) &&
                nodes(init["arguments"]).some(isStart));
            if (start && !starts.has(name)) grew = Boolean(starts.add(name));
          }
        }
        for (const call of calls)
          if (isStart(call["callee"]) && !isHeard(call))
            context.report({ node: call, message: UNHEARD });
      },
    };
  },
};

export default {
  meta: { name: "bazhen" },
  rules: {
    "host-guard": guard({ tmux: true, signals: false }),
    "signal-guard": guard({ tmux: false, signals: true }),
    "stdio-guard": stdioGuard,
  },
};
