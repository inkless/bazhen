//! One of the Rust gates `moon run :check` relies on (docs/standards/rust.md). Each gate's command
//! is fixed here, and runs in an environment no caller's flags reach: a flag can switch every lint
//! off (`--cap-lints allow`), whether it comes from the environment, a cargo config in any parent
//! directory, or an argument, and a cargo alias can stand in for a whole gate.

use std::collections::BTreeMap;
use std::ffi::{OsStr, OsString};
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::cargo_config::{self, Read};
use crate::cli::Exit;
use crate::tools;

/// A gate, as `cargo xtask gate` names it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Gate {
    Fmt,
    Lint,
    Deny,
    Test,
    /// The tests ignored as signalling processes they didn't start too, which only a sandbox runs.
    TestAll,
}

pub(crate) const NAMES: [&str; 5] = ["fmt", "lint", "deny", "test", "test-all"];

// Each subcommand's own binary, called directly: cargo would resolve `cargo clippy` through any
// alias first, and an alias can name a command that passes. Every gate that compiles overrides
// any rustc wrapper or compiler a cargo config names.
const FMT: &[&str] = &["cargo-fmt", "--all", "--check"];
const LINT: &[&str] = &[
    "cargo-clippy",
    "clippy",
    "--quiet",
    "--workspace",
    "--all-targets",
    "--all-features",
    "--locked",
    "--config",
    "build.rustc-wrapper=\"\"",
    "--config",
    "build.rustc-workspace-wrapper=\"\"",
    "--config",
    "build.rustc=\"rustc\"",
    "--",
    "-D",
    "warnings",
];
// The holder as it ships, which `lint` checks after the workspace: the workspace pass builds it
// with every feature, and its tests' dev-dependency on itself turns sandbox-tripwire on too, so
// only a pass of its lib and binary alone sees it without.
const SHIPPED_LINT: &[&str] = &[
    "cargo-clippy",
    "clippy",
    "--quiet",
    "-p",
    "bazhen-holder",
    "--lib",
    "--bins",
    "--locked",
    "--config",
    "build.rustc-wrapper=\"\"",
    "--config",
    "build.rustc-workspace-wrapper=\"\"",
    "--config",
    "build.rustc=\"rustc\"",
    "--",
    "-D",
    "warnings",
];
// Each crate of the workspace on its own, which `lint` checks last: with `-p`, cargo resolves
// features over that crate alone, so a feature it takes from a neighbour in the workspace pass is
// missing here, and its build fails. The crate's name goes between the two halves.
const ALONE_LINT_HEAD: &[&str] = &["cargo-clippy", "clippy", "--quiet", "-p"];
const ALONE_LINT_TAIL: &[&str] = &[
    "--all-targets",
    "--locked",
    "--config",
    "build.rustc-wrapper=\"\"",
    "--config",
    "build.rustc-workspace-wrapper=\"\"",
    "--config",
    "build.rustc=\"rustc\"",
    "--",
    "-D",
    "warnings",
];
// The workspace's crates, as cargo lists them: `--no-deps` leaves out every dependency, so each
// package it prints is a member.
pub(crate) const MEMBERS: &[&str] = &[
    "cargo",
    "metadata",
    "--no-deps",
    "--format-version",
    "1",
    "--locked",
];
const DENY: &[&str] = &["cargo-deny", "deny", "--locked", "check"];
const TEST: &[&str] = &[
    "cargo-nextest",
    "nextest",
    "run",
    "--workspace",
    "--all-features",
    "--locked",
    "--config",
    "build.rustc-wrapper=\"\"",
    "--config",
    "build.rustc-workspace-wrapper=\"\"",
    "--config",
    "build.rustc=\"rustc\"",
    "--status-level",
    "fail",
    "--final-status-level",
    "fail",
];
const TEST_ALL: &[&str] = &[
    "cargo-nextest",
    "nextest",
    "run",
    "--workspace",
    "--all-features",
    "--locked",
    "--config",
    "build.rustc-wrapper=\"\"",
    "--config",
    "build.rustc-workspace-wrapper=\"\"",
    "--config",
    "build.rustc=\"rustc\"",
    "--run-ignored",
    "all",
    "--status-level",
    "fail",
    "--final-status-level",
    "fail",
];

const INSTALL_TOOLCHAIN: &str = "The Rust gates need cargo, rustfmt and clippy: install rustup, \
                                 which installs the toolchain rust-toolchain.toml pins.";

impl Gate {
    pub(crate) fn named(name: &str) -> Option<Self> {
        match name {
            "fmt" => Some(Self::Fmt),
            "lint" => Some(Self::Lint),
            "deny" => Some(Self::Deny),
            "test" => Some(Self::Test),
            "test-all" => Some(Self::TestAll),
            _ => None,
        }
    }

    /// The commands the gate runs, in order.
    pub(crate) fn commands(self) -> &'static [&'static [&'static str]] {
        match self {
            Self::Fmt => &[FMT],
            Self::Lint => &[LINT, SHIPPED_LINT],
            Self::Deny => &[DENY],
            Self::Test => &[TEST],
            Self::TestAll => &[TEST_ALL],
        }
    }

    /// The command that says the gate's tool is installed.
    fn probe(self) -> &'static [&'static str] {
        match self {
            Self::Fmt => &["cargo-fmt", "--version"],
            Self::Lint => &["cargo-clippy", "--version"],
            Self::Deny => &["cargo-deny", "--version"],
            Self::Test | Self::TestAll => &["cargo-nextest", "nextest", "--version"],
        }
    }

    /// What to install when the probe fails.
    fn hint(self) -> String {
        match self {
            Self::Fmt | Self::Lint => INSTALL_TOOLCHAIN.to_owned(),
            Self::Deny | Self::Test | Self::TestAll => format!(
                "The Rust gates need cargo-nextest and cargo-deny. Install them once: {}",
                tools::install_command(&["cargo-nextest", "cargo-deny"])
            ),
        }
    }

    fn takes_tests(self) -> bool {
        matches!(self, Self::Test | Self::TestAll)
    }
}

/// The gate `args` name, and for `test` and `test-all` the names of the tests to run. Anything else
/// is refused, so no flag reaches the tool: a test name is a plain path, never an option.
pub(crate) fn parse(name: &str, tests: &[OsString]) -> Result<(Gate, Vec<String>), String> {
    let usage = || {
        format!(
            "usage: cargo xtask gate <{}>, or test <name>... test-all takes names too. A gate \
             takes no other arguments: its command is fixed in crates/bazhen-xtask/src/gate.rs.",
            NAMES.join("|")
        )
    };
    let gate = Gate::named(name).ok_or_else(usage)?;
    if !tests.is_empty() && !gate.takes_tests() {
        return Err(usage());
    }
    let names: Option<Vec<String>> = tests
        .iter()
        .map(|t| t.to_str().filter(|t| is_test_name(t)).map(str::to_owned))
        .collect();
    names.map(|names| (gate, names)).ok_or_else(usage)
}

/// `name::path::to_test`: words of letters, digits and `_`, joined by `::`.
fn is_test_name(name: &str) -> bool {
    name.split("::")
        .all(|w| !w.is_empty() && w.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'))
}

/// Variables that change what cargo, rustc, clippy, nextest or proptest run, or with which flags,
/// and the root scripts/xtask.sh names, which is xtask's alone.
const REMOVED: [&str; 13] = [
    "BAZHEN_XTASK_ROOT",
    "PROPTEST_CASES",
    "RUSTFLAGS",
    "RUSTDOCFLAGS",
    "RUSTC",
    "RUSTC_WRAPPER",
    "RUSTC_WORKSPACE_WRAPPER",
    "RUSTDOC",
    "RUSTFMT",
    "RUSTUP_TOOLCHAIN",
    "CARGO",
    "CLIPPY_CONF_DIR",
    "CLIPPY_ARGS",
];

/// The variables a gate keeps although their prefix is removed: how many jobs cargo builds with and
/// how many tests nextest runs at once, which a shared host caps. Neither changes what is built or
/// run, or with which flags.
const KEPT: [&str; 2] = ["CARGO_BUILD_JOBS", "NEXTEST_TEST_THREADS"];

/// Whether a variable is one a gate removes: those in `REMOVED`, and each with a prefix cargo,
/// rustc or nextest read flags from, but for the target directory and those in `KEPT`.
fn removed(name: &OsStr) -> bool {
    let bytes = name.as_encoded_bytes();
    if KEPT.iter().any(|k| k.as_bytes() == bytes) {
        return false;
    }
    let except = |prefix: &[u8], kept: &[u8]| bytes.starts_with(prefix) && bytes != kept;
    REMOVED.iter().any(|r| r.as_bytes() == bytes)
        || except(b"CARGO_BUILD_", b"CARGO_BUILD_TARGET_DIR")
        || except(b"CARGO_TARGET_", b"CARGO_TARGET_DIR")
        || [&b"CARGO_ALIAS_"[..], b"CARGO_PROFILE_", b"NEXTEST_"]
            .iter()
            .any(|p| bytes.starts_with(p))
}

/// The seed every proptest draws its cases from unless the caller gives one, so that a run tests
/// the change and not the draw: the scheduled job in `.github/workflows/fuzz.yml` gives a random
/// one. Changing it changes every property's cases.
pub(crate) const PROPTEST_SEED: &str = "1";

/// `seed` if proptest reads it as a seed, a u64; anything else it would replace with a random one.
fn proptest_seed(seed: Option<&OsStr>) -> OsString {
    let seed = seed.and_then(OsStr::to_str).filter(|s| {
        (1..=20).contains(&s.len())
            && s.bytes().all(|b| b.is_ascii_digit())
            && s.parse::<u64>().is_ok()
    });
    OsString::from(seed.unwrap_or(PROPTEST_SEED))
}

/// The environment a gate runs in, by name.
pub(crate) type Env = BTreeMap<OsString, OsString>;

/// The environment a gate runs in: the caller's, less everything that changes the build's flags,
/// tools or test cases, with proptest's seed fixed unless the caller gave one.
/// `CARGO_ENCODED_RUSTFLAGS`, set and empty, outranks every other source of rustflags, cargo config
/// in any parent directory included.
pub(crate) fn gate_env(env: impl IntoIterator<Item = (OsString, OsString)>) -> Env {
    let env: Env = env.into_iter().collect();
    let seed = proptest_seed(
        env.get(OsStr::new("PROPTEST_RNG_SEED"))
            .map(OsString::as_os_str),
    );
    let mut clean: Env = env.into_iter().filter(|(name, _)| !removed(name)).collect();
    clean.insert("PROPTEST_RNG_SEED".into(), seed);
    clean.insert("CARGO_ENCODED_RUSTFLAGS".into(), OsString::new());
    clean.insert("CARGO_ENCODED_RUSTDOCFLAGS".into(), OsString::new());
    clean
}

/// The reason a test that signals processes it didn't start is ignored outside a sandbox, as
/// `scripts/signal-paths.ts` names it.
const SIGNALS_IGNORE: &str = "signals processes; runs in moon run :test-real -- rust";

/// Why a gate won't run on this host: test-all runs tests only a sandbox may.
fn sandbox_refusal(gate: Gate, sandboxed: bool) -> Option<String> {
    (gate == Gate::TestAll && !sandboxed).then(|| {
        format!(
            "Refusing to run: cargo xtask gate test-all includes each test ignored as \
             \"{SIGNALS_IGNORE}\": such a test signals processes it didn't start, so it runs only \
             on a host that exists to be thrown away: the test container (moon run :test-real) or a CI \
             runner, each carrying a root-owned /etc/bazhen-disposable-host. Never create that \
             file on a machine you work on."
        )
    })
}

/// How a tool ended: its exit code, or `None` when a signal ended it.
pub(crate) type Status = Option<i32>;

/// What a gate reaches outside itself.
pub(crate) trait Host {
    /// Whether this host is a sandbox, which may run `test-all`.
    fn sandboxed(&self) -> bool;
    /// A cargo config's text, `None` when there is none.
    fn read(&self, path: &Path) -> Result<Option<String>, String>;
    /// Runs `argv` in `env`, from the repository's root, its output discarded when `quiet`.
    fn run(&mut self, argv: &[&str], env: &Env, quiet: bool) -> std::io::Result<Status>;
    /// What `argv` printed to stdout, run as `run` does, `None` when it did not exit 0.
    fn output(&mut self, argv: &[&str], env: &Env) -> std::io::Result<Option<String>>;
}

/// The names of the crates `cargo metadata --no-deps` printed as `json`.
pub(crate) fn member_names(json: &str) -> Result<Vec<String>, String> {
    let metadata: serde_json::Value = serde_json::from_str(json).map_err(|e| e.to_string())?;
    let packages = metadata
        .get("packages")
        .and_then(serde_json::Value::as_array)
        .ok_or("no `packages` list")?;
    let mut names = packages
        .iter()
        .map(|p| p.get("name").and_then(serde_json::Value::as_str))
        .map(|name| name.map(str::to_owned).ok_or("a package with no name"))
        .collect::<Result<Vec<_>, _>>()?;
    if names.is_empty() {
        return Err("no crate".to_owned());
    }
    names.sort();
    Ok(names)
}

/// Where a run looks for cargo configs: the repository, and the cargo home.
pub(crate) struct Places {
    pub(crate) root: PathBuf,
    pub(crate) cargo_home: PathBuf,
}

/// Runs `gate` with `tests`, in `env` cleaned of every flag a caller could pass.
pub(crate) fn run(
    gate: Gate,
    tests: &[String],
    env: Env,
    places: &Places,
    host: &mut impl Host,
    err: &mut impl Write,
) -> Exit {
    if let Some(refused) = sandbox_refusal(gate, host.sandboxed()) {
        let _ = writeln!(err, "{refused}");
        return Exit::Usage;
    }
    let env = gate_env(env);
    // Every gate, fmt and deny too: a config's [env] could put another cargo-fmt or cargo-deny first
    // on PATH for a cargo that starts them.
    let configs = cargo_config::outside_configs(&places.root, &places.cargo_home);
    let read: Read<'_> = &|path| host.read(path);
    let mut failures = cargo_config::config_failures(&configs, read);
    failures.extend(cargo_config::shadow_failure(&places.root, read));
    if !failures.is_empty() {
        let _ = writeln!(err, "{}", failures.join("\n"));
        return Exit::Failed;
    }
    if !matches!(host.run(gate.probe(), &env, true), Ok(Some(0))) {
        let _ = writeln!(err, "{}", gate.hint());
        return Exit::Failed;
    }
    for command in gate.commands() {
        let argv: Vec<&str> = command
            .iter()
            .copied()
            .chain(tests.iter().map(String::as_str))
            .collect();
        if let Some(exit) = failed(host.run(&argv, &env, false), &argv, err) {
            return exit;
        }
    }
    if gate == Gate::Lint {
        let members = match host.output(MEMBERS, &env) {
            Ok(Some(json)) => member_names(&json),
            Ok(None) => Err("it failed".to_owned()),
            Err(error) => Err(error.to_string()),
        };
        let members = match members {
            Ok(members) => members,
            Err(why) => {
                let _ = writeln!(err, "cargo metadata, which names the crates to lint: {why}");
                return Exit::Failed;
            }
        };
        for member in &members {
            let argv: Vec<&str> = ALONE_LINT_HEAD
                .iter()
                .copied()
                .chain([member.as_str()])
                .chain(ALONE_LINT_TAIL.iter().copied())
                .collect();
            if let Some(exit) = failed(host.run(&argv, &env, false), &argv, err) {
                return exit;
            }
        }
    }
    Exit::Done
}

/// How a command that did not exit 0 ends the gate, `None` when it did.
fn failed(ran: std::io::Result<Status>, argv: &[&str], err: &mut impl Write) -> Option<Exit> {
    match ran {
        Ok(Some(0)) => None,
        Ok(_) => Some(Exit::Failed),
        Err(error) => {
            let _ = writeln!(
                err,
                "{}: {error}",
                argv.first().copied().unwrap_or_default()
            );
            Some(Exit::Failed)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> Env {
        pairs
            .iter()
            .map(|(k, v)| ((*k).into(), (*v).into()))
            .collect()
    }

    #[test]
    fn drops_every_variable_that_changes_the_builds_flags_tools_or_test_runner() {
        let got = gate_env(env(&[
            ("PATH", "/usr/bin"),
            ("HOME", "/home/u"),
            ("CARGO_TARGET_DIR", "/tmp/target"),
            ("CARGO_BUILD_TARGET_DIR", "/tmp/build-target"),
            ("CARGO_HOME", "/home/u/.cargo"),
            ("RUSTFLAGS", "--cap-lints allow"),
            ("CARGO_ENCODED_RUSTFLAGS", "--cap-lints=allow"),
            ("CARGO_ENCODED_RUSTDOCFLAGS", "--cap-lints=allow"),
            ("RUSTDOCFLAGS", "-A x"),
            ("CARGO_BUILD_RUSTFLAGS", "--cap-lints=allow"),
            (
                "CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUSTFLAGS",
                "--cap-lints=allow",
            ),
            ("CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUNNER", "true"),
            ("CARGO_ALIAS_CLIPPY", "check"),
            ("CARGO_PROFILE_DEV_OPT_LEVEL", "3"),
            ("RUSTC", "/fake/rustc"),
            ("RUSTC_WRAPPER", "/bin/true"),
            ("RUSTC_WORKSPACE_WRAPPER", "/bin/true"),
            ("RUSTDOC", "/fake/rustdoc"),
            ("RUSTFMT", "/bin/true"),
            ("RUSTUP_TOOLCHAIN", "nightly"),
            ("CARGO", "/fake/cargo"),
            ("CLIPPY_CONF_DIR", "/tmp"),
            ("CLIPPY_ARGS", "--cap-lints=allow"),
            ("NEXTEST_PROFILE", "lax"),
            ("PROPTEST_CASES", "1"),
            ("BAZHEN_XTASK_ROOT", "/w/repo"),
        ]));
        assert_eq!(
            got,
            env(&[
                ("PATH", "/usr/bin"),
                ("HOME", "/home/u"),
                ("CARGO_TARGET_DIR", "/tmp/target"),
                ("CARGO_BUILD_TARGET_DIR", "/tmp/build-target"),
                ("CARGO_HOME", "/home/u/.cargo"),
                ("CARGO_ENCODED_RUSTFLAGS", ""),
                ("CARGO_ENCODED_RUSTDOCFLAGS", ""),
                ("PROPTEST_RNG_SEED", "1"),
            ])
        );
    }

    #[test]
    fn keeps_the_build_jobs_and_test_threads_a_shared_host_caps() {
        let got = gate_env(env(&[
            ("CARGO_BUILD_JOBS", "4"),
            ("NEXTEST_TEST_THREADS", "4"),
            ("CARGO_BUILD_JOBSX", "4"),
            ("NEXTEST_TEST_THREADS_X", "4"),
            ("NEXTEST_RETRIES", "3"),
        ]));
        assert_eq!(
            got,
            env(&[
                ("CARGO_BUILD_JOBS", "4"),
                ("NEXTEST_TEST_THREADS", "4"),
                ("CARGO_ENCODED_RUSTFLAGS", ""),
                ("CARGO_ENCODED_RUSTDOCFLAGS", ""),
                ("PROPTEST_RNG_SEED", "1"),
            ])
        );
    }

    fn seed(given: Option<&str>) -> OsString {
        let given = given.map_or_else(Env::new, |g| env(&[("PROPTEST_RNG_SEED", g)]));
        gate_env(given)
            .remove(OsStr::new("PROPTEST_RNG_SEED"))
            .unwrap()
    }

    #[test]
    fn fixes_proptests_seed_unless_the_caller_gave_one_it_reads_as_a_seed() {
        for given in [
            None,
            Some(""),
            Some("random"),
            Some("-1"),
            Some("1e3"),
            Some("+1"),
            Some("18446744073709551616"),
        ] {
            assert_eq!(seed(given), PROPTEST_SEED, "{given:?}");
        }
        for given in ["42", "18446744073709551615", "007"] {
            assert_eq!(seed(Some(given)), given);
        }
    }

    #[test]
    fn names_each_gate_and_for_test_the_tests_to_run() {
        let parsed = |name: &str, tests: &[&str]| {
            parse(name, &tests.iter().map(OsString::from).collect::<Vec<_>>()).unwrap()
        };
        let gates: Vec<Gate> = NAMES.iter().map(|n| parsed(n, &[]).0).collect();
        assert_eq!(
            gates,
            [Gate::Fmt, Gate::Lint, Gate::Deny, Gate::Test, Gate::TestAll]
        );
        assert_eq!(
            parsed("test", &["refuses_a_cut", "tests::properties::round_trips"]),
            (
                Gate::Test,
                vec![
                    "refuses_a_cut".to_owned(),
                    "tests::properties::round_trips".to_owned()
                ]
            )
        );
        assert_eq!(
            parsed("test-all", &["a_sweep"]),
            (Gate::TestAll, vec!["a_sweep".to_owned()])
        );
    }

    #[test]
    fn refuses_an_unknown_gate_an_option_or_a_test_name_for_any_gate_but_test() {
        let refused: &[(&str, &[&str])] = &[
            ("build", &[]),
            ("lint", &["--cap-lints", "allow"]),
            ("lint", &["some_test"]),
            ("test", &["-x"]),
            ("test", &["ok", "--no-tests=pass"]),
            ("test", &["-E", "none()"]),
            ("test", &["a::"]),
            ("test", &["a b"]),
        ];
        for (name, tests) in refused {
            let tests: Vec<OsString> = tests.iter().map(OsString::from).collect();
            let why = parse(name, &tests).unwrap_err();
            assert!(
                why.contains("takes no other arguments"),
                "{name} {tests:?}: {why}"
            );
        }
    }

    #[test]
    fn calls_each_subcommands_own_binary_so_no_cargo_alias_can_stand_in_for_it() {
        let bins: Vec<&str> = NAMES
            .iter()
            .flat_map(|n| Gate::named(n).unwrap().commands())
            .map(|c| c[0])
            .collect();
        assert_eq!(
            bins,
            [
                "cargo-fmt",
                "cargo-clippy",
                "cargo-clippy",
                "cargo-deny",
                "cargo-nextest",
                "cargo-nextest"
            ]
        );
    }

    #[test]
    fn runs_the_ignored_tests_only_in_test_all_which_is_test_with_them_included() {
        assert!(!TEST.contains(&"--run-ignored"));
        let extra: Vec<&str> = TEST_ALL
            .iter()
            .copied()
            .filter(|a| !TEST.contains(a))
            .collect();
        assert_eq!(extra, ["--run-ignored", "all"]);
    }

    #[test]
    fn fails_clippy_on_any_warning_and_overrides_a_configured_wrapper_or_compiler() {
        assert_eq!(LINT[LINT.len() - 3..], ["--", "-D", "warnings"]);
        for gate in [LINT, SHIPPED_LINT, TEST, TEST_ALL] {
            assert!(
                gate.join(" ").contains(
                    "--config build.rustc-wrapper=\"\" --config build.rustc-workspace-wrapper=\"\" \
                     --config build.rustc=\"rustc\""
                ),
                "{gate:?}"
            );
        }
    }

    #[test]
    fn lints_the_holder_again_as_it_ships_its_lib_and_binary_with_no_feature() {
        assert_eq!(
            SHIPPED_LINT[..7],
            [
                "cargo-clippy",
                "clippy",
                "--quiet",
                "-p",
                "bazhen-holder",
                "--lib",
                "--bins"
            ]
        );
        assert!(SHIPPED_LINT.contains(&"--locked"));
        assert!(!SHIPPED_LINT.contains(&"--all-targets"));
        assert!(!SHIPPED_LINT.join(" ").contains("features"));
        assert_eq!(
            SHIPPED_LINT[SHIPPED_LINT.len() - 3..],
            ["--", "-D", "warnings"]
        );
    }

    #[test]
    fn lints_and_tests_every_feature_so_no_code_hides_behind_one() {
        assert!(
            [LINT, TEST, TEST_ALL]
                .iter()
                .all(|g| g.contains(&"--all-features"))
        );
    }

    /// A host that runs nothing: it records each command, and answers each with `status`.
    struct Fake {
        sandboxed: bool,
        config: Option<&'static str>,
        shadow: bool,
        probe: Status,
        status: Status,
        metadata: Option<&'static str>,
        runs: Vec<Vec<String>>,
    }

    impl Fake {
        fn new(sandboxed: bool) -> Self {
            Self {
                sandboxed,
                config: None,
                shadow: false,
                probe: Some(0),
                status: Some(0),
                metadata: Some(r#"{"packages":[{"name":"b"},{"name":"a"}]}"#),
                runs: Vec::new(),
            }
        }
    }

    impl Host for Fake {
        fn sandboxed(&self) -> bool {
            self.sandboxed
        }
        fn read(&self, path: &Path) -> Result<Option<String>, String> {
            if path == Path::new("/a/repo/.cargo/config") {
                return Ok(self.shadow.then(String::new));
            }
            let home = path.starts_with("/home/u/.cargo");
            Ok(self.config.filter(|_| home).map(str::to_owned))
        }
        fn run(&mut self, argv: &[&str], _: &Env, quiet: bool) -> std::io::Result<Status> {
            self.runs
                .push(argv.iter().map(|a| (*a).to_owned()).collect());
            Ok(if quiet { self.probe } else { self.status })
        }
        fn output(&mut self, argv: &[&str], _: &Env) -> std::io::Result<Option<String>> {
            self.runs
                .push(argv.iter().map(|a| (*a).to_owned()).collect());
            Ok(self.metadata.map(str::to_owned))
        }
    }

    fn ran(host: &mut Fake, name: &str, tests: &[&str]) -> (Exit, Vec<String>, String) {
        let places = Places {
            root: "/a/repo".into(),
            cargo_home: "/home/u/.cargo".into(),
        };
        let tests: Vec<String> = tests.iter().map(|t| (*t).to_owned()).collect();
        let mut err = Vec::new();
        let exit = run(
            Gate::named(name).unwrap(),
            &tests,
            Env::new(),
            &places,
            host,
            &mut err,
        );
        let bins = host.runs.iter().map(|r| r[0].clone()).collect();
        (exit, bins, String::from_utf8(err).unwrap())
    }

    #[test]
    fn starts_nothing_for_test_all_off_a_sandbox_and_exits_2() {
        let (exit, runs, err) = ran(&mut Fake::new(false), "test-all", &[]);
        assert_eq!((exit, runs), (Exit::Usage, vec![]));
        assert!(
            err.starts_with("Refusing to run: ")
                && err.contains(&format!("\"{SIGNALS_IGNORE}\""))
                && err.contains("moon run :test-real"),
            "{err}"
        );
    }

    #[test]
    fn runs_test_all_in_a_sandbox_and_every_other_gate_anywhere() {
        assert_eq!(ran(&mut Fake::new(true), "test-all", &[]).0, Exit::Done);
        for name in ["fmt", "lint", "deny", "test"] {
            assert_eq!(
                ran(&mut Fake::new(false), name, &[]).0,
                Exit::Done,
                "{name}"
            );
        }
    }

    #[test]
    fn lints_the_workspace_then_the_holder_as_it_ships_then_each_crate_alone() {
        let mut host = Fake::new(false);
        let (exit, runs, _) = ran(&mut host, "lint", &[]);
        assert_eq!(
            (exit, runs),
            (
                Exit::Done,
                ["cargo-clippy", "cargo-clippy", "cargo-clippy", "cargo"]
                    .into_iter()
                    .chain(["cargo-clippy"; 2])
                    .map(str::to_owned)
                    .collect::<Vec<_>>()
            )
        );
        assert_eq!(host.runs[1], LINT);
        assert_eq!(host.runs[2], SHIPPED_LINT);
        assert_eq!(host.runs[3], MEMBERS);
        for (run, name) in host.runs[4..].iter().zip(["a", "b"]) {
            let (head, rest) = run.split_at(ALONE_LINT_HEAD.len());
            assert_eq!(head, ALONE_LINT_HEAD);
            assert_eq!(rest[0], name);
            assert_eq!(&rest[1..], ALONE_LINT_TAIL);
        }
    }

    #[test]
    fn lints_each_crate_with_no_feature_but_its_own_so_one_it_takes_from_a_neighbour_fails() {
        for part in ["--workspace", "--all-features", "--exclude"] {
            assert!(
                !ALONE_LINT_HEAD
                    .iter()
                    .chain(ALONE_LINT_TAIL)
                    .any(|a| *a == part),
                "{part}"
            );
        }
        assert!(ALONE_LINT_TAIL.contains(&"--all-targets"));
        assert_eq!(
            ALONE_LINT_TAIL[ALONE_LINT_TAIL.len() - 3..],
            ["--", "-D", "warnings"]
        );
        assert!(ALONE_LINT_TAIL.join(" ").contains(
            "--config build.rustc-wrapper=\"\" --config build.rustc-workspace-wrapper=\"\" \
                 --config build.rustc=\"rustc\""
        ));
    }

    #[test]
    fn names_the_crates_cargo_metadata_lists_in_order() {
        assert_eq!(
            member_names(r#"{"packages":[{"name":"b"},{"name":"a","x":1}],"y":2}"#),
            Ok(vec!["a".to_owned(), "b".to_owned()])
        );
        for bad in ["", "{}", r#"{"packages":[]}"#, r#"{"packages":[{}]}"#] {
            assert!(member_names(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn fails_lint_without_linting_a_crate_when_cargo_metadata_gives_no_crates() {
        for metadata in [None, Some("{"), Some(r#"{"packages":[]}"#)] {
            let mut host = Fake::new(false);
            host.metadata = metadata;
            let (exit, runs, err) = ran(&mut host, "lint", &[]);
            assert_eq!(exit, Exit::Failed, "{metadata:?}");
            assert_eq!(runs.len(), 4, "{metadata:?}");
            assert!(err.starts_with("cargo metadata"), "{err}");
        }
    }

    #[test]
    fn hands_the_tool_its_fixed_command_and_the_tests_named_after_it() {
        let mut host = Fake::new(false);
        ran(&mut host, "test", &["tests::a", "b"]);
        let want: Vec<&str> = TEST.iter().copied().chain(["tests::a", "b"]).collect();
        assert_eq!(host.runs[1], want);
    }

    #[test]
    fn fails_as_the_tool_did_and_stops_there() {
        let mut host = Fake::new(false);
        host.status = Some(3);
        let (exit, runs, _) = ran(&mut host, "lint", &[]);
        assert_eq!((exit, runs.len()), (Exit::Failed, 2));
        host = Fake::new(false);
        host.status = None;
        assert_eq!(ran(&mut host, "fmt", &[]).0, Exit::Failed);
    }

    #[test]
    fn refuses_every_gate_under_a_config_it_cant_override_and_runs_nothing() {
        for name in ["fmt", "lint", "deny", "test"] {
            let mut host = Fake::new(false);
            host.config = Some("[env]\nPATH = { value = \"/fake:/usr/bin\", force = true }\n");
            let (exit, runs, err) = ran(&mut host, name, &[]);
            assert_eq!((exit, runs), (Exit::Failed, vec![]), "{name}");
            assert!(err.contains("sets a test runner"), "{err}");
        }
    }

    #[test]
    fn refuses_every_gate_under_a_config_in_the_repository_that_shadows_the_pinned_one() {
        for name in ["fmt", "lint", "deny", "test"] {
            let mut host = Fake::new(false);
            host.shadow = true;
            let (exit, runs, err) = ran(&mut host, name, &[]);
            assert_eq!((exit, runs), (Exit::Failed, vec![]), "{name}");
            assert!(err.contains("/a/repo/.cargo/config is there"), "{err}");
        }
    }

    #[test]
    fn names_the_install_command_when_a_tool_is_missing_or_the_toolchain_when_one_cant_run() {
        let mut host = Fake::new(false);
        host.probe = Some(1);
        let (exit, runs, err) = ran(&mut host, "deny", &[]);
        assert_eq!((exit, runs.len()), (Exit::Failed, 1));
        assert!(
            err.contains("cargo install --locked cargo-nextest@"),
            "{err}"
        );
        let mut host = Fake::new(false);
        host.probe = None;
        let (exit, _, err) = ran(&mut host, "lint", &[]);
        assert_eq!(exit, Exit::Failed);
        assert!(err.contains("install rustup"), "{err}");
    }
}
