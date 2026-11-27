//! One of the Rust gates `make check` relies on (docs/standards/rust.md). Each gate's command
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
// What every clippy pass ends with, so none runs without the lockfile, the compiler overrides or
// `-D warnings`.
const CLIPPY_TAIL: &[&str] = &[
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
// The workspace with every feature, which `lint` runs first.
const WORKSPACE_SCOPE: &[&str] = &["--workspace", "--all-targets", "--all-features"];

/// A clippy pass over what `scope` selects.
fn clippy<'a>(scope: &[&'a str]) -> Vec<&'a str> {
    ["cargo-clippy", "clippy", "--quiet"]
        .into_iter()
        .chain(scope.iter().copied())
        .chain(CLIPPY_TAIL.iter().copied())
        .collect()
}

// Each crate of the workspace on its own, which `lint` checks after the workspace pass. With `-p`,
// cargo resolves features over that crate alone, so one it takes from a neighbour in the workspace
// pass is missing and its build fails. Two passes, because `--all-targets` also unifies the
// crate's dev-dependencies' features into its library and binaries: the first lints every target,
// the second only the lib and bins (cargo's default targets, so a crate with no library is no
// error), as they ship.
fn alone_with_tests(member: &str) -> Vec<&str> {
    clippy(&["-p", member, "--all-targets"])
}

fn alone_as_shipped(member: &str) -> Vec<&str> {
    clippy(&["-p", member])
}

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
    pub(crate) fn commands(self) -> Vec<Vec<&'static str>> {
        match self {
            Self::Fmt => vec![FMT.to_vec()],
            Self::Lint => vec![clippy(WORKSPACE_SCOPE)],
            Self::Deny => vec![DENY.to_vec()],
            Self::Test => vec![TEST.to_vec()],
            Self::TestAll => vec![TEST_ALL.to_vec()],
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

    pub(crate) fn takes_tests(self) -> bool {
        matches!(self, Self::Test | Self::TestAll)
    }
}

fn usage() -> String {
    format!(
        "usage: cargo xtask gate <{}>, or test [--partition <k>/<n>] <name>... test-all takes \
         them too. A gate takes no other arguments: its command is fixed in \
         crates/bazhen-xtask/src/gate.rs.",
        NAMES.join("|")
    )
}

/// The gate `args` name, and for `test` and `test-all` the names of the tests to run. Anything else
/// is refused, so no flag reaches the tool: a test name is a plain path, never an option.
pub(crate) fn parse(name: &str, tests: &[OsString]) -> Result<(Gate, Vec<String>), String> {
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

/// The `index`th of `count` slices of a test gate's run: nextest runs every `count`th test of each
/// test binary, from its `index`th. CI spreads one run over runners side by side with it, a slice
/// each, which between them run every test once.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Partition {
    index: u32,
    count: u32,
}

impl Partition {
    /// What nextest's `--partition` takes for this slice.
    fn arg(self) -> String {
        format!("count:{}/{}", self.index, self.count)
    }
}

/// The partition `given` names for `gate`, as `<k>/<n>` in decimal digits with 1 <= k <= n, `None`
/// when none is given. Refused for a gate that runs no tests, and in any other form, so what
/// reaches nextest is only ever the argument `Partition::arg` writes.
pub(crate) fn partition(gate: Gate, given: Option<&OsStr>) -> Result<Option<Partition>, String> {
    let Some(given) = given else {
        return Ok(None);
    };
    let number = |text: &str| {
        (!text.is_empty() && text.bytes().all(|b| b.is_ascii_digit()))
            .then(|| text.parse::<u32>().ok())
            .flatten()
    };
    if !gate.takes_tests() {
        return Err(format!(
            "Only test and test-all take --partition: no other gate runs tests. {}",
            usage()
        ));
    }
    let malformed = || {
        format!(
            "--partition takes <k>/<n>, two numbers with 1 <= k <= n, not \"{}\". {}",
            given.display(),
            usage()
        )
    };
    let (index, count) = given
        .to_str()
        .and_then(|text| text.split_once('/'))
        .and_then(|(k, n)| number(k).zip(number(n)))
        .ok_or_else(malformed)?;
    if index == 0 || index > count {
        return Err(malformed());
    }
    Ok(Some(Partition { index, count }))
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

/// What a CI run passes nextest, so that one failing test doesn't hide those after it. A local run
/// stops at the first failure, which is what someone watching it wants.
const NO_FAIL_FAST: &str = "--no-fail-fast";

/// Whether the caller is a CI run, that is, `CI` is set and non-empty: GitHub Actions, as most CI
/// services, sets it on every runner. `CI=false` counts, which is harmless.
fn ci(env: &Env) -> bool {
    env.get(OsStr::new("CI")).is_some_and(|v| !v.is_empty())
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
const SIGNALS_IGNORE: &str = "signals processes; runs in make test-real ARGS=rust";

/// Why a gate won't run on this host: test-all runs tests only a sandbox may.
fn sandbox_refusal(gate: Gate, sandboxed: bool) -> Option<String> {
    (gate == Gate::TestAll && !sandboxed).then(|| {
        format!(
            "Refusing to run: cargo xtask gate test-all includes each test ignored as \
             \"{SIGNALS_IGNORE}\": such a test signals processes it didn't start, so it runs only \
             on a host that exists to be thrown away: the test container (make test-real) or a CI \
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
    /// Writes `text` to `path`, making the folders it is in.
    fn write(&mut self, path: &Path, text: &str) -> std::io::Result<()>;
    /// Removes the file at `path`; one already gone is no error.
    fn remove(&mut self, path: &Path) -> std::io::Result<()>;
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

/// Runs `gate` with `tests`, in `partition` if one is given, in `env` cleaned of every flag a caller
/// could pass.
pub(crate) fn run(
    gate: Gate,
    tests: &[String],
    partition: Option<Partition>,
    env: Env,
    places: &Places,
    host: &mut impl Host,
    err: &mut impl Write,
) -> Exit {
    if let Some(refused) = sandbox_refusal(gate, host.sandboxed()) {
        let _ = writeln!(err, "{refused}");
        return Exit::Usage;
    }
    let report_every_failure = gate.takes_tests() && ci(&env);
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
    let slice: Vec<String> = partition
        .into_iter()
        .flat_map(|p| ["--partition".to_owned(), p.arg()])
        .collect();
    for command in gate.commands() {
        let argv: Vec<&str> = command
            .into_iter()
            .chain(slice.iter().map(String::as_str))
            .chain(report_every_failure.then_some(NO_FAIL_FAST))
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
            for argv in [alone_with_tests(member), alone_as_shipped(member)] {
                if let Some(exit) = failed(host.run(&argv, &env, false), &argv, err) {
                    return exit;
                }
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
        let clippy_passes = [
            clippy(WORKSPACE_SCOPE),
            alone_with_tests("x"),
            alone_as_shipped("x"),
        ];
        for pass in &clippy_passes {
            assert_eq!(pass[pass.len() - 3..], ["--", "-D", "warnings"]);
        }
        let others = [TEST.to_vec(), TEST_ALL.to_vec()];
        for gate in clippy_passes.iter().chain(&others) {
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
    fn lints_and_tests_every_feature_so_no_code_hides_behind_one() {
        assert!(
            [clippy(WORKSPACE_SCOPE), TEST.to_vec(), TEST_ALL.to_vec()]
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
        fn write(&mut self, _: &Path, _: &str) -> std::io::Result<()> {
            Err(std::io::ErrorKind::Unsupported.into())
        }
        fn remove(&mut self, _: &Path) -> std::io::Result<()> {
            Err(std::io::ErrorKind::Unsupported.into())
        }
    }

    fn ran(host: &mut Fake, name: &str, tests: &[&str]) -> (Exit, Vec<String>, String) {
        ran_in(host, name, tests, Env::new())
    }

    fn ran_in(
        host: &mut Fake,
        name: &str,
        tests: &[&str],
        env: Env,
    ) -> (Exit, Vec<String>, String) {
        let places = Places {
            root: "/a/repo".into(),
            cargo_home: "/home/u/.cargo".into(),
        };
        let tests: Vec<String> = tests.iter().map(|t| (*t).to_owned()).collect();
        let mut err = Vec::new();
        let exit = run(
            Gate::named(name).unwrap(),
            &tests,
            None,
            env,
            &places,
            host,
            &mut err,
        );
        let bins = host.runs.iter().map(|r| r[0].clone()).collect();
        (exit, bins, String::from_utf8(err).unwrap())
    }

    #[test]
    fn tells_nextest_to_run_every_test_only_in_ci_and_before_any_test_name() {
        let runs = |ci: Option<&str>, name: &str, tests: &[&str]| {
            let env: Env = ci
                .map(|v| (OsString::from("CI"), OsString::from(v)))
                .into_iter()
                .collect();
            let mut host = Fake::new(true);
            ran_in(&mut host, name, tests, env);
            host.runs
        };
        let has_flag = |runs: &[Vec<String>]| runs.iter().flatten().any(|a| a == NO_FAIL_FAST);
        for name in ["test", "test-all"] {
            let ci = runs(Some("true"), name, &["a_test"]);
            let nextest = ci.last().unwrap();
            let flag = nextest.iter().position(|a| a == NO_FAIL_FAST).unwrap();
            assert_eq!(nextest.last().unwrap(), "a_test", "{name}");
            assert_eq!(flag, nextest.len() - 2, "{name}");
            for local in [None, Some("")] {
                assert!(
                    !has_flag(&runs(local, name, &["a_test"])),
                    "{name} {local:?}"
                );
            }
        }
        for name in ["fmt", "lint", "deny"] {
            let ci = runs(Some("true"), name, &[]);
            assert!(ci.len() > 1 || name != "lint", "{name} ran nothing");
            assert!(!has_flag(&ci), "{name}");
        }
    }

    #[test]
    fn starts_nothing_for_test_all_off_a_sandbox_and_exits_2() {
        let (exit, runs, err) = ran(&mut Fake::new(false), "test-all", &[]);
        assert_eq!((exit, runs), (Exit::Usage, vec![]));
        assert!(
            err.starts_with("Refusing to run: ")
                && err.contains(&format!("\"{SIGNALS_IGNORE}\""))
                && err.contains("make test-real"),
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
    fn lints_the_workspace_then_each_crate_alone_with_its_tests_and_as_it_ships() {
        let mut host = Fake::new(false);
        let (exit, runs, _) = ran(&mut host, "lint", &[]);
        let bins: Vec<&str> = runs.iter().map(String::as_str).collect();
        assert_eq!(
            (exit, bins),
            (
                Exit::Done,
                vec![
                    "cargo-clippy",
                    "cargo-clippy",
                    "cargo",
                    "cargo-clippy",
                    "cargo-clippy",
                    "cargo-clippy",
                    "cargo-clippy"
                ]
            )
        );
        assert_eq!(host.runs[1], clippy(WORKSPACE_SCOPE));
        assert_eq!(host.runs[2], MEMBERS);
        assert_eq!(host.runs[3], alone_with_tests("a"));
        assert_eq!(host.runs[4], alone_as_shipped("a"));
        assert_eq!(host.runs[5], alone_with_tests("b"));
        assert_eq!(host.runs[6], alone_as_shipped("b"));
    }

    #[test]
    fn selects_the_workspace_features_in_no_per_crate_pass_and_the_tests_in_the_shipped_one() {
        for pass in [alone_with_tests("x"), alone_as_shipped("x")] {
            for widening in ["--workspace", "--all-features", "--features", "--exclude"] {
                assert!(!pass.contains(&widening), "{pass:?}: {widening}");
            }
        }
        assert!(alone_with_tests("x").contains(&"--all-targets"));
        for tests in [
            "--all-targets",
            "--tests",
            "--benches",
            "--examples",
            "--all",
        ] {
            assert!(!alone_as_shipped("x").contains(&tests), "{tests}");
        }
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
            assert_eq!(runs.len(), 3, "{metadata:?}");
            assert!(err.starts_with("cargo metadata"), "{err}");
        }
    }

    #[test]
    fn takes_a_partition_only_as_k_of_n_and_only_for_a_gate_that_runs_tests() {
        let given =
            |gate: &str, text: &str| partition(Gate::named(gate).unwrap(), Some(text.as_ref()));
        for gate in ["test", "test-all"] {
            assert_eq!(
                given(gate, "2/3").unwrap().map(Partition::arg).as_deref(),
                Some("count:2/3")
            );
            assert_eq!(
                given(gate, "1/1").unwrap().map(Partition::arg).as_deref(),
                Some("count:1/1")
            );
            assert_eq!(partition(Gate::named(gate).unwrap(), None), Ok(None));
            for bad in [
                "0/2",
                "3/2",
                "1/0",
                "",
                "/",
                "1",
                "1/",
                "/2",
                "a/2",
                "+1/2",
                "1/2/3",
                " 1/2",
                "1/2 ",
                "hash:1/2",
                "1/4294967296",
            ] {
                let why = given(gate, bad).unwrap_err();
                assert!(
                    why.contains("takes no other arguments"),
                    "{gate} {bad:?}: {why}"
                );
            }
        }
        for gate in ["fmt", "lint", "deny"] {
            assert!(given(gate, "1/2").is_err(), "{gate}");
        }
    }

    #[test]
    fn hands_nextest_the_partition_before_the_ci_flag_and_the_tests_and_no_partition_unasked() {
        let places = Places {
            root: "/a/repo".into(),
            cargo_home: "/home/u/.cargo".into(),
        };
        let ci = env(&[("CI", "true")]);
        for (name, command) in [("test", TEST), ("test-all", TEST_ALL)] {
            let gate = Gate::named(name).unwrap();
            let sliced = partition(gate, Some("2/3".as_ref())).unwrap();
            for (slice, want) in [(sliced, &["--partition", "count:2/3"][..]), (None, &[])] {
                let mut host = Fake::new(true);
                let tests = ["a".to_owned()];
                let exit = run(
                    gate,
                    &tests,
                    slice,
                    ci.clone(),
                    &places,
                    &mut host,
                    &mut Vec::new(),
                );
                let argv: Vec<&str> = command
                    .iter()
                    .copied()
                    .chain(want.iter().copied())
                    .chain([NO_FAIL_FAST, "a"])
                    .collect();
                assert_eq!(
                    (exit, host.runs.last().unwrap()),
                    (Exit::Done, &argv.iter().map(|a| (*a).to_owned()).collect()),
                    "{name} {slice:?}"
                );
            }
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
