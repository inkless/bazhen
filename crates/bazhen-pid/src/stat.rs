//! The fields of a `/proc/<pid>/stat` line. Field 2 is the program's name in parentheses, which
//! can hold anything, `)` and spaces included, so every field after it is counted from the last
//! `)`.

/// Field `n`, from 3 on, of a `/proc/<pid>/stat` line: the state, field 3, is the first token after
/// the last `)`.
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

/// Field 6 of a `/proc/<pid>/stat` line: the id of the session the process is in.
pub fn session_field(stat: &[u8]) -> Option<i32> {
    stat_field(stat, 6)
        .and_then(decimal)
        .and_then(|sid| i32::try_from(sid).ok())
}

/// Field 22 of a `/proc/<pid>/stat` line, the start in clock ticks since boot.
pub fn start_ticks(stat: &[u8]) -> Option<u64> {
    stat_field(stat, 22).and_then(decimal)
}

/// Whether a `/proc/<pid>/stat` line is of a process that has exited: a zombie, or one dead.
pub fn has_exited(stat: &[u8]) -> bool {
    matches!(stat_field(stat, 3), Some(b"Z" | b"X"))
}

fn decimal(digits: &[u8]) -> Option<u64> {
    std::str::from_utf8(digits).ok()?.parse().ok()
}

#[cfg(test)]
mod tests {
    use proptest::prelude::*;

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

    #[test]
    fn reads_the_pid_its_parent_its_session_and_whether_it_exited() {
        let running = stat_line(b"sh", 7);
        let zombie = b"4242 (sh) Z 1 4242 4241 0 -1".as_slice();
        let dead = b"4242 (sh) X 31 4242".as_slice();
        assert_eq!(
            [
                own_pid(&running),
                parent_field(&running),
                parent_field(dead),
                session_field(&running),
                session_field(zombie)
            ],
            [Some(4242), Some(1), Some(31), Some(4242), Some(4241)]
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
        assert_eq!(session_field(b"4242 (sh) S 1 4242 -1"), None);
        assert_eq!(session_field(b"4242 (sh) S 1 4242 2147483648"), None);
        assert_eq!(session_field(b"4242 (sh) S 1 4242"), None);
        assert_eq!(start_ticks(b"4242 sh S 1"), None);
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
            prop_assert_eq!(session_field(&stat), Some(4242));
            prop_assert!(!has_exited(&stat));
        }
    }
}
