//! The repository's own commands, run as `cargo xtask <command>`.

mod cli;

use std::io;
use std::process::ExitCode;

fn main() -> ExitCode {
    let exit = cli::run(
        std::env::args_os().skip(1),
        &mut io::stdout().lock(),
        &mut io::stderr().lock(),
    );
    ExitCode::from(exit.code())
}
