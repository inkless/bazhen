// What the web imports: the zod and the constants `cargo xtask schema` writes from the Rust
// protocol, and the few helpers written by hand beside it, with the one constant only a page reads.
// The TypeScript daemon still reads index.ts.

export * from "./gen/protocol.ts";
export * from "./gen/constants.ts";

export { nameBase } from "./agent-name.ts";
export { VISIBILITY_HEARTBEAT_MS } from "./events.ts";
export { withoutEventReports } from "./input.ts";
export { parseJson } from "./json.ts";
