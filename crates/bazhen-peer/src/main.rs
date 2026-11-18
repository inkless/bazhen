//! `bazhen-peer <accepted>`: the daemon runs it with one connection to its socket as standard
//! input, and the epoch second it accepted that connection, and it prints who is at the other end
//! on one line (`bazhen_peer::Peer`). It exits 1 when that can't be said for sure, and 2 when it is
//! another user, with why on one line of standard error.

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
        Err(refused) => {
            // The exit code says what the daemon does; the line only tells its log why.
            let _ = writeln!(io::stderr().lock(), "{refused}");
            ExitCode::from(match refused {
                Refused::Foreign { .. } => 2,
                Refused::Unreadable(_) | Refused::Replaced { .. } | Refused::Endless => 1,
            })
        }
    }
}
