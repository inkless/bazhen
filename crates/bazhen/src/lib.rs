//! `bazhen <verb>`: the daemon's command-line client. It holds no logic of the daemon's: every
//! verb is a call to the daemon's API over its Unix socket, except `start`, which runs the
//! daemon's own start-up, and `attach`, which holds a terminal's stream open over that socket.
//!
//! Its decoders are public so the fuzz targets in `fuzz/` can reach them.

mod args;
pub mod attach;
mod call;
mod daemon_verbs;
mod doctor;
mod events;
mod fmt;
mod lifecycle;
mod out;
mod paths;
mod printers;
pub mod reply;
mod sha256;
mod shells;
mod tasks;

/// The holder's frames, for the fuzz targets to name what a direct attachment sends.
pub use bazhen_holder_proto;
/// The protocol's messages, for the fuzz targets to name what they decode.
pub use bazhen_protocol;

use std::ffi::OsString;
use std::path::Path;
use std::process::ExitCode;
use std::time::{SystemTime, UNIX_EPOCH};

use call::{Daemon, Failed};
use out::Out;

/// How the CLI exits, each a contract a caller branches on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Exit {
    Done,
    Failed,
    /// The command line doesn't say what to do.
    Usage,
    /// No daemon answers.
    NotRunning,
    /// `send --wait`: the message bounced, or a broadcast skipped someone.
    Bounced,
    /// `send --wait`: the message was still on its way when the wait ran out.
    Queued,
    /// `wait`: the agent or shell wasn't in the state when the wait ran out.
    TimedOut,
    /// The status of the daemon's own start-up, as it exited.
    Code(u8),
}

impl Exit {
    pub fn code(self) -> u8 {
        match self {
            Self::Done => 0,
            Self::Failed => 1,
            Self::Usage => 2,
            Self::NotRunning => 3,
            Self::Bounced => 4,
            Self::Queued | Self::TimedOut => 5,
            Self::Code(code) => code,
        }
    }
}

pub(crate) const TASK_USAGE: &str = "usage:
  bazhen agents [--json]
  bazhen whoami
  bazhen roles
  bazhen rename <agent> <name>
  bazhen task list [--all]
  bazhen task show <task>
  bazhen task create --title <title> (--brief <text> | --brief-file <path>) [--parent <task>] [--assign <agent> [--role <role>]]
  bazhen task assign <task> <agent> [--role <role>]
  bazhen task unassign <task> <assignment>
  bazhen task done [<task>] [--note <text>] [--cascade]
  bazhen task cancel <task> [--note <text>] [--cascade]
  bazhen task note [<task>] <text> [--handoff]
  bazhen escalate <question> [--task <task>]
  bazhen send (<agent> | --task <task>) (<text> | --file <path>) [--wait [--timeout <seconds>]]
  bazhen delegate (<agent> | --launch claude-code|codex [--dir <dir>] [--name <name>]) --title <title> (--brief <text> | --brief-file <path>) [--task <task>] [--role <role>]
<agent> is an agent's name or id, and <role> one of the roles bazhen roles lists. send --wait
exits 0 once the agent has the message in a prompt (a turn cut short may still get it again), 4
if it bounced, and 5 if it is still on its way when the timeout (60 s unless given) runs out.";

pub(crate) const LIFECYCLE_USAGE: &str = "usage:
  bazhen launch claude-code|codex [--dir <dir>] [--name <name>] [--role <role>] [--json]
  bazhen close <agent> [--confirm-busy] [--force] [--json]
  bazhen respawn <agent> [--json]
  bazhen relaunch <agent> [--fresh] [--json]
  bazhen signal <agent> INT|TERM|HUP|KILL [--json]
launch starts in --dir, else where it runs. close --confirm-busy ends what runs in the agent's
shells; --force records closed an agent whose terminal's server can't be shown gone, though it
may still run. relaunch --fresh starts a new harness session when the old one can't resume.";

pub(crate) const SHELLS_USAGE: &str = "usage:
  bazhen shells list [--all] [--json]
  bazhen shells open [<agent> | --dir <dir>] [--json]
  bazhen shells close <shell> [--confirm-busy] [--force] [--json]
shells list shows the shells neither closed nor failed, --all every one. A shell opens beside
<agent>, in its directory, else in --dir, else where it runs. <shell> is a shell's id, or a name
one open shell has, in any case. close --confirm-busy ends what runs in it; --force records
closed a shell whose server can't be shown gone.";

pub(crate) const EVENTS_USAGE: &str = "usage:
  bazhen events --follow [--after <event>] [--json]
  bazhen wait <agent|shell> <state>|ended [--timeout <seconds>] [--json]
events --follow prints each event as it happens, after the event --after names if given, until
Ctrl-C, which may wait up to 5 s for a call to the daemon to end; when the daemon goes away it
tries again until it is back. wait exits 0 once the agent or shell is in <state>, or closed or
failed for ended (an agent is running once its harness is up and ready), 1 if it ended
otherwise, and 5 if the timeout (60 s unless given, at least 1) runs out.";

const DAEMON_USAGE: &str = concat!(
    "usage: bazhen <start|stop|status|doctor|env refresh|pair|devices [revoke|dismiss <id>]> ",
    "[--home <dir>] [--port <port>]\n",
    "usage: bazhen attach <agent|shell|terminal> [--direct] [--home <dir>]\n",
    "  Ctrl-\\ Ctrl-\\ detaches; a second kill ends it at once, after which `reset` repairs the terminal\n",
    "  --direct types only while no daemon is there, and lets go of the input once one is back",
);

/// The usage of every verb.
pub(crate) fn usage() -> String {
    [
        DAEMON_USAGE,
        TASK_USAGE,
        LIFECYCLE_USAGE,
        SHELLS_USAGE,
        EVENTS_USAGE,
    ]
    .join("\n")
}

const NOT_RUNNING: &str = "bazhen is not running; start it with `bazhen start`";

/// Runs the command line this process was given.
pub fn main() -> ExitCode {
    let mut out = Out::default();
    ExitCode::from(run(std::env::args_os().skip(1).collect(), &mut out).code())
}

fn run(args: Vec<OsString>, out: &mut Out) -> Exit {
    let p = match args::parse(args) {
        Ok(p) => p,
        Err(args::BadLine(message)) => {
            out.err(&format!("{message}\n{}", usage()));
            return Exit::Usage;
        }
    };
    let socket = match paths::socket(&inputs(p.value("home"))) {
        Ok(socket) => socket,
        Err(relative) => {
            out.err(&relative.to_string());
            return Exit::Failed;
        }
    };
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|d| i64::try_from(d.as_millis()).ok())
        .unwrap_or(0);
    let daemon = Daemon::at(&socket);
    let result = match p.word(0).unwrap_or_default() {
        "agents" | "whoami" | "roles" | "rename" | "task" | "delegate" | "escalate" | "send" => {
            let task_socket = std::env::var("BAZHEN_SOCKET")
                .ok()
                .filter(|s| !s.is_empty())
                .unwrap_or(socket);
            tasks::run(&p, &Daemon::at(task_socket), now_ms, out)
        }
        "launch" | "close" | "respawn" | "relaunch" | "signal" => lifecycle::run(&p, &daemon, out),
        "shells" => shells::run(&p, &daemon, out),
        "events" | "wait" => events::run(&p, &daemon, out),
        "attach" => attach::run(&p, Path::new(&daemon.socket()), &daemon, out),
        "start" => Ok(daemon_verbs::start(&p, out)),
        "stop" => daemon_verbs::stop(&daemon, out),
        "status" => daemon_verbs::status(&daemon, out),
        "doctor" => daemon_verbs::doctor(&daemon, out),
        "pair" => daemon_verbs::pair(&daemon, out),
        "devices" => daemon_verbs::devices(&p, &daemon, now_ms, out),
        "env" => daemon_verbs::env_refresh(&p, &daemon, out),
        _ => {
            out.err(&usage());
            Ok(Exit::Usage)
        }
    };
    match result {
        Ok(exit) => exit,
        Err(Failed::NotRunning) => {
            out.err(NOT_RUNNING);
            Exit::NotRunning
        }
        Err(Failed::Refused(message) | Failed::Unsendable(message)) => {
            out.err(&message);
            Exit::Failed
        }
        Err(Failed::Rejected(rejection)) => {
            out.err(&rejection.to_string());
            Exit::Failed
        }
    }
}

/// This process's inputs to the socket's place, with `--home` over `BAZHEN_HOME`.
fn inputs(home_flag: Option<&str>) -> paths::Inputs {
    let var = |name: &str| std::env::var(name).ok();
    let tmp = ["TMPDIR", "TMP", "TEMP"]
        .iter()
        .find_map(|name| var(name).filter(|v| !v.is_empty()))
        .map_or_else(
            || "/tmp".to_owned(),
            |t| {
                let trimmed = t.trim_end_matches('/');
                if trimmed.is_empty() {
                    "/".to_owned()
                } else {
                    trimmed.to_owned()
                }
            },
        );
    paths::Inputs {
        home_flag: home_flag.map(str::to_owned),
        bazhen_home: var("BAZHEN_HOME"),
        xdg_runtime_dir: var("XDG_RUNTIME_DIR"),
        tmp,
        uid: rustix::process::getuid().as_raw(),
        macos: std::env::consts::OS == "macos",
    }
}
