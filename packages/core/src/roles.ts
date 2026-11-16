import type { Role, RoleDefinition, RoleProblem } from "@bazhen/protocol";

/** What holding a role on a task lets an agent do, and how much of it one agent may hold. */
export interface RoleRules {
  readonly grants: readonly Role[];
  readonly singlePerTask: boolean;
  /** Null for no limit. */
  readonly maxActiveTasks: number | null;
}

/**
 * An assignment can outlive its role's file. A role no definition has any longer gives no
 * authority and no limit, so its holders keep their work and hand nothing on.
 */
const UNDEFINED_RULES: RoleRules = { grants: [], singlePerTask: false, maxActiveTasks: null };

/** The roles defined now, by key, in the order they were defined. */
export class RoleBook {
  readonly roles: readonly RoleDefinition[];
  private readonly byKey: ReadonlyMap<Role, RoleDefinition>;

  constructor(roles: readonly RoleDefinition[]) {
    this.roles = roles;
    this.byKey = new Map(roles.map((r) => [r.key, r]));
  }

  get(key: Role): RoleDefinition | undefined {
    return this.byKey.get(key);
  }

  rules(key: Role): RoleRules {
    return this.byKey.get(key) ?? UNDEFINED_RULES;
  }
}

/** A user's role file, read and parsed. */
export interface UserRole {
  readonly file: string;
  readonly role: RoleDefinition;
}

/**
 * The roles in force: the built-ins, each replaced whole by a user file of its key, and the user
 * files of new keys. A user role is skipped when it grants a key nothing defines, or when it can
 * be granted back through the roles it grants, which would let an agent promote another to its
 * own standing. Skipping one can change what another reaches, so the check repeats until nothing
 * changes. A skipped file's built-in, if any, stands.
 */
export function resolveRoles(
  builtins: readonly RoleDefinition[],
  user: readonly UserRole[],
): { readonly book: RoleBook; readonly problems: readonly RoleProblem[] } {
  const problems: RoleProblem[] = [];
  let kept = [...user];
  for (;;) {
    const book = merged(builtins, kept);
    const refused = kept.flatMap((u) => {
      const problem = grantProblem(u.role, book);
      return problem === null ? [] : [{ file: u.file, problem }];
    });
    if (refused.length === 0) return { book, problems };
    problems.push(...refused);
    const files = new Set(refused.map((r) => r.file));
    kept = kept.filter((u) => !files.has(u.file));
  }
}

function merged(builtins: readonly RoleDefinition[], user: readonly UserRole[]): RoleBook {
  const replaced = new Map(user.map((u) => [u.role.key, u.role]));
  return new RoleBook([
    ...builtins.map((b) => replaced.get(b.key) ?? b),
    ...user.map((u) => u.role).filter((r) => !builtins.some((b) => b.key === r.key)),
  ]);
}

function grantProblem(role: RoleDefinition, book: RoleBook): string | null {
  const unknown = role.grants.filter((g) => book.get(g) === undefined);
  if (unknown.length > 0) return `grants ${unknown.join(", ")}, which no role defines`;
  const cycle = pathBack(role.key, book);
  if (cycle === null) return null;
  return cycle.length === 2
    ? `a ${role.key} can't grant its own role`
    : `a ${role.key} could be granted again by a role it grants (${cycle.join(" → ")})`;
}

/** The shortest path of grants from `key` back to itself, both ends included, or null for none. */
function pathBack(key: Role, book: RoleBook): Role[] | null {
  const parent = new Map<Role, Role>();
  let frontier: Role[] = [key];
  while (frontier.length > 0) {
    const next: Role[] = [];
    for (const at of frontier) {
      for (const granted of book.rules(at).grants) {
        if (granted === key) return [...trail(parent, at, key), key];
        if (!parent.has(granted)) {
          parent.set(granted, at);
          next.push(granted);
        }
      }
    }
    frontier = next;
  }
  return null;
}

/** The path from `key` to `at`, following each role back to the one that granted it first. */
function trail(parent: ReadonlyMap<Role, Role>, at: Role, key: Role): Role[] {
  const path = [at];
  for (let step = at; step !== key;) {
    const up = parent.get(step);
    if (up === undefined) break;
    path.unshift(up);
    step = up;
  }
  return path;
}
