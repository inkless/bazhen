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
/// `CARGO_MANIFEST_DIR`. Read when xtask runs, not when it was built: cargo reuses a binary that
/// another checkout built in a shared target directory, and a copy cargo-mutants made builds its
/// own.
fn root_of(manifest: Option<&OsString>) -> Option<PathBuf> {
    Path::new(manifest?)
        .ancestors()
        .nth(2)
        .map(Path::to_path_buf)
}

/// The proof that xtask itself ran, which `scripts/xtask.sh` asks for: the nonce it gave, written
/// to the file it named. A runner or alias that stood in for xtask writes none.
fn receipt(env: &Env) -> Option<(&OsString, &OsString)> {
    let at = env.get(OsStr::new("BAZHEN_XTASK_RECEIPT"))?;
    let nonce = env.get(OsStr::new("BAZHEN_XTASK_NONCE"))?;
    Some((at, nonce))
}

fn main() -> ExitCode {
    let env: Env = std::env::vars_os().collect();
    let mut stderr = io::stderr().lock();
    let proof = receipt(&env).map(|(at, nonce)| (PathBuf::from(at), nonce.clone()));
    let exit = match root_of(env.get(OsStr::new("CARGO_MANIFEST_DIR"))) {
        None => {
            let why =
                "xtask: run it as `cargo xtask`, which names its crate in CARGO_MANIFEST_DIR.";
            // Nowhere left to report a write that failed.
            writeln!(stderr, "{why}").ok();
            cli::Exit::Usage
        }
        Some(root) => {
            let cargo_home = env.get(OsStr::new("CARGO_HOME")).map_or_else(
                || std::env::home_dir().unwrap_or_default().join(".cargo"),
                PathBuf::from,
            );
            let mut host = Real { root: root.clone() };
            let world = cli::World {
                env,
                places: Places { root, cargo_home },
                host: &mut host,
            };
            cli::run(
                std::env::args_os().skip(1),
                world,
                &mut io::stdout().lock(),
                &mut stderr,
            )
        }
    };
    if let Some((at, nonce)) = proof
        && let Err(error) = std::fs::write(&at, nonce.as_encoded_bytes())
    {
        // scripts/xtask.sh finds no receipt and fails the run.
        writeln!(stderr, "xtask: can't write {}: {error}", at.display()).ok();
    }
    ExitCode::from(exit.code())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn takes_the_root_from_the_manifest_directory_cargo_names_when_it_runs() {
        let manifest = OsString::from("/w/repo/crates/bazhen-xtask");
        assert_eq!(root_of(Some(&manifest)), Some(PathBuf::from("/w/repo")));
        assert_eq!(root_of(Some(&OsString::new())), None);
        assert_eq!(root_of(None), None);
    }

    #[test]
    fn asks_for_a_receipt_only_when_both_the_file_and_the_nonce_are_named() {
        let env = |pairs: &[(&str, &str)]| -> Env {
            pairs
                .iter()
                .map(|(k, v)| ((*k).into(), (*v).into()))
                .collect()
        };
        let both = env(&[("BAZHEN_XTASK_RECEIPT", "/r"), ("BAZHEN_XTASK_NONCE", "n")]);
        let r = OsString::from("/r");
        let n = OsString::from("n");
        assert_eq!(receipt(&both), Some((&r, &n)));
        assert_eq!(receipt(&env(&[("BAZHEN_XTASK_RECEIPT", "/r")])), None);
        assert_eq!(receipt(&env(&[("BAZHEN_XTASK_NONCE", "n")])), None);
    }
}
