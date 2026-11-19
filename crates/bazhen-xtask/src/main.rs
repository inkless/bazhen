//! The repository's own commands, run as `cargo xtask <command>`.

mod cargo_config;
mod cli;
mod gate;
mod sandbox;
mod tools;

use std::ffi::{OsStr, OsString};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode, Stdio};

use crate::gate::{Env, Host, Places, Status};

/// This machine: its sandbox marker, its files, and the tools it runs.
struct Real {
    root: PathBuf,
}

impl Host for Real {
    fn sandboxed(&self) -> bool {
        sandbox::sandboxed()
    }

    fn read(&self, path: &Path) -> Result<Option<String>, String> {
        match std::fs::read_to_string(path) {
            Ok(text) => Ok(Some(text)),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.to_string()),
        }
    }

    fn run(&mut self, argv: &[&str], env: &Env, quiet: bool) -> io::Result<Status> {
        let (program, rest) = argv.split_first().ok_or(io::ErrorKind::InvalidInput)?;
        let mut command = Command::new(program);
        command
            .args(rest)
            .current_dir(&self.root)
            .env_clear()
            .envs(env);
        if quiet {
            command
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
        }
        Ok(command.status()?.code())
    }
}

/// The repository root: two levels above the crate's directory, which `cargo run` names in
/// `CARGO_MANIFEST_DIR` when xtask runs as `cargo xtask`, so a `BAZHEN_XTASK_ROOT` the caller left
/// set can't move it; or else the full path `scripts/xtask.sh` names in `BAZHEN_XTASK_ROOT`, which
/// it takes from where it is, having removed `CARGO_MANIFEST_DIR`. Read when xtask runs, not when
/// it was built: cargo reuses a binary that another checkout built in a shared target directory,
/// and a copy cargo-mutants made builds its own.
fn root_of(env: &Env) -> Option<PathBuf> {
    if let Some(manifest) = env.get(OsStr::new("CARGO_MANIFEST_DIR")) {
        return Path::new(manifest)
            .ancestors()
            .nth(2)
            .map(Path::to_path_buf);
    }
    Some(PathBuf::from(env.get(OsStr::new("BAZHEN_XTASK_ROOT"))?)).filter(|root| root.is_absolute())
}

/// Where the cargo configs cargo would read from its home are: `CARGO_HOME`, or `.cargo` in the
/// home directory. `None` when neither gives a full path, which would name a folder relative to
/// wherever the gate runs.
fn cargo_home(env: &Env, home: Option<PathBuf>) -> Option<PathBuf> {
    let named = env
        .get(OsStr::new("CARGO_HOME"))
        .filter(|h| !h.is_empty())
        .map(PathBuf::from);
    named
        .or_else(|| home.map(|h| h.join(".cargo")))
        .filter(|h| h.is_absolute())
}

/// Runs the command `args` name, from the repository `env` places it in.
fn start(env: Env, args: &[OsString], stderr: &mut impl Write) -> cli::Exit {
    // Nowhere left to report a write to stderr that failed.
    let Some(root) = root_of(&env) else {
        let why = "xtask: run it as `cargo xtask`, which names its crate in CARGO_MANIFEST_DIR, \
                   or as scripts/xtask.sh, which names the repository in BAZHEN_XTASK_ROOT.";
        writeln!(stderr, "{why}").ok();
        return cli::Exit::Usage;
    };
    let Some(cargo_home) = cargo_home(&env, std::env::home_dir()) else {
        let why = "xtask: CARGO_HOME names no full path and there is no home directory, so the Rust \
                   gates can't find the cargo configs cargo reads from its home.";
        writeln!(stderr, "{why}").ok();
        return cli::Exit::Failed;
    };
    let mut host = Real { root: root.clone() };
    let world = cli::World {
        env,
        places: Places { root, cargo_home },
        host: &mut host,
    };
    cli::run(
        args.iter().cloned(),
        world,
        &mut io::stdout().lock(),
        stderr,
    )
}

fn main() -> ExitCode {
    let env: Env = std::env::vars_os().collect();
    let args: Vec<OsString> = std::env::args_os().skip(1).collect();
    ExitCode::from(start(env, &args, &mut io::stderr().lock()).code())
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
    fn takes_the_root_above_the_crate_cargo_names_or_else_the_one_the_wrapper_names() {
        let at = |vars: &[(&str, &str)]| root_of(&env(vars));
        let manifest = ("CARGO_MANIFEST_DIR", "/w/repo/crates/bazhen-xtask");
        let named = ("BAZHEN_XTASK_ROOT", "/x/repo");
        assert_eq!(at(&[manifest]), Some(PathBuf::from("/w/repo")));
        assert_eq!(at(&[named, manifest]), Some(PathBuf::from("/w/repo")));
        assert_eq!(at(&[named]), Some(PathBuf::from("/x/repo")));
        assert_eq!(at(&[("BAZHEN_XTASK_ROOT", "repo")]), None);
        assert_eq!(at(&[("CARGO_MANIFEST_DIR", "")]), None);
        assert_eq!(at(&[]), None);
    }

    #[test]
    fn finds_cargo_home_only_at_a_full_path() {
        let home = || Some(PathBuf::from("/home/u"));
        let at = |vars: &[(&str, &str)], home: Option<PathBuf>| cargo_home(&env(vars), home);
        assert_eq!(
            at(&[("CARGO_HOME", "/c")], home()),
            Some(PathBuf::from("/c"))
        );
        assert_eq!(at(&[], home()), Some(PathBuf::from("/home/u/.cargo")));
        assert_eq!(
            at(&[("CARGO_HOME", "")], home()),
            Some(PathBuf::from("/home/u/.cargo"))
        );
        assert_eq!(at(&[], None), None);
        assert_eq!(at(&[("CARGO_HOME", "rel")], home()), None);
        assert_eq!(at(&[], Some(PathBuf::from("rel"))), None);
    }
}
