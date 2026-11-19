//! The repository's own commands, run as `cargo xtask <command>`.

mod cargo_config;
mod cli;
mod gate;
mod sandbox;
mod tools;

use std::io;
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

fn main() -> ExitCode {
    // Two levels above this crate's manifest, wherever the tree was built: a copy cargo-mutants
    // made builds its own.
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .unwrap_or(Path::new("."))
        .to_path_buf();
    let env: Env = std::env::vars_os().collect();
    let cargo_home = env.get(std::ffi::OsStr::new("CARGO_HOME")).map_or_else(
        || std::env::home_dir().unwrap_or_default().join(".cargo"),
        PathBuf::from,
    );
    let mut host = Real { root: root.clone() };
    let world = cli::World {
        env,
        places: Places { root, cargo_home },
        host: &mut host,
    };
    let exit = cli::run(
        std::env::args_os().skip(1),
        world,
        &mut io::stdout().lock(),
        &mut io::stderr().lock(),
    );
    ExitCode::from(exit.code())
}
