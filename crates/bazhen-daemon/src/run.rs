//! What the binary does with its arguments: serve in the foreground with none, as `main.ts`;
//! `start`, as `start.ts`, to detach a daemon that serves in a session of its own.

use std::ffi::OsString;
use std::io::Write;
use std::path::Path;
use std::process::ExitCode;

use bazhen_client::paths::Inputs;

use crate::config::{InvalidConfig, OriginsFrom, Settings, load_settings};
use crate::detach::{Detach, SESSION_ARG, detach};
use crate::env::Env;
use crate::private_dir::ensure_private_dir;
use crate::serve::{Startup, serve};
use crate::session::leads_own_session;

const USAGE: &str = "usage: bazhen-daemon [start]";
const NOT_DETACHED: &str = "bazhen-daemon --session serves only as the daemon `bazhen-daemon start` starts, which leads a \
     session of its own";

/// What the arguments ask for.
#[derive(Debug, PartialEq, Eq)]
enum Verb {
    Serve,
    /// Serve as the daemon `start` detached, which leads a session of its own from the fork.
    Detached,
    Start,
}

fn verb(args: &[OsString]) -> Option<Verb> {
    match args {
        [] => Some(Verb::Serve),
        [one] if one == SESSION_ARG => Some(Verb::Detached),
        [one] if one == "start" => Some(Verb::Start),
        _ => None,
    }
}

/// Runs the daemon with `args`, this program's arguments after its name. Output that can't be
/// written has no one to tell.
pub fn run(args: &[OsString]) -> ExitCode {
    crate::log::init();
    let mut err = std::io::stderr();
    let Some(verb) = verb(args) else {
        let _ = writeln!(err, "{USAGE}");
        return ExitCode::from(2);
    };
    let uid = rustix::process::getuid().as_raw();
    let lookup = |name: &str| std::env::var(name).ok();
    let settings = match load_settings(&Inputs::current(None, uid), &lookup) {
        Ok(settings) => settings,
        Err(InvalidConfig(message)) => {
            let _ = writeln!(err, "{message}");
            return ExitCode::FAILURE;
        }
    };
    match verb {
        Verb::Start => start(&settings, uid, &mut err),
        Verb::Detached if !leads_own_session() => {
            let _ = writeln!(err, "{NOT_DETACHED}");
            ExitCode::FAILURE
        }
        Verb::Detached | Verb::Serve => serve(&startup(settings, uid)),
    }
}

/// What serving needs, from the settings and `BAZHEN_WEB_PORT`, an empty one unset.
fn startup(settings: Settings, uid: u32) -> Startup {
    let config = settings.config;
    Startup {
        paths: settings.paths,
        uid,
        port: config.port,
        web_port: std::env::var("BAZHEN_WEB_PORT")
            .ok()
            .filter(|p| !p.is_empty()),
        external_origins: config.external_origins,
        external_origins_from: config.external_origins_from.map(OriginsFrom::as_str),
        pairing: config.pairing.as_str(),
        pairing_required: config.pairing_required,
    }
}

fn start(settings: &Settings, uid: u32, err: &mut dyn Write) -> ExitCode {
    let paths = &settings.paths;
    let ready = std::fs::create_dir_all(&paths.state)
        .map_err(|e| format!("bazhen can't make {}: {e}", paths.state))
        .and_then(|()| ensure_private_dir(Path::new(&paths.run), uid).map_err(|e| e.to_string()));
    let exe = std::env::current_exe().map_err(|e| format!("bazhen can't find itself: {e}"));
    let exe = match ready.and(exe) {
        Ok(exe) => exe,
        Err(message) => {
            let _ = writeln!(err, "{message}");
            return ExitCode::FAILURE;
        }
    };
    let env: Env = std::env::vars_os().collect();
    detach(
        &Detach {
            exe: &exe,
            socket: Path::new(&paths.socket),
            state: Path::new(&paths.state),
            url: &format!("http://127.0.0.1:{}", settings.config.port),
            protocol_id: bazhen_protocol::id::PROTOCOL_ID,
            env: &env,
            rules: &settings.config.env_rules,
        },
        &mut std::io::stdout(),
        err,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serves_with_no_argument_and_starts_with_start_and_nothing_else() {
        let args = |list: &[&str]| list.iter().map(OsString::from).collect::<Vec<_>>();
        assert_eq!(
            [
                verb(&args(&[])),
                verb(&args(&["start"])),
                verb(&args(&["--session"])),
                verb(&args(&["start", "now"])),
                verb(&args(&["stop"])),
            ],
            [
                Some(Verb::Serve),
                Some(Verb::Start),
                Some(Verb::Detached),
                None,
                None
            ]
        );
    }
}
