//! Who is at the other end of a connection to the daemon's socket: the process, its session, and
//! its ancestors, which the daemon matches against the terminals it runs to tell an agent's call
//! from the human's (foundation-design §9.1). Node can't read a Unix socket's peer credentials,
//! so the daemon asks this. It only reads: nothing here reaches a process.
//!
//! Every answer is whole or refused. A walk that stops at a process it can't read might have
//! passed an agent's terminal, and a peer that has gone, or whose pid another process now holds,
//! isn't the one the kernel named at accept: either would read as no agent's, so neither is
//! answered.

use std::fmt;
use std::io;
use std::os::fd::BorrowedFd;

use bazhen_holder::{process, start_time};
use rustix::process::{Pid, geteuid};

/// Past any real process tree's depth: a walk this long is a cycle, and is refused.
pub const MAX_ANCESTORS: usize = 256;

/// The process at the other end of a connection, the session it is in, and every ancestor it has,
/// nearest first, through init or the first process of its PID namespace.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Peer {
    pub pid: Pid,
    pub session: Pid,
    pub ancestors: Vec<Pid>,
}

/// One line of decimals: the pid, the session, then each ancestor.
impl fmt::Display for Peer {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} {}", self.pid.as_raw_pid(), self.session.as_raw_pid())?;
        for ancestor in &self.ancestors {
            write!(f, " {}", ancestor.as_raw_pid())?;
        }
        Ok(())
    }
}

/// Why no peer is named.
#[derive(Debug)]
pub enum Refused {
    /// The socket isn't a connected Unix socket, or a process on the way can't be read.
    Unreadable(io::Error),
    /// Another user is at the other end, whom the daemon never serves.
    Foreign { uid: u32 },
    /// The pid's process started after the connection was accepted, so it took a pid its caller
    /// gave up.
    Replaced { started: u64, accepted: u64 },
    /// The walk went past `MAX_ANCESTORS` without reaching a process with no parent.
    Endless,
}

impl From<io::Error> for Refused {
    fn from(error: io::Error) -> Self {
        Self::Unreadable(error)
    }
}

/// Who is at the other end of `socket`, accepted at `accepted` (epoch seconds), as the kernel names
/// it (`process::peer_pid`). Its start is read again once the walk is done: a process that started
/// since the connection was accepted holds a pid its caller gave up.
///
/// # Errors
///
/// As `Refused` says.
pub fn of(socket: BorrowedFd<'_>, accepted: u64) -> Result<Peer, Refused> {
    let uid = process::peer_uid(socket)?;
    if uid != geteuid().as_raw() {
        return Err(Refused::Foreign { uid });
    }
    let pid = process::peer_pid(socket)?;
    let started = started(pid, accepted)?;
    let peer = Peer {
        pid,
        session: process::session(pid)?,
        ancestors: ancestors(pid, process::parent)?,
    };
    if self::started(pid, accepted)? != started {
        return Err(Refused::Replaced { started, accepted });
    }
    Ok(peer)
}

/// When `pid`'s process started, refused when that was after `accepted`.
fn started(pid: Pid, accepted: u64) -> Result<u64, Refused> {
    let started =
        u64::from(start_time::of(pid).map_err(|e| Refused::Unreadable(io::Error::other(e)))?);
    if started > accepted {
        return Err(Refused::Replaced { started, accepted });
    }
    Ok(started)
}

/// `pid`'s ancestors as `parent` names them, nearest first, through init or a process with no
/// parent.
///
/// # Errors
///
/// `Unreadable` when a process on the way can't be read, and `Endless` past `MAX_ANCESTORS`.
pub fn ancestors(
    pid: Pid,
    parent: impl Fn(Pid) -> io::Result<Option<Pid>>,
) -> Result<Vec<Pid>, Refused> {
    let mut found = Vec::new();
    let mut at = pid;
    while !at.is_init() {
        let Some(next) = parent(at)? else {
            return Ok(found);
        };
        if found.len() == MAX_ANCESTORS {
            return Err(Refused::Endless);
        }
        found.push(next);
        at = next;
    }
    Ok(found)
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::os::fd::AsFd as _;
    use std::os::unix::net::UnixStream;
    use std::time::{SystemTime, UNIX_EPOCH};

    use rustix::process::{getpid, getppid, getsid};

    use super::*;

    fn pid(raw: i32) -> Pid {
        Pid::from_raw(raw).unwrap()
    }

    fn now() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs()
    }

    /// A parent table: a pid not in it can't be read, and one mapped to 0 has no parent.
    fn table(parents: &[(i32, i32)]) -> impl Fn(Pid) -> io::Result<Option<Pid>> + use<> {
        let parents: HashMap<i32, i32> = parents.iter().copied().collect();
        move |p| match parents.get(&p.as_raw_pid()) {
            Some(&parent) => Ok(Pid::from_raw(parent)),
            None => Err(io::Error::other("gone")),
        }
    }

    #[test]
    fn walks_the_ancestors_nearest_first_through_init() {
        let walked = ancestors(pid(50), table(&[(50, 40), (40, 30), (30, 1)])).unwrap();
        assert_eq!(walked, [pid(40), pid(30), pid(1)]);
    }

    #[test]
    fn ends_the_walk_at_a_process_with_no_parent() {
        let walked = ancestors(pid(50), table(&[(50, 40), (40, 0)])).unwrap();
        assert_eq!(walked, [pid(40)]);
    }

    #[test]
    fn refuses_a_walk_through_a_process_it_can_t_read() {
        let walked = ancestors(pid(50), table(&[(50, 40)]));
        assert!(matches!(walked, Err(Refused::Unreadable(_))));
    }

    #[test]
    fn refuses_a_cycle() {
        let walked = ancestors(pid(50), table(&[(50, 60), (60, 50)]));
        assert!(matches!(walked, Err(Refused::Endless)));
    }

    #[test]
    fn names_this_process_its_session_and_parent_at_the_other_end_of_its_own_pair() {
        let (ours, _theirs) = UnixStream::pair().unwrap();
        let peer = of(ours.as_fd(), now()).unwrap();
        assert_eq!(
            (peer.pid, peer.session, peer.ancestors.first().copied()),
            (getpid(), getsid(None).unwrap(), getppid()),
        );
    }

    #[test]
    fn refuses_a_peer_whose_process_started_after_the_connection_was_accepted() {
        let (ours, _theirs) = UnixStream::pair().unwrap();
        let before_this_process = 0;
        assert!(matches!(
            of(ours.as_fd(), before_this_process),
            Err(Refused::Replaced { .. })
        ));
    }

    #[test]
    fn prints_one_line_of_the_pid_the_session_and_each_ancestor() {
        let peer = Peer {
            pid: pid(50),
            session: pid(45),
            ancestors: vec![pid(40), pid(1)],
        };
        assert_eq!(peer.to_string(), "50 45 40 1");
    }
}
