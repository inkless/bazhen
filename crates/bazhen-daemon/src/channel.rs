//! The daemon's connection to a harness's own server, for a harness that runs one: JSON-RPC over
//! a WebSocket on the server's Unix socket. The adapter says what to send; the daemon owns the
//! socket.

pub mod rpc;
