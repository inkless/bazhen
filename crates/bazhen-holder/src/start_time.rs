//! When a process started, in epoch seconds, exactly as `ps -o lstart` shows it: the daemon
//! checks a pid against reuse by comparing the two, so the holder reads the same source `ps`
//! does on each OS. A child that has exited but isn't yet reaped still has one. Every field the
//! holder takes from a `/proc/<pid>/stat` line is parsed here.

use std::io;

use bazhen_holder_proto::body::StartTime;
use rustix::process::Pid;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum StartTimeError {
    #[error("no process {0}")]
    Absent(i32),
    #[error("could not read when process {pid} started: {source}")]
    Unreadable {
        pid: i32,
        #[source]
        source: io::Error,
    },
}

/// When `pid` started. Only for a pid the caller holds: its own, or a child it hasn't reaped yet,
/// an exited one included. Any other pid may be reused by another process at any time, so the
/// answer could be that one's.
///
/// # Errors
///
/// `Absent` when no process has the pid, a reaped child included; `Unreadable` when the OS won't
/// say, or says something this can't read.
pub fn of(pid: Pid) -> Result<StartTime, StartTimeError> {
    let raw = pid.as_raw_nonzero().get();
    let seconds = read(pid)?;
    StartTime::new(seconds).map_err(|e| StartTimeError::Unreadable {
        pid: raw,
        source: io::Error::other(e),
    })
}

#[cfg(target_os = "linux")]
fn read(pid: Pid) -> Result<u64, StartTimeError> {
    let raw = pid.as_raw_nonzero().get();
    let unreadable = |source: io::Error| StartTimeError::Unreadable { pid: raw, source };
    // ESRCH: the process ended between the open and the read.
    let stat = std::fs::read(format!("/proc/{raw}/stat")).map_err(|e| {
        if e.kind() == io::ErrorKind::NotFound || e.raw_os_error() == Some(libc::ESRCH) {
            StartTimeError::Absent(raw)
        } else {
            unreadable(e)
        }
    })?;
    let system = std::fs::read("/proc/stat").map_err(unreadable)?;
    epoch_seconds(&system, &stat, rustix::param::clock_ticks_per_second())
        .ok_or_else(|| unreadable(io::Error::other("an unreadable /proc stat file")))
}

#[cfg(target_os = "macos")]
fn read(pid: Pid) -> Result<u64, StartTimeError> {
    crate::macos::start_seconds(pid)
}

/// What procps prints for `lstart`: the boot time plus the start in clock ticks since boot, in
/// whole seconds. `system` is `/proc/stat`, `stat` is `/proc/<pid>/stat`.
pub fn epoch_seconds(system: &[u8], stat: &[u8], ticks_per_second: u64) -> Option<u64> {
    let since_boot = start_ticks(stat)?.checked_div(ticks_per_second)?;
    boot_time(system)?.checked_add(since_boot)
}

/// Field 22 of `/proc/<pid>/stat`, the start in clock ticks since boot.
pub fn start_ticks(stat: &[u8]) -> Option<u64> {
    stat_field(stat, 22).and_then(decimal)
}

/// Field `n`, from 3 on, of a `/proc/<pid>/stat` line. Field 2 is the program's name in
/// parentheses, which can hold anything, `)` and spaces included, so fields are counted from the
/// last `)`: the state, field 3, is the first token after it.
pub fn stat_field(stat: &[u8], n: usize) -> Option<&[u8]> {
    let close = stat.iter().rposition(|&b| b == b')')?;
    let rest = stat.get(close + 1..)?;
    rest.split(u8::is_ascii_whitespace)
        .filter(|token| !token.is_empty())
        .nth(n.checked_sub(3)?)
}

/// Field 1 of a `/proc/<pid>/stat` line: the pid it is of, as this PID namespace numbers it.
pub fn own_pid(stat: &[u8]) -> Option<i32> {
    stat.split(|&b| b == b' ')
        .next()
        .and_then(decimal)
        .and_then(|pid| i32::try_from(pid).ok())
}

/// Field 4 of a `/proc/<pid>/stat` line: the parent's pid, 0 for a process that has none.
pub fn parent_field(stat: &[u8]) -> Option<i32> {
    stat_field(stat, 4)
        .and_then(decimal)
        .and_then(|pid| i32::try_from(pid).ok())
}

/// Whether a `/proc/<pid>/stat` line is of a process that has exited: a zombie, or one dead.
pub fn has_exited(stat: &[u8]) -> bool {
    matches!(stat_field(stat, 3), Some(b"Z" | b"X"))
}

/// The `btime` line of `/proc/stat`: when the system booted, in epoch seconds.
pub fn boot_time(system: &[u8]) -> Option<u64> {
    system
        .split(|&b| b == b'\n')
        .find_map(|line| line.strip_prefix(b"btime "))
        .and_then(|value| decimal(value.trim_ascii()))
}

fn decimal(digits: &[u8]) -> Option<u64> {
    std::str::from_utf8(digits).ok()?.parse().ok()
}

#[cfg(test)]
mod tests {
    use std::process::{Command, Stdio};

    use proptest::prelude::*;
    use rustix::process::{WaitId, WaitIdOptions, waitid};

    use super::*;

    /// A `/proc/<pid>/stat` line for a program named `name`, started `ticks` after boot.
    fn stat_line(name: &[u8], ticks: u64) -> Vec<u8> {
        let mut line = b"4242 (".to_vec();
        line.extend_from_slice(name);
        line.extend_from_slice(b") S 1 4242 4242 0 -1 4194560 120 0 0 0 0 0 0 0 20 0 1 0 ");
        line.extend_from_slice(ticks.to_string().as_bytes());
        line.extend_from_slice(b" 2531328 166 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 17\n");
        line
    }

    const SYSTEM: &[u8] = b"cpu  1 2 3\nintr 9\nctxt 7\nbtime 1794630000\nprocesses 5\n";

    #[test]
    fn adds_the_whole_seconds_since_boot_to_the_boot_time() {
        let stat = stat_line(b"sh", 12_399);
        assert_eq!(epoch_seconds(SYSTEM, &stat, 100), Some(1_794_630_123));
    }

    #[test]
    fn reads_nothing_from_files_that_say_nothing() {
        let stat = stat_line(b"sh", 1);
        assert_eq!(epoch_seconds(b"cpu 1\n", &stat, 100), None);
        assert_eq!(epoch_seconds(SYSTEM, b"4242 (sh) S 1", 100), None);
        assert_eq!(epoch_seconds(SYSTEM, &stat, 0), None);
        assert_eq!(start_ticks(b"4242 sh S 1"), None);
        assert_eq!(boot_time(b"btime -3\n"), None);
        assert_eq!(boot_time(b"btime \n"), None);
    }

    #[test]
    fn reads_the_pid_its_parent_and_whether_it_exited() {
        let running = stat_line(b"sh", 7);
        let zombie = b"4242 (sh) Z 1 4242 4242 0 -1".as_slice();
        let dead = b"4242 (sh) X 31 4242".as_slice();
        assert_eq!(
            [
                own_pid(&running),
                parent_field(&running),
                parent_field(dead)
            ],
            [Some(4242), Some(1), Some(31)]
        );
        assert_eq!(
            [has_exited(&running), has_exited(zombie), has_exited(dead)],
            [false, true, true]
        );
    }

    #[test]
    fn reads_no_pid_from_a_field_that_isnt_one() {
        assert_eq!(own_pid(b"(sh) S 1"), None);
        assert_eq!(own_pid(b"4242(sh) S 1"), None);
        assert_eq!(own_pid(b"-1 (sh) S 1"), None);
        assert_eq!(own_pid(b"2147483648 (sh) S 1"), None);
        assert_eq!(parent_field(b"4242 (sh) S -1 4242"), None);
        assert_eq!(parent_field(b"4242 (sh) S 2147483648 4242"), None);
        assert_eq!(parent_field(b"4242 (sh) S"), None);
        assert!(!has_exited(b"4242 (sh)"));
        assert!(!has_exited(b"4242 sh Z 1"));
    }

    proptest! {
        /// A program can name itself anything, `) ` and newlines included.
        #[test]
        fn a_programs_name_never_moves_the_fields(
            name in proptest::collection::vec(any::<u8>(), 0..40),
            ticks in any::<u64>(),
        ) {
            let stat = stat_line(&name, ticks);
            prop_assert_eq!(start_ticks(&stat), Some(ticks));
            prop_assert_eq!((own_pid(&stat), parent_field(&stat)), (Some(4242), Some(1)));
            prop_assert!(!has_exited(&stat));
        }
    }

    /// `ps -o lstart=` for `pid`, in UTC, as epoch seconds: `Sat Nov 14 18:14:57 2026`.
    fn ps_start(pid: u32) -> u64 {
        let out = Command::new("ps")
            .args(["-o", "lstart=", "-p", &pid.to_string()])
            .env("LC_ALL", "C")
            .env("TZ", "UTC")
            .output()
            .unwrap();
        let text = String::from_utf8(out.stdout).unwrap();
        let fields: Vec<&str> = text.split_whitespace().collect();
        let [_, month, day, time, year] = fields.as_slice() else {
            panic!("ps said {text:?}");
        };
        let months = [
            "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
        ];
        let month = i64::try_from(months.iter().position(|m| m == month).unwrap()).unwrap() + 1;
        let (year, day): (i64, i64) = (year.parse().unwrap(), day.parse().unwrap());
        let hms: Vec<i64> = time.split(':').map(|n| n.parse().unwrap()).collect();
        // Days from 1970-01-01 to the date (Howard Hinnant's days_from_civil).
        let y = if month <= 2 { year - 1 } else { year };
        let era = y.div_euclid(400);
        let yoe = y - era * 400;
        let doy = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        let days = era * 146_097 + doe - 719_468;
        u64::try_from(days * 86_400 + hms[0] * 3600 + hms[1] * 60 + hms[2]).unwrap()
    }

    fn pid_of(child: &std::process::Child) -> Pid {
        Pid::from_child(child)
    }

    /// pid 1 started at boot, long before this test, so an answer that isn't the pid's own shows.
    #[test]
    fn says_what_ps_says_of_a_process_started_long_ago() {
        let init = Pid::from_raw(1).unwrap();
        assert_eq!(of(init).unwrap().get(), ps_start(1));
    }

    #[test]
    fn says_what_ps_says_of_a_running_process() {
        let mut child = Command::new("sleep")
            .arg("30")
            .stdin(Stdio::null())
            .spawn()
            .unwrap();
        let ours = of(pid_of(&child)).unwrap().get();
        let theirs = ps_start(child.id());
        child.kill().unwrap();
        child.wait().unwrap();
        assert_eq!(ours, theirs);
    }

    /// The holder reads its child's start once the child may already have exited: a zombie
    /// still answers, and answers what it did while it ran.
    #[test]
    fn answers_for_a_child_that_has_exited_and_is_not_yet_reaped() {
        let mut child = Command::new("sh")
            .args(["-c", "read _"])
            .stdin(Stdio::piped())
            .spawn()
            .unwrap();
        let pid = pid_of(&child);
        let running = of(pid).unwrap();
        drop(child.stdin.take());
        waitid(
            WaitId::Pid(pid),
            WaitIdOptions::EXITED | WaitIdOptions::NOWAIT,
        )
        .unwrap();
        let exited = of(pid).unwrap();
        child.wait().unwrap();
        assert_eq!(exited, running);
    }

    #[test]
    fn a_reaped_child_is_absent() {
        let mut child = Command::new("true").spawn().unwrap();
        let pid = pid_of(&child);
        child.wait().unwrap();
        assert!(matches!(of(pid), Err(StartTimeError::Absent(_))));
    }
}
