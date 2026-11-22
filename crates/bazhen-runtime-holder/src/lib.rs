//! The daemon's side of its `bazhen-holder` terminals, as `packages/runtime-holder` is: a client
//! for one holder's socket, the content-addressed installs holders run from, and where their
//! sockets go.
//!
//! - `client`: one connection to a holder, past `hello`, whose replies answer the requests that
//!   asked and whose events go to a stream of their own, ending with the connection's end;
//! - `install`: `<state>/holder/<build>/bazhen-holder`, never written over, and the prune of builds
//!   nothing runs any more;
//! - `sockets`: the private root, under the home's run directory or the short root beside it,
//!   whose `holders` directory each holder binds its socket in.
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
mod install;
mod request_ids;
mod sockets;
mod tags;

#[cfg(test)]
mod fake_holder;
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
pub use sockets::{HolderRoot, UnsafeHolderDir};
pub use tags::{TerminalTags, decode_tags, encode_tags, unlinked};
