//! `bazhen <namespace> <verb>`: the daemon's command-line client. It holds no logic of the
//! daemon's: every verb is a call to the daemon's API over its Unix socket, except `start`, which
//! runs the daemon's own start-up, and `terminals attach`, which holds a terminal's stream open
//! over that socket. Only the verbs whose object is Bazhen itself (`start`, `stop`, `status`,
//! `doctor`) have no namespace.
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
    /// `agents send --wait`, `tasks send`: the message bounced, or a broadcast skipped someone.
    Bounced,
    /// `agents send --wait`, `tasks send --wait`: the message was still on its way when the wait
    /// ran out.
    Queued,
    /// `agents wait`, `shells wait`: the agent or shell wasn't in the state when the wait ran out.
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

pub(crate) const AGENTS_USAGE: &str = "usage:
  bazhen agents [list] [--json]
  bazhen agents whoami
  bazhen agents rename <agent> <name>
  bazhen agents send <agent> (<text> | --file <path>) [--wait [--timeout <seconds>]]
  bazhen agents launch claude-code|codex [--dir <dir>] [--name <name>] [--role <role>] [--json]
  bazhen agents close <agent> [--confirm-busy] [--force] [--json]
  bazhen agents respawn <agent> [--json]
  bazhen agents relaunch <agent> [--fresh] [--json]
  bazhen agents signal <agent> INT|TERM|HUP|KILL [--json]
  bazhen agents wait <agent> <state>|ended [--timeout <seconds>] [--json]
<agent> is an agent's name or id, and <role> one of the roles bazhen roles lists. send --wait
exits 0 once the agent has the message in a prompt (a turn cut short may still get it again), 4
if it bounced, and 5 if it is still on its way when the timeout (60 s unless given) runs out.
launch starts in --dir, else where it runs. close --confirm-busy ends what runs in the agent's
shells; --force records closed an agent whose terminal's server can't be shown gone, though it
may still run. relaunch --fresh starts a new harness session when the old one can't resume.
wait exits 0 once the agent is in <state>, or closed or failed for ended (an agent is running
once its harness is up and ready), 1 if it ended otherwise, and 5 if the timeout (60 s unless
given, at least 1) runs out.";

pub(crate) const TASKS_USAGE: &str = "usage:
  bazhen tasks [list] [--all]
  bazhen tasks show <task>
  bazhen tasks create --title <title> (--brief <text> | --brief-file <path>) [--parent <task>] [--assign <agent> [--role <role>]]
  bazhen tasks assign <task> <agent> [--role <role>]
  bazhen tasks unassign <task> <assignment>
  bazhen tasks done [<task>] [--note <text>] [--cascade]
  bazhen tasks cancel <task> [--note <text>] [--cascade]
  bazhen tasks note [<task>] <text> [--handoff]
  bazhen tasks send <task> (<text> | --file <path>) [--wait [--timeout <seconds>]]
  bazhen tasks delegate (<agent> | --launch claude-code|codex [--dir <dir>] [--name <name>]) --title <title> (--brief <text> | --brief-file <path>) [--task <task>] [--role <role>]
<agent> is an agent's name or id, and <role> one of the roles bazhen roles lists. send sends to
everyone else on the task, and exits 4 if it skipped anyone; with --wait, as agents send --wait.";

pub(crate) const INBOX_USAGE: &str = "usage:
  bazhen inbox escalate <question> [--task <task>]";

pub(crate) const ROLES_USAGE: &str = "usage:
  bazhen roles [list]";

pub(crate) const SHELLS_USAGE: &str = "usage:
  bazhen shells [list] [--all] [--json]
  bazhen shells open [<agent> | --dir <dir>] [--json]
  bazhen shells close <shell> [--confirm-busy] [--force] [--json]
  bazhen shells wait <shell> <state>|ended [--timeout <seconds>] [--json]
shells list shows the shells neither closed nor failed, --all every one. A shell opens beside
<agent>, in its directory, else in --dir, else where it runs. <shell> is a shell's id, or a name
one open shell has, in any case. close --confirm-busy ends what runs in it; --force records
closed a shell whose server can't be shown gone. wait exits as agents wait does.";

pub(crate) const EVENTS_USAGE: &str = "usage:
  bazhen events follow [--after <event>] [--json]
events follow prints each event as it happens, after the event --after names if given, until
Ctrl-C, which may wait up to 5 s for a call to the daemon to end; when the daemon goes away it
tries again until it is back.";

const DAEMON_USAGE: &str = concat!(
    "usage: bazhen <start|stop|status|doctor|env refresh> [--home <dir>] [--port <port>]\n",
    "usage: bazhen devices [list | pair | revoke <id> | dismiss <id>]\n",
    "usage: bazhen terminals attach <agent|shell|terminal> [--direct] [--home <dir>]\n",
    "  Ctrl-\\ Ctrl-\\ detaches; a second kill ends it at once, after which `reset` repairs the terminal\n",
    "  --direct types only while no daemon is there, and lets go of the input once one is back",
);

/// The usage of every verb.
pub(crate) fn usage() -> String {
    [
        DAEMON_USAGE,
        AGENTS_USAGE,
        TASKS_USAGE,
        INBOX_USAGE,
        ROLES_USAGE,
        SHELLS_USAGE,
        EVENTS_USAGE,
    ]
    .join("\n")
}

/// Each namespace, with the usage a verb it doesn't have is answered with.
const NAMESPACES: [(&str, &str); 8] = [
    ("agents", AGENTS_USAGE),
    ("tasks", TASKS_USAGE),
    ("inbox", INBOX_USAGE),
    ("roles", ROLES_USAGE),
    ("shells", SHELLS_USAGE),
    ("devices", DAEMON_USAGE),
    ("terminals", DAEMON_USAGE),
    ("env", DAEMON_USAGE),
];

/// The code a command runs on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Handler {
    /// The verbs an agent runs on tasks and on other agents, on its own socket when it has one.
    Fleet(&'static str),
    Lifecycle,
    Shells,
    Wait(events::Kind),
    Follow,
    Attach,
    Start,
    Stop,
    Status,
    Doctor,
    Pair,
    Devices,
    EnvRefresh,
}

/// The code the command `p` names runs on, and how many of its first words name the namespace
/// that code doesn't read: `agents send` reaches `send` as its first word.
fn route(p: &args::Parsed) -> Option<(Handler, usize)> {
    use Handler::{
        Attach, Devices, Doctor, EnvRefresh, Fleet, Follow, Lifecycle, Pair, Shells, Start, Status,
        Stop, Wait,
    };
    Some(match (p.word(0)?, p.word(1)) {
        ("start", _) => (Start, 0),
        ("stop", _) => (Stop, 0),
        ("status", _) => (Status, 0),
        ("doctor", _) => (Doctor, 0),
        ("agents", None | Some("list")) => (Fleet(AGENTS_USAGE), 0),
        ("agents", Some("whoami" | "rename" | "send")) => (Fleet(AGENTS_USAGE), 1),
        ("agents", Some("launch" | "close" | "respawn" | "relaunch" | "signal")) => (Lifecycle, 1),
        ("agents", Some("wait")) => (Wait(events::Kind::Agent), 1),
        (
            "tasks",
            None
            | Some(
                "list" | "show" | "create" | "assign" | "unassign" | "done" | "cancel" | "note"
                | "send",
            ),
        ) => (Fleet(TASKS_USAGE), 0),
        ("tasks", Some("delegate")) => (Fleet(TASKS_USAGE), 1),
        ("inbox", Some("escalate")) => (Fleet(INBOX_USAGE), 1),
        ("roles", None | Some("list")) => (Fleet(ROLES_USAGE), 0),
        ("shells", None | Some("list" | "open" | "close")) => (Shells, 0),
        ("shells", Some("wait")) => (Wait(events::Kind::Shell), 1),
        ("events", _) => (Follow, 0),
        ("terminals", Some("attach")) => (Attach, 1),
        ("devices", Some("pair")) => (Pair, 0),
        ("devices", None | Some("list" | "revoke" | "dismiss")) => (Devices, 0),
        ("env", Some("refresh")) => (EnvRefresh, 0),
        _ => return None,
    })
}

/// What a command line that names no command is told: its namespace's usage when it names one.
fn unknown(p: &args::Parsed) -> String {
    let namespace = p.word(0).unwrap_or_default();
    match NAMESPACES.iter().find(|(name, _)| *name == namespace) {
        Some((name, text)) => match p.word(1) {
            Some(verb) => format!("{name} has no verb {verb}\n{text}"),
            None => format!("{name} needs a verb\n{text}"),
        },
        None => usage(),
    }
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
    let Some((handler, namespace)) = route(&p) else {
        out.err(&unknown(&p));
        return Exit::Usage;
    };
    // `start` hands `--home` to the daemon it starts and reaches no socket.
    let inputs = inputs(p.value("home"), !matches!(handler, Handler::Start));
    let socket = match paths::socket(&inputs, paths::same_socket) {
        Ok(socket) => socket,
        Err(refused) => {
            out.err(&refused.to_string());
            return Exit::Failed;
        }
    };
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|d| i64::try_from(d.as_millis()).ok())
        .unwrap_or(0);
    let daemon = Daemon::at(&socket.path);
    let v = p.skip(namespace);
    let result = match handler {
        Handler::Fleet(usage_text) => tasks::run(&v, &daemon, now_ms, usage_text, out),
        Handler::Lifecycle => lifecycle::run(&v, &daemon, out),
        Handler::Shells => shells::run(&v, &daemon, out),
        Handler::Wait(kind) => events::run_wait(&v, kind, &daemon, out),
        Handler::Follow => events::run_follow(&v, &daemon, out),
        Handler::Attach => attach::run(&v, Path::new(&daemon.socket()), &daemon, out),
        Handler::Start => Ok(daemon_verbs::start(&v, out)),
        Handler::Stop => daemon_verbs::stop(&daemon, out),
        Handler::Status => daemon_verbs::status(&daemon, out),
        Handler::Doctor => daemon_verbs::doctor(&daemon, out),
        Handler::Pair => daemon_verbs::pair(&daemon, out),
        Handler::Devices => daemon_verbs::devices(&v, &daemon, now_ms, out),
        Handler::EnvRefresh => daemon_verbs::env_refresh(&v, &daemon, out),
    };
    match result {
        Ok(exit) => exit,
        Err(Failed::NotRunning) if socket.from_env => {
            out.err(&format!(
                "bazhen is not running on BAZHEN_SOCKET {}; run with BAZHEN_SOCKET= to reach \
                 the daemon your home names",
                socket.path
            ));
            Exit::NotRunning
        }
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

/// This process's inputs to the socket's place: `BAZHEN_SOCKET` if `with_socket`, then `--home`,
/// then `BAZHEN_HOME`.
fn inputs(home_flag: Option<&str>, with_socket: bool) -> paths::Inputs {
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
        bazhen_socket: std::env::var_os("BAZHEN_SOCKET")
            .filter(|_| with_socket)
            .map(|v| v.to_string_lossy().into_owned()),
        home_flag: home_flag.map(str::to_owned),
        bazhen_home: var("BAZHEN_HOME"),
        xdg_runtime_dir: var("XDG_RUNTIME_DIR"),
        tmp,
        uid: rustix::process::getuid().as_raw(),
        macos: std::env::consts::OS == "macos",
    }
}
