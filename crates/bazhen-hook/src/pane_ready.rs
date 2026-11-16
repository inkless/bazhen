//! `bazhen-hook pane-ready <tty> <shell-pid>`: what tmux runs, inside the script that types a
//! restart's line back, just before the paste, to say whether the shell's line editor would read
//! it. It exits 0 only when the terminal is out of canonical mode, no input waits on it, and the
//! shell's own process group holds its foreground. Input typed ahead while the shell started
//! (`vim notes`, Enter) is read before the paste, so whatever it starts would take the line; a
//! program that holds the foreground, or a `read` in the shell's own group, which reads in
//! canonical mode, would take it too. Anything it can't read counts as not ready.

use std::fs::OpenOptions;
use std::os::unix::fs::OpenOptionsExt as _;
use std::process::Command;

use rustix::fs::OFlags;
use rustix::io::ioctl_fionread;
use rustix::termios::{LocalModes, tcgetattr};

/// The status to exit with: 0 only when ready. The hook client exits 0 on what it can't do, but
/// here 0 is "ready", so whatever can't be read is not.
pub(crate) fn run(args: impl Iterator<Item = String>) -> i32 {
    i32::from(!ready(args).unwrap_or(false))
}

fn ready(mut args: impl Iterator<Item = String>) -> Option<bool> {
    let tty = args.next()?;
    let shell: i32 = args.next()?.parse().ok()?;
    if !tty.starts_with("/dev/") || shell <= 1 || args.next().is_some() {
        return None;
    }
    // NOCTTY: the check runs outside the shell's session, and must never take its terminal.
    let flags = i32::try_from((OFlags::NOCTTY | OFlags::NONBLOCK).bits()).ok()?;
    let fd = OpenOptions::new()
        .read(true)
        .custom_flags(flags)
        .open(&tty)
        .ok()?;
    let canonical = tcgetattr(&fd)
        .ok()?
        .local_modes
        .contains(LocalModes::ICANON);
    let pending = ioctl_fionread(&fd).ok()?;
    // A process outside the terminal's session can't ask it for its foreground group, so ps
    // reads it from the shell's own process.
    let out = Command::new("ps")
        .args(["-o", "tpgid=", "-p", &shell.to_string()])
        .output()
        .ok()?;
    let foreground = foreground_group(&String::from_utf8_lossy(&out.stdout))?;
    Some(editor_reads(canonical, pending, foreground, shell))
}

/// Whether a line typed now would reach the shell's line editor: out of canonical mode, with
/// nothing typed ahead of it, and the shell, the leader of its own group, in the foreground.
pub fn editor_reads(canonical: bool, pending: u64, foreground: i32, shell: i32) -> bool {
    !canonical && pending == 0 && foreground == shell
}

/// The foreground group `ps -o tpgid=` printed, or None for anything but one positive number.
pub fn foreground_group(printed: &str) -> Option<i32> {
    printed.trim().parse().ok().filter(|group| *group > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_only_a_shell_at_its_own_raw_prompt_with_nothing_typed_ahead() {
        assert_eq!(
            [
                editor_reads(false, 0, 42, 42),
                editor_reads(true, 0, 42, 42),
                editor_reads(false, 10, 42, 42),
                editor_reads(false, 0, 77, 42),
            ],
            [true, false, false, false]
        );
    }

    #[test]
    fn reads_the_foreground_group_ps_prints_and_nothing_else() {
        assert_eq!(
            [
                foreground_group(" 4242\n"),
                foreground_group("-1\n"),
                foreground_group("0"),
                foreground_group(""),
                foreground_group("12 13"),
            ],
            [Some(4242), None, None, None, None]
        );
    }
}
