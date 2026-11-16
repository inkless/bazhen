import { z } from "zod";

/**
 * A role's key: the name of its definition's file, and what an assignment or a launch names it
 * by. Which keys are defined is the daemon's to check, against the role files it has read.
 * An older client knows only `coordinator | lead | worker`, and refuses a snapshot or event
 * naming any other role, `reviewer` included.
 */
export const Role = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/, {
  message: "a role is 1 to 32 lowercase letters, digits or -, starting with a letter",
});
export type Role = z.infer<typeof Role>;

/** The roles Bazhen ships a definition of. A user's file may replace any, but none goes away. */
export const BUILTIN_ROLES = ["coordinator", "lead", "worker", "reviewer"] as const;

export const RoleSource = z.enum(["builtin", "user"]);
export type RoleSource = z.infer<typeof RoleSource>;

/**
 * A role as its file defines it (foundation-design §11.4): what an assignment in it may hand on,
 * whether a task has at most one holder of it, how many tasks an agent may hold in it at once,
 * and the prompt an agent launched in it starts with.
 */
export const RoleDefinition = z.object({
  key: Role,
  title: z.string(),
  description: z.string(),
  grants: z.array(Role),
  singlePerTask: z.boolean(),
  /** Null for no limit. */
  maxActiveTasks: z.int().positive().nullable(),
  prompt: z.string(),
  source: RoleSource,
});
export type RoleDefinition = z.infer<typeof RoleDefinition>;

/** A role file that was skipped, and why; the built-in of its key, if any, stands. */
export const RoleProblem = z.object({ file: z.string(), problem: z.string() });
export type RoleProblem = z.infer<typeof RoleProblem>;

/** `GET /v1/roles`. */
export const RolesResponse = z.object({
  roles: z.array(RoleDefinition),
  problems: z.array(RoleProblem),
});
export type RolesResponse = z.infer<typeof RolesResponse>;
