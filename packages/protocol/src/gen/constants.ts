// The protocol's constants. Written by `cargo xtask schema`, and held to it by its
// `--check`: don't edit it by hand.

export const AGENT_NAME_MAX = 40;

export const BUILTIN_ROLES = ["coordinator","lead","worker","reviewer"] as const;

export const EVENT_FRAME_MAX_BYTES = 1024;

export const HISTORY_LINES = 10000;

export const HOLDER_MAX_HISTORY_LINES = 100000;

export const MAX_ROWS = 1000;

export const STREAM_FRAME_MAX_BYTES = 1048576;

export const TERMINAL_COLOURS = {"dark":{"background":"#0f0f10","text":"#eaebee"},"light":{"background":"#fdfdfd","text":"#202225"}} as const;
