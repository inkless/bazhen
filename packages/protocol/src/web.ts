// What the web imports: the zod `cargo xtask schema` writes from the Rust protocol, and the few
// helpers and constants written by hand beside it. The TypeScript daemon still reads index.ts.

export * from "./gen/protocol.ts";

export { AGENT_NAME_MAX, nameBase } from "./agent-name.ts";
export { VISIBILITY_HEARTBEAT_MS } from "./events.ts";
export { HOLDER_MAX_HISTORY_LINES } from "./holder.ts";
export { withoutEventReports } from "./input.ts";
export { parseJson } from "./json.ts";
export { BUILTIN_ROLES } from "./roles.ts";
export { HISTORY_LINES, MAX_ROWS } from "./stream.ts";
export { TERMINAL_COLOURS } from "./theme.ts";

// The attention routes' replies, until the Rust protocol emits them with those routes' port.
export {
  AnswerAttentionResponse,
  DismissAttentionResponse,
  ReplyAttentionResponse,
  ResendAttentionResponse,
} from "./mail.ts";
