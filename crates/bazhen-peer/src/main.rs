//! `bazhen-peer <accepted>`: the daemon runs it with one connection to its socket as standard
//! input, and the epoch second it accepted that connection, and it prints who is at the other end
//! on one line (`bazhen_peer::Peer`). It exits 1 when that can't be said for sure, and 2 when it is
//! another user.

use std::env;
use std::io::{self, Write as _};
use std::os::fd::AsFd as _;
use std::process::ExitCode;

use bazhen_peer::Refused;

fn main() -> ExitCode {
    let Some(accepted) = env::args().nth(1).and_then(|a| a.parse::<u64>().ok()) else {
        return ExitCode::from(1);
    };
    let stdin = io::stdin();
    match bazhen_peer::of(stdin.as_fd(), accepted) {
        Ok(peer) => match writeln!(io::stdout().lock(), "{peer}") {
            Ok(()) => ExitCode::SUCCESS,
            Err(_) => ExitCode::from(1),
        },
        Err(Refused::Foreign { .. }) => ExitCode::from(2),
        Err(Refused::Unreadable(_) | Refused::Replaced { .. } | Refused::Endless) => {
            ExitCode::from(1)
        }
    }
}
