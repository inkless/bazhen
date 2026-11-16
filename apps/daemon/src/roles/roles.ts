import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { z } from "zod";
import { resolveRoles, type RoleBook, type UserRole } from "@bazhen/core";
import {
  BUILTIN_ROLES,
  Role,
  type RoleDefinition,
  type RoleProblem,
  type RoleSource,
} from "@bazhen/protocol";

/** The built-in role files, shipped beside the daemon's source, which it runs from. */
export const BUILTIN_DIR = fileURLToPath(new URL("../../roles/", import.meta.url));

/**
 * The longest prompt a role may have. A brief carries a role's prompt the first time an agent is
 * given a role it wasn't launched in, so it must leave a brief room within one message.
 */
const PROMPT_MAX = 10_000;

/** No role file is this long; one that is was not written as one. */
const FILE_MAX = 64 * 1024;

/** The keys front matter may hold. An unknown key is a problem, so a typo never means "default". */
const FrontMatter = z.strictObject({
  title: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).default(""),
  grants: z.array(Role).default([]),
  singlePerTask: z.boolean().default(false),
  /** Absent for no limit. */
  maxActiveTasks: z.int().positive().nullable().default(null),
});

/** The front matter and the body of a Markdown file that opens with a `---` block. */
function split(text: string): { front: string; body: string } | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (match === null) return null;
  return { front: match[1] ?? "", body: text.slice(match[0].length) };
}

/** One role file's text, as the definition of the role its file name keys, or why it isn't one. */
export function parseRole(
  key: string,
  text: string,
  source: RoleSource,
): RoleDefinition | { readonly problem: string } {
  if (!Role.safeParse(key).success) {
    return { problem: "a role file is named <role>.md, the role lowercase letters, digits or -" };
  }
  const parts = split(text);
  if (parts === null) return { problem: "it must start with front matter between --- lines" };
  let front: unknown;
  try {
    front = parse(parts.front) ?? {};
  } catch (error) {
    // The first line only: the rest quotes the file.
    const first = error instanceof Error ? error.message.split("\n")[0] : "unreadable";
    return { problem: `its front matter isn't YAML: ${first}` };
  }
  const settings = FrontMatter.safeParse(front);
  if (!settings.success) {
    const issue = settings.error.issues[0];
    const where = issue?.path.join(".") ?? "";
    return { problem: `front matter ${where === "" ? "" : `${where}: `}${issue?.message}` };
  }
  const prompt = parts.body.trim();
  if (prompt === "") return { problem: "it has no prompt after its front matter" };
  if (prompt.length > PROMPT_MAX) {
    return {
      problem: `its prompt is ${prompt.length} characters, over the ${PROMPT_MAX} a role's may be`,
    };
  }
  return { key, ...settings.data, prompt, source };
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The role files in a directory, by name, with what tells a changed one apart. */
function listing(dir: string): { files: string[]; signature: string } | { error: string } {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".md") && !n.startsWith("."));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { files: [], signature: "" };
    }
    return { error: `can't list ${dir}: ${messageOf(error)}` };
  }
  const files = names.toSorted();
  const signature = files
    .map((n) => {
      try {
        const s = statSync(join(dir, n));
        return `${n}:${s.mtimeMs}:${s.size}`;
      } catch {
        return `${n}:gone`;
      }
    })
    .join("\n");
  return { files, signature };
}

function readRole(dir: string, file: string, source: RoleSource) {
  const key = file.slice(0, -".md".length);
  let text: string;
  try {
    if (statSync(join(dir, file)).size > FILE_MAX) {
      return { problem: `it is over ${FILE_MAX} bytes, longer than a role file is` };
    }
    text = readFileSync(join(dir, file), "utf8");
  } catch (error) {
    return { problem: `can't read it: ${messageOf(error)}` };
  }
  return parseRole(key, text, source);
}

/** The roles Bazhen ships. A built-in that doesn't parse is a bug in Bazhen, so it throws. */
export function builtinRoles(dir: string = BUILTIN_DIR): RoleDefinition[] {
  return BUILTIN_ROLES.map((key) => {
    const role = readRole(dir, `${key}.md`, "builtin");
    if ("problem" in role) throw new Error(`the built-in role ${key} is broken: ${role.problem}`);
    return role;
  });
}

export interface RolesNow {
  readonly book: RoleBook;
  readonly problems: readonly RoleProblem[];
}

/**
 * The roles in force: the built-ins, and the user's files in `dir`, read again whenever the
 * directory's listing or a file's modification time or size changes, so an edit takes effect at
 * the next use without a restart. A bad file is reported, once for each change, and skipped.
 */
export class Roles {
  private readonly dir: string;
  private readonly builtins: readonly RoleDefinition[];
  private readonly report: (problem: RoleProblem) => void;
  private signature: string | null = null;
  private now: RolesNow | null = null;

  constructor(
    dir: string,
    builtins: readonly RoleDefinition[] = builtinRoles(),
    report: (problem: RoleProblem) => void = ({ file, problem }) =>
      console.error(`bazhen: role file ${file} skipped: ${problem}`),
  ) {
    this.dir = dir;
    this.builtins = builtins;
    this.report = report;
  }

  current(): RolesNow {
    const listed = listing(this.dir);
    const signature = "error" in listed ? `error:${listed.error}` : listed.signature;
    if (this.now !== null && signature === this.signature) return this.now;
    const unread: RoleProblem[] = [];
    const user: UserRole[] = [];
    for (const file of "error" in listed ? [] : listed.files) {
      const role = readRole(this.dir, file, "user");
      if ("problem" in role) unread.push({ file: join(this.dir, file), problem: role.problem });
      else user.push({ file: join(this.dir, file), role });
    }
    if ("error" in listed) unread.push({ file: this.dir, problem: listed.error });
    const resolved = resolveRoles(this.builtins, user);
    const problems = [...unread, ...resolved.problems];
    for (const problem of problems) this.report(problem);
    this.signature = signature;
    this.now = { book: resolved.book, problems };
    return this.now;
  }
}
