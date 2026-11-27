use std::ffi::OsString;
use std::io::Write;

use clap::error::ErrorKind;
use clap::{Arg, ArgAction, Command, value_parser};

use crate::gate::{self, Env, Host, Places};
use crate::schema;

/// How a command ended: a contract the scripts that call xtask branch on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Exit {
    Done,
    Failed,
    Usage,
}

impl Exit {
    pub(crate) fn code(self) -> u8 {
        match self {
            Self::Done => 0,
            Self::Failed => 1,
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
        .subcommand(
            Command::new("gate")
                .about("Run one of the Rust gates: fmt, lint, deny, test or test-all")
                .disable_help_flag(true)
                .arg(
                    Arg::new("gate")
                        .required(true)
                        .value_parser(value_parser!(OsString)),
                )
                .arg(
                    Arg::new("partition")
                        .long("partition")
                        .value_parser(value_parser!(OsString)),
                )
                .arg(
                    Arg::new("tests")
                        .action(ArgAction::Append)
                        .value_parser(value_parser!(OsString)),
                ),
        )
        .subcommand(
            Command::new("schema")
                .about(
                    "Write the protocol's JSON Schema and corpus into target/protocol-shadow, \
                     and its zod into packages/protocol/src/gen; with --check, write no zod: \
                     hold the committed zod to it, and schemars to the protocol crates' tests",
                )
                .disable_help_flag(true)
                .arg(Arg::new("check").long("check").action(ArgAction::SetTrue)),
        )
}

/// What a command reaches outside itself: the environment it was started in, where the
/// repository and the cargo home are, and the host that runs tools.
pub(crate) struct World<'a, H: Host> {
    pub(crate) env: Env,
    pub(crate) places: Places,
    pub(crate) host: &'a mut H,
}

/// Runs the command `args` name. A closed stdout or stderr is no reason to fail, so what can't be
/// written is dropped.
pub(crate) fn run<H: Host>(
    args: impl IntoIterator<Item = OsString>,
    world: World<'_, H>,
    out: &mut impl Write,
    err: &mut impl Write,
) -> Exit {
    let line = std::iter::once(OsString::from("cargo xtask")).chain(args);
    let matches = match command().try_get_matches_from(line) {
        Ok(matches) => matches,
        Err(help) if help.kind() == ErrorKind::DisplayHelp => {
            let _ = write!(out, "{}", help.render());
            return Exit::Done;
        }
        Err(error) => {
            let _ = write!(err, "{}", error.render());
            return Exit::Usage;
        }
    };
    let matches = match matches.subcommand() {
        Some(("gate", matches)) => matches,
        Some(("schema", matches)) => {
            let check = matches.get_flag("check");
            return schema::run(
                check,
                schema::KNOWN_MISMATCHES,
                world.env,
                &world.places,
                world.host,
                err,
            );
        }
        _ => return Exit::Usage,
    };
    let name = matches
        .get_one::<OsString>("gate")
        .and_then(|n| n.to_str())
        .unwrap_or_default();
    let tests: Vec<OsString> = matches
        .get_many::<OsString>("tests")
        .into_iter()
        .flatten()
        .cloned()
        .collect();
    let given = matches
        .get_one::<OsString>("partition")
        .map(OsString::as_os_str);
    match gate::parse(name, &tests).and_then(|(gate, tests)| {
        gate::partition(gate, given).map(|partition| (gate, tests, partition))
    }) {
        Ok((gate, tests, partition)) => {
            // The daemon's router test reads the corpus the schema's run writes.
            if gate.takes_tests() {
                let known = schema::KNOWN_MISMATCHES;
                let written = schema::run(
                    false,
                    known,
                    world.env.clone(),
                    &world.places,
                    world.host,
                    err,
                );
                if written != Exit::Done {
                    return written;
                }
            }
            gate::run(
                gate,
                &tests,
                partition,
                world.env,
                &world.places,
                world.host,
                err,
            )
        }
        Err(usage) => {
            let _ = writeln!(err, "{usage}");
            Exit::Usage
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;
    use crate::gate::Status;

    /// A host any gate would fail on: these tests never reach one.
    struct Unreached;

    impl Host for Unreached {
        fn sandboxed(&self) -> bool {
            false
        }
        fn read(&self, _: &Path) -> Result<Option<String>, String> {
            Err("unreached".to_owned())
        }
        fn run(&mut self, _: &[&str], _: &Env, _: bool) -> std::io::Result<Status> {
            Ok(Some(1))
        }
        fn output(&mut self, _: &[&str], _: &Env) -> std::io::Result<Option<String>> {
            Ok(None)
        }
        fn write(&mut self, _: &Path, _: &str) -> std::io::Result<()> {
            Err(std::io::ErrorKind::Unsupported.into())
        }
        fn remove(&mut self, _: &Path) -> std::io::Result<()> {
            Err(std::io::ErrorKind::Unsupported.into())
        }
    }

    fn call(args: &[&str]) -> (Exit, String, String) {
        let (mut out, mut err) = (Vec::new(), Vec::new());
        let world = World {
            env: Env::new(),
            places: Places {
                root: "/a/repo".into(),
                cargo_home: "/home/u/.cargo".into(),
            },
            host: &mut Unreached,
        };
        let exit = run(args.iter().map(OsString::from), world, &mut out, &mut err);
        let text = |bytes: Vec<u8>| String::from_utf8(bytes).unwrap();
        (exit, text(out), text(err))
    }

    /// A host with no cargo config, on which every command succeeds and prints nothing.
    #[derive(Default)]
    struct Recording {
        calls: Vec<String>,
    }

    impl Host for Recording {
        fn sandboxed(&self) -> bool {
            true
        }
        fn read(&self, _: &Path) -> Result<Option<String>, String> {
            Ok(None)
        }
        fn run(&mut self, argv: &[&str], _: &Env, _: bool) -> std::io::Result<Status> {
            self.calls.push(argv.join(" "));
            Ok(Some(0))
        }
        fn output(&mut self, argv: &[&str], _: &Env) -> std::io::Result<Option<String>> {
            self.calls.push(argv.join(" "));
            Ok(None)
        }
        fn write(&mut self, _: &Path, _: &str) -> std::io::Result<()> {
            Err(std::io::ErrorKind::Unsupported.into())
        }
        fn remove(&mut self, _: &Path) -> std::io::Result<()> {
            Err(std::io::ErrorKind::Unsupported.into())
        }
    }

    #[test]
    fn writes_the_schema_before_a_test_gate_and_stops_where_that_fails() {
        const EMIT: &str = "cargo run --quiet --locked -p bazhen-protocol --example emit_schema";
        for gate in ["fmt", "lint", "deny", "test", "test-all"] {
            let mut host = Recording::default();
            let world = World {
                env: Env::new(),
                places: Places {
                    root: "/a/repo".into(),
                    cargo_home: "/home/u/.cargo".into(),
                },
                host: &mut host,
            };
            let exit = run(
                ["gate", gate].map(OsString::from),
                world,
                &mut Vec::new(),
                &mut Vec::new(),
            );
            if gate.starts_with("test") {
                assert_eq!((exit, host.calls), (Exit::Failed, vec![EMIT.to_owned()]));
            } else {
                assert!(!host.calls.contains(&EMIT.to_owned()), "{gate}");
            }
        }
    }

    #[test]
    fn help_lists_the_commands_on_stdout_and_succeeds() {
        let (exit, out, err) = call(&["help"]);
        assert_eq!((exit, err.as_str()), (Exit::Done, ""));
        assert!(out.contains("Usage: cargo xtask <COMMAND>"), "{out}");
        assert!(
            out.contains("\n  gate    Run one of the Rust gates"),
            "{out}"
        );
        assert!(
            out.contains("\n  schema  Write the protocol's JSON Schema"),
            "{out}"
        );
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
            &["gate", "-h"],
            &["schema", "-h"],
            &["schema", "--fix"],
        ] {
            let (exit, out, err) = call(args);
            assert_eq!((exit, out.as_str()), (Exit::Usage, ""), "{args:?}");
            assert!(err.contains("Usage: cargo xtask"), "{args:?}: {err}");
        }
    }

    #[test]
    fn refuses_a_gate_option_before_any_tool_runs() {
        for args in [
            &["gate"][..],
            &["gate", "lint", "--allow-dirty"],
            &["gate", "test", "--", "-x"],
            &["gate", "build"],
        ] {
            let (exit, out, err) = call(args);
            assert_eq!((exit, out.as_str()), (Exit::Usage, ""), "{args:?}");
            assert!(err.contains("sage"), "{args:?}: {err}");
        }
    }

    #[test]
    fn takes_a_partition_for_a_test_gate_and_refuses_one_for_any_other_before_any_tool_runs() {
        for args in [
            &["gate", "test", "--partition", "1/2"][..],
            &["gate", "test-all", "--partition=2/2", "a_test"],
        ] {
            let mut host = Recording::default();
            let world = World {
                env: Env::new(),
                places: Places {
                    root: "/a/repo".into(),
                    cargo_home: "/home/u/.cargo".into(),
                },
                host: &mut host,
            };
            let exit = run(
                args.iter().map(OsString::from),
                world,
                &mut Vec::new(),
                &mut Vec::new(),
            );
            assert_eq!(exit, Exit::Failed, "{args:?}");
            assert!(!host.calls.is_empty(), "{args:?}");
        }
        for args in [
            &["gate", "lint", "--partition", "1/2"][..],
            &["gate", "test", "--partition", "3/2"],
            &["gate", "test", "--partition"],
        ] {
            let (exit, out, err) = call(args);
            assert_eq!((exit, out.as_str()), (Exit::Usage, ""), "{args:?}");
            assert!(err.contains("partition"), "{args:?}: {err}");
        }
    }

    #[test]
    fn each_end_has_its_own_exit_code() {
        assert_eq!(
            [Exit::Done, Exit::Failed, Exit::Usage].map(Exit::code),
            [0, 1, 2]
        );
    }
}
