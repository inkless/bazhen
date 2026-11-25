//! The daemon's side of its `bazhen-holder` terminals, as `packages/runtime-holder` is: a client
//! for one holder's socket, the content-addressed installs holders run from, and where their
//! sockets go.
//!
//! - `client`: one connection to a holder, past `hello`, whose replies answer the requests that
//!   asked and whose events go to a stream of their own, ending with the connection's end;
//! - `install`: `<state>/holder/<build>/bazhen-holder`, never written over, and the prune of builds
//!   nothing runs any more;
//! - `sockets`: the private root, under the home's run directory or the short root beside it,
//!   whose `holders` directory each holder binds its socket in;
//! - `runtime`: the terminals, each in a holder of its own: created, found, acted on, and
//!   watched, through one connection to each, for what its holder says unasked (`watch`);
//! - `stream`: a terminal's streams, each reading on a connection of its own from its snapshot,
//!   and sending through one control connection the terminal's streams share, which holds the
//!   holder's writer slot;
//! - `locator`: where a terminal's holder is, as the daemon records it.
//!
//! The client is async, on tokio, as only the daemon is; install and prune block, and run off
//! the runtime.
//!
//! A connection reads its replies and its events in the order the holder wrote them, so a
//! consumer that stops taking its events, once `EVENTS_QUEUED` wait, holds back every answer
//! behind them too, and no request has a timeout of its own: whoever holds a connection's
//! `HolderEvents` drains it or drops it. Cancelling `ClientOptions::cancel` ends a connection
//! even then.

mod client;
mod host;
mod install;
mod locator;
mod request_ids;
mod runtime;
mod sockets;
mod stream;
mod tags;
mod watch;

#[cfg(test)]
mod fake_holder;
#[cfg(test)]
mod fake_host;
#[cfg(test)]
mod real_holder;
#[cfg(test)]
mod test_support;

pub use client::{
    Answer, CONNECT, ClientOptions, ConnectError, EVENTS_QUEUED, HANG_UP, HolderClient,
    HolderDisconnected, HolderEnd, HolderEvent, HolderEvents, HolderRefusal, HolderSnapshot,
    InputError, MAX_UNSENT_BYTES, RequestError, connect,
};
pub use install::{
    FRESH, InstallError, InstallOptions, InstalledHolder, install_holder, prune_holder_builds,
    prune_unused_holders, running_builds,
};
pub use locator::{HolderLocator, HolderRef, LocatorError};
pub use runtime::{
    Compatibility, ForegroundProcess, HELLO, HealthState, HolderBuild, HolderRuntime,
    InventoryEntry, Listing, Needs, ProcessLaunch, REQUEST, RuntimeError, RuntimeHealth,
    RuntimeOptions, StaleReason, TerminalSpec,
};
pub use sockets::{HolderRoot, UnsafeHolderDir};
pub use stream::{
    Attached, ControlError, ControlGuard, DRAIN, HolderStream, Position, StreamEnd, StreamError,
    StreamEvent, StreamEvents, StreamFailure, WRITER_RETRY,
};
pub use tags::{TerminalTags, decode_tags, encode_tags, unlinked};
pub use watch::{EVENTS_KEPT, RuntimeEvent};
