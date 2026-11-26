//! A `paste`: text typed into the child only when the program would read it as text, as a line
//! editor at its prompt does. Checked and queued in one turn of the holder's loop, so nothing any
//! connection sends comes between the check and the queueing. The rule is `bazhen-hook
//! pane-ready`'s, which tmux runs for the same paste, plus the holder's own input queue, which
//! tmux has no equivalent of: out of canonical mode, nothing typed ahead or queued, and the child,
//! the leader of its own group, holding the terminal's foreground. A shell running a foreground
//! job is not ready, as under tmux.
//!
//! Nothing here logs, and no refusal quotes the text.

use std::ffi::CStr;
use std::fs::OpenOptions;
use std::io;
use std::os::unix::ffi::OsStrExt as _;
use std::os::unix::fs::OpenOptionsExt as _;

use bazhen_holder_proto::body::ErrorCode;
use rustix::event::{PollFd, PollFlags, Timespec, poll};
use rustix::fs::{Dev, OFlags, fstat};
use rustix::io::ioctl_fionread;
use rustix::process::Pid;
use rustix::termios::{LocalModes, tcgetattr};

const PASTE_START: &[u8] = b"\x1b[200~";
const PASTE_END: &[u8] = b"\x1b[201~";

/// What the terminal's line discipline says of its input.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LineState {
    /// The program reads whole lines, as the terminal's own editing gives them.
    pub canonical: bool,
    /// Bytes typed and not yet read.
    pub pending: u64,
}

/// Reads the slave `name`'s line state, opened for the call alone and closed before it returns,
/// so the holder never keeps a slave: on Linux, the master reads EIO only once no process holds
/// one. `O_NOCTTY` keeps the open from making the terminal anyone's controlling terminal, and the
/// close is never the slave's last while the child holds its own, so it hangs nothing up; once the
/// child has closed every one of its own, the master reads EIO as soon as this one closes too.
/// Read only if `name` still names `device`, the slave the terminal was opened with.
///
/// # Errors
///
/// When the slave can't be opened or read, or `name` now names another device.
pub fn line_state(name: &CStr, device: Dev) -> io::Result<LineState> {
    let flags = i32::try_from((OFlags::NOCTTY | OFlags::NONBLOCK).bits())
        .map_err(|_| io::Error::other("open flags out of range"))?;
    let slave = OpenOptions::new()
        .read(true)
        .custom_flags(flags)
        .open(std::ffi::OsStr::from_bytes(name.to_bytes()))?;
    if fstat(&slave)?.st_rdev != device {
        return Err(io::Error::other("the slave's name names another device"));
    }
    // On Linux a write to the master reaches the line discipline later, from a kernel worker, so
    // FIONREAD alone can miss a byte just written. Polling the slave for input finishes that
    // hand-off first when nothing is yet readable, which makes the count exact.
    loop {
        match poll(
            &mut [PollFd::new(&slave, PollFlags::IN)],
            Some(&Timespec::default()),
        ) {
            Err(rustix::io::Errno::INTR) => {}
            done => {
                done?;
                break;
            }
        }
    }
    Ok(LineState {
        canonical: tcgetattr(&slave)?.local_modes.contains(LocalModes::ICANON),
        pending: ioctl_fionread(&slave)?,
    })
}

/// Everything a paste's readiness is decided from, read in the turn that queues it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Readings {
    /// Bytes the holder has queued for the child and not yet written.
    pub queued: usize,
    /// `None` when it couldn't be read.
    pub line: Option<LineState>,
    /// The terminal's foreground group, `None` when it has none.
    pub foreground: Option<Pid>,
    pub child: Pid,
}

/// Why the program wouldn't read a paste as text now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotReady {
    Queued,
    TypedAhead,
    Canonical,
    Foreground,
    Unreadable,
}

impl NotReady {
    pub const fn why(self) -> &'static str {
        match self {
            Self::Queued => "input the holder queued for the program is still unwritten",
            Self::TypedAhead => "input typed ahead waits unread",
            Self::Canonical => "the program reads whole lines, not at a line editor",
            Self::Foreground => "another process group holds the terminal's foreground",
            Self::Unreadable => "the terminal's line state can't be read",
        }
    }
}

/// Whether a paste would be read as text now, as the first check that fails says.
///
/// # Errors
///
/// The first of, in order: input queued, the line state unreadable, input typed ahead, canonical
/// mode, another group in the foreground.
pub fn ready(readings: &Readings) -> Result<(), NotReady> {
    if readings.queued > 0 {
        return Err(NotReady::Queued);
    }
    let line = readings.line.ok_or(NotReady::Unreadable)?;
    if line.pending > 0 {
        return Err(NotReady::TypedAhead);
    }
    if line.canonical {
        return Err(NotReady::Canonical);
    }
    if readings.foreground != Some(readings.child) {
        return Err(NotReady::Foreground);
    }
    Ok(())
}

/// The engine has failed, so whether the program asked for bracketed paste is unknown.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ModeUnknown;

/// The bytes a paste types: `text`, marked with the bracketed-paste sequences when `brackets` is
/// true or the program has bracketed paste on (`bracketed`, `None` when unknown).
///
/// # Errors
///
/// `ModeUnknown` when unmarked and `bracketed` is `None`.
pub fn typed(text: &str, brackets: bool, bracketed: Option<bool>) -> Result<Vec<u8>, ModeUnknown> {
    let mark = brackets || bracketed.ok_or(ModeUnknown)?;
    Ok(if mark {
        [PASTE_START, text.as_bytes(), PASTE_END].concat()
    } else {
        text.as_bytes().to_vec()
    })
}

/// Why a paste typed nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PasteRefused {
    /// The paste names a generation that isn't the current one.
    Stale,
    Exited,
    NotReady(NotReady),
    ModeUnknown,
    /// The input queue wouldn't take it. Never once the gate has passed, as the queue is then
    /// empty and a request's text fits it whole; answered rather than assumed.
    Full,
}

impl PasteRefused {
    /// The `error` it is answered with: its code and why, never the text.
    pub const fn answer(self) -> (ErrorCode, &'static str) {
        match self {
            Self::Stale => (
                ErrorCode::StaleGeneration,
                "the paste is for a child a respawn has replaced",
            ),
            Self::Exited => (ErrorCode::Exited, "the child has exited"),
            Self::NotReady(why) => (ErrorCode::NotReady, why.why()),
            Self::ModeUnknown => (
                ErrorCode::Unavailable,
                "the terminal engine has failed, so whether the program asked for bracketed \
                 paste is unknown",
            ),
            Self::Full => (ErrorCode::InputFull, "the input queue can't take the paste"),
        }
    }
}

#[cfg(test)]
mod tests {
    use proptest::prelude::*;

    use std::collections::BTreeMap;
    use std::time::{Duration, Instant};

    use bazhen_holder_proto::body::{Argv, Env, Generation, NonEmpty, ProcessSpec};

    use super::*;
    use crate::child::Reaper;
    use crate::holder::{Discard, Holder};
    use crate::pty::{self, Pty, WindowSize};

    fn pid(n: i32) -> Pid {
        Pid::from_raw(n).unwrap()
    }

    fn at_prompt() -> Readings {
        Readings {
            queued: 0,
            line: Some(LineState {
                canonical: false,
                pending: 0,
            }),
            foreground: Some(pid(42)),
            child: pid(42),
        }
    }

    #[test]
    fn a_shell_at_its_own_raw_prompt_with_nothing_typed_or_queued_is_ready() {
        assert_eq!(ready(&at_prompt()), Ok(()));
    }

    #[test]
    fn each_failed_check_refuses_naming_itself() {
        let line = |canonical, pending| Some(LineState { canonical, pending });
        assert_eq!(
            [
                Readings {
                    queued: 1,
                    ..at_prompt()
                },
                Readings {
                    line: None,
                    ..at_prompt()
                },
                Readings {
                    line: line(false, 3),
                    ..at_prompt()
                },
                Readings {
                    line: line(true, 0),
                    ..at_prompt()
                },
                Readings {
                    foreground: Some(pid(77)),
                    ..at_prompt()
                },
                Readings {
                    foreground: None,
                    ..at_prompt()
                },
            ]
            .map(|readings| ready(&readings)),
            [
                Err(NotReady::Queued),
                Err(NotReady::Unreadable),
                Err(NotReady::TypedAhead),
                Err(NotReady::Canonical),
                Err(NotReady::Foreground),
                Err(NotReady::Foreground),
            ]
        );
    }

    #[test]
    fn a_paste_is_marked_when_asked_or_when_the_program_asked_and_unknown_only_when_it_matters() {
        let marked = b"\x1b[200~ls\x1b[201~".to_vec();
        assert_eq!(
            [
                typed("ls", true, Some(false)),
                typed("ls", true, None),
                typed("ls", false, Some(true)),
                typed("ls", false, Some(false)),
                typed("ls", false, None),
            ],
            [
                Ok(marked.clone()),
                Ok(marked.clone()),
                Ok(marked),
                Ok(b"ls".to_vec()),
                Err(ModeUnknown),
            ]
        );
    }

    #[test]
    fn every_refusal_is_answered_in_a_fixed_sentence() {
        let refusals = [
            PasteRefused::Stale,
            PasteRefused::Exited,
            PasteRefused::ModeUnknown,
            PasteRefused::Full,
        ]
        .into_iter()
        .chain(
            [
                NotReady::Queued,
                NotReady::TypedAhead,
                NotReady::Canonical,
                NotReady::Foreground,
                NotReady::Unreadable,
            ]
            .map(PasteRefused::NotReady),
        );
        let codes: Vec<_> = refusals.map(|r| r.answer().0.as_str()).collect();
        assert_eq!(
            codes,
            [
                "stale-generation",
                "exited",
                "unavailable",
                "input-full",
                "not-ready",
                "not-ready",
                "not-ready",
                "not-ready",
                "not-ready",
            ]
        );
    }

    fn holder(script: &str) -> Holder<Discard> {
        let mut env = BTreeMap::new();
        env.insert("PATH".to_owned(), std::env::var("PATH").unwrap());
        let process = ProcessSpec {
            argv: Argv::new(["sh", "-c", script].map(str::to_owned).to_vec()).unwrap(),
            cwd: NonEmpty::new("/").unwrap(),
            env: Env::new(env).unwrap(),
            generation: Generation::new(0).unwrap(),
            theme: None,
        };
        let reaper = Reaper::new().unwrap();
        let (pty, slave) = Pty::open(WindowSize::clamped(80, 24)).unwrap();
        let child = pty::spawn(slave, &process, &reaper).unwrap();
        Holder::new(pty, reaper, child, process.generation, Discard)
    }

    /// The engine's mode is asked only of a program that would read the paste: an unmarked paste
    /// with the mode unknown is not ready while the program reads whole lines, and unavailable
    /// once it reads keys.
    #[test]
    #[ignore = "signals processes; runs in make test-real ARGS=rust"]
    fn an_unknown_mode_is_answered_only_once_the_program_is_ready() {
        bazhen_test_signal::require_sandbox().unwrap();
        let mut holder = holder("read _; stty -icanon -echo; exec head -c 1 >/dev/null");
        let generation = Generation::new(0).unwrap();
        let paste = |holder: &mut Holder<Discard>| holder.paste(generation, "ls", false, None);
        let canonical = PasteRefused::NotReady(NotReady::Canonical);
        assert_eq!(paste(&mut holder), Err(canonical));
        holder.offer_input(b"\n").unwrap();
        holder.flush_input();
        let give_up = Instant::now() + Duration::from_secs(5);
        let answer = loop {
            let answer = paste(&mut holder);
            if answer != Err(canonical)
                && answer != Err(PasteRefused::NotReady(NotReady::TypedAhead))
                || Instant::now() > give_up
            {
                break answer;
            }
            std::thread::sleep(Duration::from_millis(10));
        };
        assert_eq!(answer, Err(PasteRefused::ModeUnknown));
    }

    proptest! {
        #[test]
        fn ready_only_when_every_check_holds(
            queued in 0..3_usize,
            readable in any::<bool>(),
            canonical in any::<bool>(),
            pending in 0..3_u64,
            foreground in prop::option::of(41..44_i32),
        ) {
            let readings = Readings {
                queued,
                line: readable.then_some(LineState { canonical, pending }),
                foreground: foreground.map(pid),
                child: pid(42),
            };
            let all = queued == 0 && readable && !canonical && pending == 0 && foreground == Some(42);
            prop_assert_eq!(ready(&readings).is_ok(), all);
        }

        #[test]
        fn a_paste_types_its_text_exactly_inside_at_most_one_pair_of_marks(
            text in "[^\\p{Cc}]{0,32}",
            brackets in any::<bool>(),
            bracketed in any::<bool>(),
        ) {
            let bytes = typed(&text, brackets, Some(bracketed)).unwrap();
            let inner = if brackets || bracketed {
                bytes
                    .strip_prefix(PASTE_START)
                    .and_then(|b| b.strip_suffix(PASTE_END))
                    .map(<[u8]>::to_vec)
            } else {
                Some(bytes)
            };
            prop_assert_eq!(inner, Some(text.into_bytes()));
        }
    }
}
