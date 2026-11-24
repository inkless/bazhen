//! Which process another descends from, read so that a walk up the tree is whole or refused: a walk
//! that stops at a process it can't read might have passed the one it was looking for.

use std::fmt;
use std::io;

use rustix::process::Pid;

/// Past any real process tree's depth: a walk this long is a cycle, and is refused.
pub const MAX_ANCESTORS: usize = 256;

/// Why a walk up the tree has no answer.
#[derive(Debug)]
pub enum Unwalked {
    /// A process on the way can't be read.
    Unreadable(io::Error),
    /// The walk went past `MAX_ANCESTORS` without reaching a process with no parent.
    Endless,
}

impl fmt::Display for Unwalked {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unreadable(why) => write!(f, "a process on the way can't be read: {why}"),
            Self::Endless => write!(f, "the ancestors go past {MAX_ANCESTORS} processes"),
        }
    }
}

impl std::error::Error for Unwalked {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Unreadable(why) => Some(why),
            Self::Endless => None,
        }
    }
}

/// `pid`'s parent: `None` for a process that has none, init or a PID namespace's first process.
///
/// # Errors
///
/// When `pid` has gone or exited, a zombie included, or its record can't be read: which parent it
/// had is then unknown, or no longer its.
pub fn parent(pid: Pid) -> io::Result<Option<Pid>> {
    #[cfg(target_os = "linux")]
    {
        let stat = std::fs::read(format!("/proc/{}/stat", pid.as_raw_pid()))?;
        if crate::stat::has_exited(&stat) {
            return Err(io::Error::other(format!("process {pid:?} has exited")));
        }
        let raw = crate::stat::parent_field(&stat)
            .ok_or_else(|| io::Error::other(format!("process {pid:?} names no parent")))?;
        Ok(Pid::from_raw(raw))
    }
    #[cfg(target_os = "macos")]
    {
        if pid.is_init() {
            return Ok(None);
        }
        crate::sys::parent(pid)
            .ok()
            .and_then(Pid::from_raw)
            .map(Some)
            .ok_or_else(|| io::Error::other(format!("process {pid:?} can't be read")))
    }
}

/// `pid` and its ancestors as `step` reads each, nearest first, through init or a process with no
/// parent, each with what `step` read of it besides its parent. Init, which no process can take
/// over, isn't read: it gets `at_init`.
///
/// # Errors
///
/// As `Unwalked` says.
pub fn walk<T>(
    pid: Pid,
    step: impl Fn(Pid) -> io::Result<(Option<Pid>, T)>,
    at_init: T,
) -> Result<Vec<(Pid, T)>, Unwalked> {
    let mut walked = Vec::new();
    let mut at = pid;
    while !at.is_init() {
        let (parent, read) = step(at).map_err(Unwalked::Unreadable)?;
        walked.push((at, read));
        let Some(next) = parent else {
            return Ok(walked);
        };
        if walked.len() > MAX_ANCESTORS {
            return Err(Unwalked::Endless);
        }
        at = next;
    }
    walked.push((at, at_init));
    Ok(walked)
}

/// `pid`'s ancestors as `parent` names them, nearest first, through init or a process with no
/// parent.
///
/// # Errors
///
/// As `Unwalked` says.
pub fn ancestors(
    pid: Pid,
    parent: impl Fn(Pid) -> io::Result<Option<Pid>>,
) -> Result<Vec<Pid>, Unwalked> {
    let walked = walk(pid, |at| Ok((parent(at)?, ())), ())?;
    Ok(walked.into_iter().skip(1).map(|(at, ())| at).collect())
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::process::Command;

    use rustix::process::{getpid, getppid};

    use super::*;

    fn pid(raw: i32) -> Pid {
        Pid::from_raw(raw).unwrap()
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
    fn walks_the_ancestors_nearest_first_through_init_or_a_process_with_no_parent() {
        let through_init = ancestors(pid(50), table(&[(50, 40), (40, 30), (30, 1)])).unwrap();
        let to_a_root = ancestors(pid(50), table(&[(50, 40), (40, 0)])).unwrap();
        assert_eq!(
            (through_init, to_a_root),
            (vec![pid(40), pid(30), pid(1)], vec![pid(40)])
        );
    }

    #[test]
    fn refuses_a_walk_through_a_process_it_can_t_read_or_one_that_never_ends() {
        let unread = ancestors(pid(50), table(&[(50, 40)]));
        let cycle = ancestors(pid(50), table(&[(50, 60), (60, 50)]));
        assert!(
            matches!(
                (&unread, &cycle),
                (Err(Unwalked::Unreadable(_)), Err(Unwalked::Endless))
            ),
            "{unread:?} {cycle:?}"
        );
    }

    #[test]
    fn keeps_what_each_step_read_and_gives_init_its_own() {
        let walked = walk(
            pid(50),
            |at| Ok((table(&[(50, 40), (40, 1)])(at)?, at.as_raw_pid() * 10)),
            7,
        )
        .unwrap();
        assert_eq!(walked, [(pid(50), 500), (pid(40), 400), (pid(1), 7)]);
    }

    #[test]
    fn says_why_a_walk_was_refused_on_one_line() {
        let said = [
            Unwalked::Unreadable(io::Error::other("no process 4242")),
            Unwalked::Endless,
        ]
        .map(|why| why.to_string());
        assert_eq!(
            said,
            [
                "a process on the way can't be read: no process 4242".to_owned(),
                format!("the ancestors go past {MAX_ANCESTORS} processes"),
            ]
        );
    }

    #[test]
    fn reads_this_process_s_parent_as_the_kernel_gives_it_and_none_of_a_pid_unused() {
        assert_eq!(parent(getpid()).unwrap(), getppid());
        assert!(parent(pid(i32::MAX)).is_err());
    }

    /// `raw`'s parent as `ps` reads it, apart from the walk under test.
    fn parent_by_ps(raw: i32) -> Option<i32> {
        let out = Command::new("ps")
            .args(["-o", "ppid=", "-p", &raw.to_string()])
            .output()
            .ok()?;
        String::from_utf8(out.stdout).ok()?.trim().parse().ok()
    }

    #[test]
    fn walks_this_process_s_whole_ancestry_as_ps_reads_it() {
        let walked = ancestors(getpid(), parent).unwrap();
        let mut next = getppid().map(Pid::as_raw_pid);
        let mut by_ps = Vec::new();
        while let Some(raw) = next.filter(|raw| *raw > 0) {
            by_ps.push(pid(raw));
            next = parent_by_ps(raw).filter(|_| raw > 1);
        }
        assert_eq!(walked, by_ps);
    }
}
