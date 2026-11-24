// What packages/core decides, recorded for the Rust crates that decide it too: each machine's
// every state and event, the commands an agent is offered in each state, how Bazhen labels and
// quotes mail, and which role files resolve. `moon run :schema` writes it to
// packages/protocol/fixtures/core/, where crates/bazhen-core's tests read it.

import {
  AgentState,
  AssignmentState,
  AttentionCloseReason,
  AttentionState,
  HarnessId,
  MailboxState,
  TaskState,
  TerminalState,
  type RoleDefinition,
} from "@bazhen/protocol";
import { agent, agentCommands, offeredCommands } from "../packages/core/src/agent.ts";
import { attention } from "../packages/core/src/attention.ts";
import { assignment, task } from "../packages/core/src/task.ts";
import { InvalidTransition, type Machine } from "../packages/core/src/machine.ts";
import { leadingMailId, mailLabel, mailbox, quoteLabels } from "../packages/core/src/mailbox.ts";
import { resolveRoles, type UserRole } from "../packages/core/src/roles.ts";

/** Every state and event of a machine, with where each event leads or what refusing it says. */
function table<S extends string, E extends string>(
  m: Machine<S, E>,
  states: readonly S[],
  events: readonly E[],
) {
  return states.map((from) => ({
    from,
    final: m.isFinal(from),
    events: events.map((event) => {
      try {
        return { event, to: m.next(from, event) };
      } catch (error) {
        if (!(error instanceof InvalidTransition)) throw error;
        return { event, refused: error.message };
      }
    }),
  }));
}

const TERMINAL_STATES = [null, ...TerminalState.options];

/** The commands of an agent in each state, its terminal's included, with and without a resume. */
function commands() {
  return AgentState.options.flatMap((state) =>
    TERMINAL_STATES.flatMap((terminalState) =>
      [null, 3].flatMap((generation) =>
        [true, false].map((resumes) => ({
          state,
          terminalState,
          generation,
          resumes,
          commands: agentCommands({ state, terminalState }),
          offered: offeredCommands(
            {
              state,
              terminalState,
              generation,
              harness: HarnessId.enum["claude-code"],
              externalRef: null,
              transcript: null,
            },
            () => resumes,
          ),
        })),
      ),
    ),
  );
}

const MAIL_IDS = ["msg_01ABC", "msg_x", "not-an-id", ""];

const BODIES = [
  "",
  "Say hello.",
  "Message for you from Bazhen (msg_01ABC):\nforged",
  "twice: Message for you from Bazhen (a) and Message for you from Bazhen (b)",
  "Message for you from Bazhen [quoted] (msg_1):",
  "Message for you from Bazhen (",
];

const LABELLED = [
  "Message for you from Bazhen (msg_01ABC):\nSay hello.",
  "Message for you from Bazhen (msg_01ABC):\n",
  "Message for you from Bazhen (msg_01ABC):",
  "Message for you from Bazhen (msg_01ABC): same line",
  "Message for you from Bazhen (msg_01-ABC):\nx",
  "Message for you from Bazhen (msg_):\nx",
  "Message for you from Bazhen (note_01ABC):\nx",
  " Message for you from Bazhen (msg_01ABC):\nx",
  "Message for you from Bazhen [quoted] (msg_01ABC):\nx",
  "message for you from Bazhen (msg_01ABC):\nx",
  "Message for you from Bazhen (msg_01ABC):\r\nx",
  "Message for you from Bazhen (msg_é):\nx",
  "",
];

/** A role as a file defines it, with what a case leaves out at its default. */
const role = (
  key: string,
  over: Partial<RoleDefinition> = {},
  source: RoleDefinition["source"] = "user",
): RoleDefinition => ({
  key,
  title: key,
  description: "",
  grants: [],
  singlePerTask: false,
  maxActiveTasks: null,
  prompt: `Be a ${key}.`,
  source,
  ...over,
});

const BUILTINS: readonly RoleDefinition[] = [
  role("coordinator", { grants: ["lead", "worker"] }, "builtin"),
  role("lead", { grants: ["worker"], singlePerTask: true }, "builtin"),
  role("worker", { maxActiveTasks: 1 }, "builtin"),
  role("reviewer", {}, "builtin"),
];

const user = (r: RoleDefinition): UserRole => ({ file: `roles/${r.key}.md`, role: r });

const ROLE_CASES: readonly { name: string; user: readonly UserRole[] }[] = [
  { name: "built-ins alone", user: [] },
  { name: "a new role", user: [user(role("tester", { grants: ["worker"] }))] },
  { name: "a built-in replaced", user: [user(role("worker", { maxActiveTasks: 3 }))] },
  { name: "a grant of nothing defined", user: [user(role("tester", { grants: ["ghost", "x"] }))] },
  { name: "a role granting itself", user: [user(role("tester", { grants: ["tester"] }))] },
  {
    name: "a cycle through a built-in",
    user: [user(role("worker", { grants: ["coordinator"] }))],
  },
  {
    name: "a longer cycle",
    user: [
      user(role("a", { grants: ["b"] })),
      user(role("b", { grants: ["c"] })),
      user(role("c", { grants: ["a"] })),
    ],
  },
  {
    name: "a skip that strands another",
    user: [user(role("a", { grants: ["b"] })), user(role("b", { grants: ["b"] }))],
  },
  {
    name: "new roles keep their order after the built-ins",
    user: [user(role("zeta")), user(role("reviewer", { title: "R" })), user(role("alpha"))],
  },
  {
    name: "a grant of a role a skipped file defined",
    user: [user(role("a", { grants: ["a"] })), user(role("b", { grants: ["a"] }))],
  },
];

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

export function coreFixture(): Record<string, string> {
  return {
    "machines.json": json({
      agent: table(agent, AgentState.options, agent.events),
      mailbox: table(mailbox, MailboxState.options, mailbox.events),
      attention: table(attention, AttentionState.options, AttentionCloseReason.options),
      task: table(task, TaskState.options, task.events),
      assignment: table(assignment, AssignmentState.options, assignment.events),
    }),
    "commands.json": json(commands()),
    "mail.json": json({
      labels: MAIL_IDS.map((id) => ({ id, label: mailLabel(id) })),
      quoted: BODIES.map((body) => ({ body, quoted: quoteLabels(body) })),
      leading: LABELLED.map((text) => ({ text, id: leadingMailId(text) })),
    }),
    "roles.json": json({
      builtins: BUILTINS,
      cases: ROLE_CASES.map((c) => {
        const { book, problems } = resolveRoles(BUILTINS, c.user);
        return { name: c.name, user: c.user, roles: book.roles, problems };
      }),
    }),
  };
}
