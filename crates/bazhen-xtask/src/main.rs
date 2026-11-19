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

/// What `scripts/xtask.sh` hands xtask to prove it ran: the file to write the receipt to, and the
/// nonce to write.
#[derive(Debug, PartialEq, Eq)]
struct Proof {
    at: PathBuf,
    nonce: OsString,
}

/// Takes the receipt's variables out of `env`, so no tool a gate starts sees them, and the proof
/// they ask for when both are there.
fn take_proof(env: &mut Env) -> Option<Proof> {
    let at = env.remove(OsStr::new("BAZHEN_XTASK_RECEIPT"));
    let nonce = env.remove(OsStr::new("BAZHEN_XTASK_NONCE"));
    Some(Proof {
        at: PathBuf::from(at?),
        nonce: nonce?,
    })
}

/// The receipt: the nonce, xtask's exit code, and each argument it was given, hex-encoded, a line
/// each. So the script checks that xtask itself ran the command it asked for, and exits as xtask
/// did: a runner that stood in for xtask could start it with other arguments, or hide its exit.
fn receipt(nonce: &OsStr, exit: u8, args: &[OsString]) -> Vec<u8> {
    let mut out = nonce.as_encoded_bytes().to_vec();
    out.extend(format!("\n{exit}\n").bytes());
    for arg in args {
        for byte in arg.as_encoded_bytes() {
            out.extend(format!("{byte:02x}").bytes());
        }
        out.push(b'\n');
    }
    out
}

/// Runs the command `args` name, from the repository `env` places it in.
fn start(env: Env, args: &[OsString], stderr: &mut impl Write) -> cli::Exit {
    // Nowhere left to report a write to stderr that failed.
    let Some(root) = root_of(env.get(OsStr::new("CARGO_MANIFEST_DIR"))) else {
        let why = "xtask: run it as `cargo xtask`, which names its crate in CARGO_MANIFEST_DIR.";
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
    let mut env: Env = std::env::vars_os().collect();
    let proof = take_proof(&mut env);
    let args: Vec<OsString> = std::env::args_os().skip(1).collect();
    let mut stderr = io::stderr().lock();
    let exit = start(env, &args, &mut stderr).code();
    if let Some(Proof { at, nonce }) = proof
        && let Err(error) = std::fs::write(&at, receipt(&nonce, exit, &args))
    {
        // scripts/xtask.sh finds no receipt and fails the run.
        writeln!(stderr, "xtask: can't write {}: {error}", at.display()).ok();
    }
    ExitCode::from(exit)
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
    fn takes_the_root_from_the_manifest_directory_cargo_names_when_it_runs() {
        let manifest = OsString::from("/w/repo/crates/bazhen-xtask");
        assert_eq!(root_of(Some(&manifest)), Some(PathBuf::from("/w/repo")));
        assert_eq!(root_of(Some(&OsString::new())), None);
        assert_eq!(root_of(None), None);
    }

    #[test]
    fn takes_the_receipts_variables_out_and_asks_for_one_only_when_both_are_there() {
        let mut both = env(&[
            ("PATH", "/usr/bin"),
            ("BAZHEN_XTASK_RECEIPT", "/r"),
            ("BAZHEN_XTASK_NONCE", "n"),
        ]);
        let proof = Proof {
            at: PathBuf::from("/r"),
            nonce: OsString::from("n"),
        };
        assert_eq!(take_proof(&mut both), Some(proof));
        assert_eq!(both, env(&[("PATH", "/usr/bin")]));
        for one in ["BAZHEN_XTASK_RECEIPT", "BAZHEN_XTASK_NONCE"] {
            let mut alone = env(&[(one, "x")]);
            assert_eq!(take_proof(&mut alone), None, "{one}");
            assert_eq!(alone, Env::new(), "{one}");
        }
    }

    #[test]
    fn writes_the_nonce_the_exit_and_each_argument_hex_encoded_on_a_line_of_its_own() {
        let args = ["gate", "", "a b\n"].map(OsString::from);
        assert_eq!(
            receipt(OsStr::new("n0"), 2, &args),
            b"n0\n2\n67617465\n\n6120620a\n"
        );
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
