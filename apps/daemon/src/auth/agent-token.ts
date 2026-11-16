/** The header a caller inside an agent proves which agent it is with. */
export const AGENT_TOKEN_HEADER = "bazhen-agent-token";
/** The header naming the agent a caller says it is, which proves nothing on its own. */
export const AGENT_ID_HEADER = "bazhen-agent-id";
/**
 * The header naming the Codex thread a caller's command runs in, from `CODEX_THREAD_ID`: it names
 * the agent of a call from under a Codex app-server, and is ignored from anywhere else.
 */
export const CODEX_THREAD_HEADER = "bazhen-codex-thread";

/** A token as the daemon mints it: 32 bytes, base64url. Anything else is never one. */
export const AGENT_TOKEN = /^[A-Za-z0-9_-]{43}$/;
