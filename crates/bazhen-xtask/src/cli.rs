use std::ffi::OsString;
use std::io::Write;

use clap::Command;
use clap::error::ErrorKind;

/// How a command ended: a contract the scripts that call xtask branch on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Exit {
    Done,
    Usage,
}

impl Exit {
    pub(crate) fn code(self) -> u8 {
        match self {
            Self::Done => 0,
            Self::Usage => 2,
        }
    }
}

fn command() -> Command {
    Command::new("xtask")
        .bin_name("cargo xtask")
        .about("The repository's own commands.")
        .disable_help_flag(true)
        .disable_version_flag(true)
        .subcommand_required(true)
}

/// Runs the command `args` name. A closed stdout or stderr is no reason to fail, so what can't be
/// written is dropped.
pub(crate) fn run(
    args: impl IntoIterator<Item = OsString>,
    out: &mut impl Write,
    err: &mut impl Write,
) -> Exit {
    let line = std::iter::once(OsString::from("cargo xtask")).chain(args);
    match command().try_get_matches_from(line) {
        Ok(_) => Exit::Usage,
        Err(help) if help.kind() == ErrorKind::DisplayHelp => {
            let _ = write!(out, "{}", help.render());
            Exit::Done
        }
        Err(error) => {
            let _ = write!(err, "{}", error.render());
            Exit::Usage
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(args: &[&str]) -> (Exit, String, String) {
        let (mut out, mut err) = (Vec::new(), Vec::new());
        let exit = run(args.iter().map(OsString::from), &mut out, &mut err);
        let text = |bytes: Vec<u8>| String::from_utf8(bytes).unwrap();
        (exit, text(out), text(err))
    }

    #[test]
    fn refuses_no_command_an_unknown_one_and_the_flags_clap_adds_by_default() {
        for args in [
            &[][..],
            &["nope"],
            &["--help"],
            &["-h"],
            &["--version"],
            &["-V"],
        ] {
            let (exit, out, err) = call(args);
            assert_eq!((exit, out.as_str()), (Exit::Usage, ""), "{args:?}");
            assert!(err.contains("Usage: cargo xtask"), "{args:?}: {err}");
        }
    }

    #[test]
    fn a_usage_refusal_exits_2_and_success_0() {
        assert_eq!((Exit::Done.code(), Exit::Usage.code()), (0, 2));
    }
}
