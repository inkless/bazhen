import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readdirSync,
  readSync,
  statSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
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

/** A role no definition has: `bazhen roles` lists those that do. */
export class UnknownRole extends Error {
  readonly role: string;

  constructor(role: string) {
    super(`no role is defined as ${role}: bazhen roles lists them`);
    this.role = role;
  }
}

/** The built-in role files, shipped beside the daemon's source, which it runs from. */
export const BUILTIN_DIR = fileURLToPath(new URL("../../roles/", import.meta.url));

/**
 * The longest prompt a role may have. An agent given a role it wasn't launched in is sent the
 * role's prompt as a message of its own, so it must fit in one, with room for its heading.
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
    // Warnings would go to the process's warning output, which could quote the file.
    front = parse(parts.front, { logLevel: "error" }) ?? {};
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

/** Why a file system call failed, by its code, since its message names the absolute path. */
const reasonOf = (error: unknown) =>
  error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : "an unexpected error";

/** The role files in a directory, by name, with what tells a changed one apart. */
function listing(dir: string): { files: string[]; signature: string } | { error: string } {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".md") && !n.startsWith("."));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { files: [], signature: "" };
    }
    return { error: `can't list it: ${reasonOf(error)}` };
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

/**
 * A role file's text, or why it can't be one. It is opened without waiting, so a FIFO can't hold
 * the daemon up, and checked through the open file, so what is read is what was checked: only a
 * regular file, a symlink's target included, and no more of it than a role file may be.
 */
function readText(path: string): { readonly text: string } | { readonly problem: string } {
  let fd: number;
  try {
    // O_NOCTTY: the daemon leads its own session, so a file that is a terminal mustn't become its own.
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOCTTY);
  } catch (error) {
    return { problem: `can't read it: ${reasonOf(error)}` };
  }
  try {
    if (!fstatSync(fd).isFile()) return { problem: "it isn't a regular file" };
    const buffer = Buffer.alloc(FILE_MAX + 1);
    let length = 0;
    while (length < buffer.length) {
      const n = readSync(fd, buffer, length, buffer.length - length, null);
      if (n === 0) break;
      length += n;
    }
    if (length > FILE_MAX) {
      return { problem: `it is over ${FILE_MAX} bytes, longer than a role file is` };
    }
    return { text: buffer.toString("utf8", 0, length) };
  } catch (error) {
    return { problem: `can't read it: ${reasonOf(error)}` };
  } finally {
    closeSync(fd);
  }
}

function readRole(dir: string, file: string, source: RoleSource) {
  const read = readText(join(dir, file));
  if ("problem" in read) return read;
  return parseRole(file.slice(0, -".md".length), read.text, source);
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
 * the next use without a restart. A bad file is reported, once for each change, and skipped. A
 * problem names its file from the config directory (`roles/lead.md`), since it is shown to
 * agents, which have no need of the user's home; only the daemon's log names the whole path.
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
      console.error(`bazhen: role file ${join(dirname(dir), file)} skipped: ${problem}`),
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
      const shown = join(basename(this.dir), file);
      if ("problem" in role) unread.push({ file: shown, problem: role.problem });
      else user.push({ file: shown, role });
    }
    if ("error" in listed) unread.push({ file: basename(this.dir), problem: listed.error });
    const resolved = resolveRoles(this.builtins, user);
    const problems = [...unread, ...resolved.problems];
    for (const problem of problems) this.report(problem);
    this.signature = signature;
    this.now = { book: resolved.book, problems };
    return this.now;
  }
}
