//! `bazhen-peer <accepted> [<pid> <started>]`: the daemon runs it with one connection to its socket
//! as standard input, and the epoch microsecond it accepted that connection, and it prints who is
//! at the other end on one line (`bazhen_peer::Peer`). Where the kernel's name for the peer can be
//! a process other than the one that connected (`bazhen_peer::PINS_CONNECTOR`), the daemon also
//! gives the connector it pinned when it accepted the connection, which is the one read.
//!
//! `bazhen-peer connector <accepted>` pins it: it prints the pid at the other end and its start,
//! `<pid> <started>`, which the daemon gives back with each reading after.
//!
//! Either exits 1 when it can't say for sure, and 2 when the peer is another user, with why on one
//! line of standard error.

use std::env;
use std::io::{self, Write as _};
use std::os::fd::AsFd as _;
use std::process::ExitCode;

use bazhen_peer::{Connector, Refused};
use rustix::process::Pid;

fn main() -> ExitCode {
    let args: Vec<String> = env::args().skip(1).collect();
    let stdin = io::stdin();
    let said = match args
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        ["connector", accepted] => match accepted.parse() {
            Ok(accepted) => bazhen_peer::connector(stdin.as_fd(), accepted)
                .map(|Connector { pid, started }| format!("{} {started}", pid.as_raw_pid())),
            Err(_) => return ExitCode::from(1),
        },
        [accepted, pinned @ ..] => {
            let Ok(accepted) = accepted.parse() else {
                return ExitCode::from(1);
            };
            let connector = match pinned {
                [] => None,
                [pid, started] => match (pid.parse().ok().and_then(Pid::from_raw), started.parse())
                {
                    (Some(pid), Ok(started)) => Some(Connector { pid, started }),
                    _ => return ExitCode::from(1),
                },
                _ => return ExitCode::from(1),
            };
            bazhen_peer::of(stdin.as_fd(), accepted, connector).map(|peer| peer.to_string())
        }
        [] => return ExitCode::from(1),
    };
    match said {
        Ok(line) => match writeln!(io::stdout().lock(), "{line}") {
            Ok(()) => ExitCode::SUCCESS,
            Err(_) => ExitCode::from(1),
        },
        Err(refused) => {
            // The exit code says what the daemon does; the line only tells its log why.
            let _ = writeln!(io::stderr().lock(), "{refused}");
            ExitCode::from(match refused {
                Refused::Foreign { .. } => 2,
                Refused::Unreadable(_)
                | Refused::Replaced { .. }
                | Refused::Endless
                | Refused::NoEnd
                | Refused::Ambiguous
                | Refused::NoReadableHolder { .. }
                | Refused::TooManyHolders { .. }
                | Refused::HolderChanged
                | Refused::Changed(_) => 1,
            })
        }
    }
}
