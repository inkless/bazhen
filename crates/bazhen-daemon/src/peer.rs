//! Who is at the other end of a connection (`auth/peer.ts`), read in-process: a Unix socket's peer
//! by `bazhen_peer::of`, a loopback TCP caller as the processes holding its socket
//! (`bazhen_peer::tcp`); and whose process that is among the terminals the daemon runs.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::io;
use std::net::SocketAddr;
use std::os::fd::{AsFd as _, BorrowedFd, OwnedFd};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use bazhen_peer::tcp::{self, ProcView, Scan};
use bazhen_peer::{Peer, Refused};
use bazhen_protocol::ids::AgentId;
use bazhen_store::LiveTerminal;
use rustix::process::Pid;
use serde_json::Value;
use tokio::sync::{OwnedSemaphorePermit, Semaphore, oneshot};
use tokio_util::task::TaskTracker;

use crate::config::js;

/// How long one reading may take: the peer is waiting on its own reply meanwhile.
pub(crate) const READ: Duration = Duration::from_secs(2);

/// The most readings at once; more wait their turn.
pub(crate) const MAX_READING: usize = 8;

/// Why a loopback TCP caller isn't read where `/proc` doesn't say who holds a socket.
pub(crate) const UNIDENTIFIABLE: &str =
    "the caller of a loopback HTTP request can't be identified on this platform";

/// A connection, as every request on it carries it: its end of a Unix socket, a dup of its
/// descriptor or why there is none, or a loopback TCP connection's two addresses; and the epoch
/// second it was accepted by, which its peer's process must have started by.
#[derive(Debug, Clone)]
pub(crate) struct PeerSocket {
    end: End,
    accepted: u64,
}

#[derive(Debug, Clone)]
enum End {
    Unix(Arc<OwnedFd>),
    Tcp {
        client: SocketAddr,
        server: SocketAddr,
    },
    Unreadable(String),
}

/// Now, as the epoch second a connection accepted now was accepted by.
fn accepted_now() -> u64 {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_millis());
    u64::try_from(ms.div_ceil(1000)).unwrap_or(u64::MAX)
}

impl PeerSocket {
    /// `socket`, accepted now.
    pub(crate) fn accepted_now(socket: BorrowedFd<'_>) -> Self {
        Self {
            end: match socket.try_clone_to_owned() {
                Ok(fd) => End::Unix(Arc::new(fd)),
                Err(err) => End::Unreadable(Refused::Unreadable(err).to_string()),
            },
            accepted: accepted_now(),
        }
    }

    /// A TCP connection, from `client` to the daemon's `server` as each end's address was read,
    /// accepted now.
    pub(crate) fn tcp_accepted_now(
        client: io::Result<SocketAddr>,
        server: io::Result<SocketAddr>,
    ) -> Self {
        Self {
            end: match (client, server) {
                (Ok(client), Ok(server)) => End::Tcp { client, server },
                (Err(err), _) | (_, Err(err)) => {
                    End::Unreadable(Refused::Unreadable(err).to_string())
                }
            },
            accepted: accepted_now(),
        }
    }
}

/// A reading of a connection's peer: who it is, or each process holding a TCP caller's socket;
/// nobody, and why; or late, when the reading was still running at its deadline, which says
/// nothing of the caller but that it wasn't read in time; or to be tried again, when the caller
/// changed while it was read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PeerRead {
    Read(Peer),
    Held(Vec<Peer>),
    Unread(String),
    Late,
    Retry(String),
}

type ReadFn = dyn Fn(BorrowedFd<'_>, u64) -> Result<Peer, Refused> + Send + Sync;
type HolderFn = dyn Fn(Pid, u64) -> Result<Peer, Refused> + Send + Sync;
type View = dyn ProcView + Send + Sync;

/// Reads loopback TCP callers: each one's socket from the connection tables, then the processes
/// holding it, found by one pass over `/proc` for every caller waiting when the pass starts, so
/// callers that arrive together cost one pass rather than one each; then each holder, as a Unix
/// socket's peer is read.
pub(crate) struct Tcp {
    view: Arc<View>,
    read: Arc<HolderFn>,
    uid: u32,
    pass: Mutex<Pass>,
    passes: TaskTracker,
}

/// The callers waiting on the next pass: their sockets, and where to answer each.
#[derive(Default)]
struct Pass {
    inodes: BTreeSet<u64>,
    waiting: Vec<oneshot::Sender<Arc<Result<Scan, String>>>>,
    running: bool,
}

impl Tcp {
    pub(crate) fn new(
        view: Arc<View>,
        uid: u32,
        read: impl Fn(Pid, u64) -> Result<Peer, Refused> + Send + Sync + 'static,
    ) -> Self {
        Self {
            view,
            read: Arc::new(read),
            uid,
            pass: Mutex::new(Pass::default()),
            passes: TaskTracker::new(),
        }
    }

    /// The processes holding the socket of the caller connected from `client` to `server`, each
    /// read as one that started by `accepted`. Each read of `/proc` holds `turn` until it ends,
    /// even once this is given up on.
    async fn read(
        self: Arc<Self>,
        client: SocketAddr,
        server: SocketAddr,
        accepted: u64,
        turn: Arc<OwnedSemaphorePermit>,
    ) -> Result<Vec<Peer>, Refused> {
        let (view, uid) = (Arc::clone(&self.view), self.uid);
        let inode = blocking(&turn, move || tcp::end(&*view, client, server, uid)).await?;
        let scanned = self.scanned(inode).await;
        let (view, read) = (Arc::clone(&self.view), Arc::clone(&self.read));
        blocking(&turn, move || {
            let scan = scanned
                .as_ref()
                .as_ref()
                .map_err(|why| Refused::Unreadable(io::Error::other(why.clone())))?;
            let holders = tcp::holders(scan, inode)?;
            tcp::peers(&*view, inode, &holders, |pid| read(pid, accepted))
        })
        .await
    }

    /// The pass that finds who holds `inode`: the next to start.
    async fn scanned(self: &Arc<Self>, inode: u64) -> Arc<Result<Scan, String>> {
        let (answer, answered) = oneshot::channel();
        let start = {
            let mut pass = self.pass.lock().unwrap_or_else(PoisonError::into_inner);
            pass.inodes.insert(inode);
            pass.waiting.push(answer);
            !std::mem::replace(&mut pass.running, true)
        };
        if start {
            self.passes.spawn(Arc::clone(self).run());
        }
        answered
            .await
            .unwrap_or_else(|_| Arc::new(Err("the scan ended without an answer".to_owned())))
    }

    /// Passes, each for every caller waiting when it starts, until none is.
    async fn run(self: Arc<Self>) {
        loop {
            let (inodes, waiting) = {
                let mut pass = self.pass.lock().unwrap_or_else(PoisonError::into_inner);
                if pass.waiting.is_empty() {
                    pass.running = false;
                    return;
                }
                (
                    std::mem::take(&mut pass.inodes),
                    std::mem::take(&mut pass.waiting),
                )
            };
            let view = Arc::clone(&self.view);
            let scanned = tokio::task::spawn_blocking(move || {
                tcp::scan(&*view, &inodes).map_err(|err| err.to_string())
            })
            .await
            .unwrap_or_else(|_| Err("the scan panicked".to_owned()));
            let scanned = Arc::new(scanned);
            for answer in waiting {
                let _ = answer.send(Arc::clone(&scanned));
            }
        }
    }

    /// How many callers wait on the next pass.
    #[cfg(test)]
    fn waiting(&self) -> usize {
        self.pass
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .waiting
            .len()
    }
}

/// `read` on a blocking thread, which holds `turn` until it ends.
async fn blocking<T: Send + 'static>(
    turn: &Arc<OwnedSemaphorePermit>,
    read: impl FnOnce() -> Result<T, Refused> + Send + 'static,
) -> Result<T, Refused> {
    let turn = Arc::clone(turn);
    tokio::task::spawn_blocking(move || {
        let _turn = turn;
        read()
    })
    .await
    .unwrap_or_else(|_| Err(Refused::Unreadable(io::Error::other("the reader panicked"))))
}

/// What one reading reads.
enum Job {
    Unix(Arc<OwnedFd>),
    Tcp(Arc<Tcp>, SocketAddr, SocketAddr),
}

/// Reads peers, at most `MAX_READING` at once, each on a blocking thread that holds its turn until
/// it ends: one given up on still counts, so a slow `/proc` can't take every thread. A read is late
/// when it waits its deadline for a turn, which TypeScript doesn't bound, or then reads past its
/// deadline. One given up on keeps its own copy of the connection's fd until it ends, so the peer
/// sees the close no sooner.
#[derive(Clone)]
pub(crate) struct Peers {
    turns: Arc<Semaphore>,
    deadline: Duration,
    read: Arc<ReadFn>,
    tcp: Option<Arc<Tcp>>,
}

impl std::fmt::Debug for Peers {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Peers")
            .field("deadline", &self.deadline)
            .finish_non_exhaustive()
    }
}

impl Default for Peers {
    fn default() -> Self {
        Self::with(READ, bazhen_peer::of)
    }
}

impl Peers {
    pub(crate) fn with(
        deadline: Duration,
        read: impl Fn(BorrowedFd<'_>, u64) -> Result<Peer, Refused> + Send + Sync + 'static,
    ) -> Self {
        Self {
            turns: Arc::new(Semaphore::new(MAX_READING)),
            deadline,
            read: Arc::new(read),
            // Where `/proc` says who holds a socket; elsewhere every TCP caller is refused.
            #[cfg(target_os = "linux")]
            tcp: Some(Arc::new(Tcp::new(
                Arc::new(tcp::Proc),
                rustix::process::geteuid().as_raw(),
                bazhen_peer::of_pid,
            ))),
            #[cfg(target_os = "macos")]
            tcp: None,
        }
    }

    /// These, reading TCP callers with `tcp`, or refusing every one with none.
    #[cfg(test)]
    pub(crate) fn with_tcp(self, tcp: Option<Arc<Tcp>>) -> Self {
        Self { tcp, ..self }
    }

    /// Who is at the other end of `socket`. The deadline runs from the reading's turn, which a TCP
    /// caller holds through its pass too.
    pub(crate) async fn read(&self, socket: &PeerSocket) -> PeerRead {
        let accepted = socket.accepted;
        let job = match (&socket.end, &self.tcp) {
            (End::Unreadable(why), _) => return PeerRead::Unread(why.clone()),
            (End::Tcp { .. }, None) => return PeerRead::Unread(UNIDENTIFIABLE.to_owned()),
            (End::Unix(fd), _) => Job::Unix(Arc::clone(fd)),
            (End::Tcp { client, server }, Some(tcp)) => Job::Tcp(Arc::clone(tcp), *client, *server),
        };
        let turns = Arc::clone(&self.turns);
        let Ok(Ok(turn)) = tokio::time::timeout(self.deadline, turns.acquire_owned()).await else {
            return PeerRead::Late;
        };
        let read = match job {
            Job::Tcp(tcp, client, server) => {
                let reading = tcp.read(client, server, accepted, Arc::new(turn));
                tokio::time::timeout(self.deadline, reading)
                    .await
                    .map(|read| Some(read.map(PeerRead::Held)))
            }
            Job::Unix(fd) => {
                let read = Arc::clone(&self.read);
                let reading = tokio::task::spawn_blocking(move || {
                    let _turn = turn;
                    read(fd.as_fd(), accepted).map(PeerRead::Read)
                });
                tokio::time::timeout(self.deadline, reading)
                    .await
                    .map(Result::ok)
            }
        };
        match read {
            Err(_) => PeerRead::Late,
            Ok(None) => PeerRead::Unread("the reader panicked".to_owned()),
            Ok(Some(Err(refused))) if refused.is_race() => PeerRead::Retry(refused.to_string()),
            Ok(Some(Err(refused))) => PeerRead::Unread(refused.to_string()),
            Ok(Some(Ok(read))) => read,
        }
    }
}

/// The processes the daemon's terminals run, as their locators record them.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(crate) struct TerminalPids {
    /// Each live agent terminal's root process: a tmux pane's, or a holder's child.
    pub(crate) agents: HashMap<i32, AgentId>,
    /// Each live shell terminal's root process.
    pub(crate) shells: HashSet<i32>,
    /// The processes that run terminals: tmux servers and holders.
    pub(crate) runtimes: HashSet<i32>,
}

/// The pids `terminals` record, as the TypeScript store reads them.
pub(crate) fn terminal_pids(terminals: &[LiveTerminal]) -> TerminalPids {
    let mut pids = TerminalPids::default();
    for terminal in terminals {
        let (root, runtime) = pids_of(&terminal.locator);
        if let Some(runtime) = runtime {
            pids.runtimes.insert(runtime);
        }
        let Some(root) = root else { continue };
        if terminal.kind == "shell" {
            pids.shells.insert(root);
        } else if let Some(agent) = terminal.agent_id.as_deref().and_then(AgentId::parse) {
            pids.agents.insert(root, agent);
        }
    }
    pids
}

/// A locator's root process, a tmux pane's or a holder's child, and the process that runs it, a
/// tmux server or a holder, each where it records one.
fn pids_of(locator: &str) -> (Option<i32>, Option<i32>) {
    let at = match serde_json::from_str(locator) {
        Ok(Value::Object(at)) => at,
        _ => serde_json::Map::new(),
    };
    let pid = |key: &str| at.get(key).and_then(pid_of);
    (
        pid("panePid").or_else(|| pid("childPid")),
        pid("serverPid").or_else(|| pid("holderPid")),
    )
}

/// The root process a terminal's locator records, as `terminal_pids` reads it.
pub(crate) fn root_of(locator: &str) -> Option<i32> {
    pids_of(locator).0
}

/// A pid a locator records, when JavaScript's `Number` of it is one: an integer past 1. One past
/// any pid's range is none, as no process can have it.
fn pid_of(value: &Value) -> Option<i32> {
    let n = js_number_of(value, false);
    // A whole number prints as its digits, which read as an integer; a fraction prints its point.
    (n > 1.0 && n <= f64::from(i32::MAX))
        .then(|| format!("{n}").parse().ok())
        .flatten()
}

/// JavaScript's `Number(value)`, of a JSON value: an array is its one element's, as its text is.
fn js_number_of(value: &Value, in_array: bool) -> f64 {
    match value {
        Value::Null => 0.0,
        Value::Bool(b) if !in_array => f64::from(u8::from(*b)),
        Value::Bool(_) | Value::Object(_) => f64::NAN,
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::String(s) => js::number(s),
        Value::Array(items) => match items.as_slice() {
            [] => 0.0,
            [item] => js_number_of(item, true),
            _ => f64::NAN,
        },
    }
}

/// How a Codex tool call is known: by the app-server among the caller and its ancestors, or only by
/// the `CODEX_THREAD_ID` in its own environment.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Via {
    Server,
    Environment,
}

/// What a socket peer's process says of the caller. `Withheld` is outside every agent's terminal
/// with its environment unread, so only the thread the call presents can say it is Codex's.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Reading {
    Agent(AgentId, How),
    Codex(Via),
    Outside,
    Withheld,
    Refused(String),
    Late,
}

/// How a caller reads as an agent's: the process read, the caller's own or one holding its socket,
/// and whether the agent's root process is it or an ancestor, or leads its session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct How {
    pub(crate) pid: i32,
    pub(crate) by: By,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum By {
    Ancestry,
    Session,
}

impl How {
    /// Why `agent` is the caller, for a refusal to name the cause, such as a browser first started
    /// from an agent's terminal.
    pub(crate) fn of(&self, agent: &AgentId) -> String {
        let (pid, agent) = (self.pid, agent.as_str());
        match self.by {
            By::Ancestry => {
                format!("the caller, pid {pid}, was started from {agent}'s terminal")
            }
            By::Session => {
                format!("the caller, pid {pid}, is in {agent}'s terminal's session")
            }
        }
    }
}

impl Reading {
    /// Whether `self` and `other` are one caller, however each came to be it.
    fn is_as(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Agent(one, _), Self::Agent(another, _)) => one == another,
            _ => self == other,
        }
    }
}

/// Whose process `peer` is: an agent's, when the agent's root process is it or an ancestor, or
/// leads its session; a Codex tool call, under an app-server nearer than any agent's root;
/// nobody's, from a shell's terminal or outside every one. A process under a runtime in no
/// terminal, as `tmux run-shell` starts one, is refused rather than taken for the human.
pub(crate) fn reading_of(peer: &Peer, terminals: &TerminalPids) -> Reading {
    let line: Vec<i32> = std::iter::once(peer.pid)
        .chain(peer.ancestors.iter().copied())
        .map(rustix::process::Pid::as_raw_pid)
        .collect();
    let agent_at = line
        .iter()
        .position(|pid| terminals.agents.contains_key(pid));
    let agent = agent_at
        .and_then(|at| line.get(at))
        .and_then(|pid| terminals.agents.get(pid))
        .map(|agent| (agent, By::Ancestry))
        .or_else(|| {
            peer.session
                .and_then(|session| terminals.agents.get(&session.as_raw_pid()))
                .map(|agent| (agent, By::Session))
        });
    let marked_only = peer.codex_server == Some(peer.pid);
    let server_at = peer
        .codex_server
        .filter(|_| !marked_only)
        .and_then(|server| line.iter().position(|pid| *pid == server.as_raw_pid()));
    if let Some(server_at) = server_at
        && agent_at.is_none_or(|agent_at| server_at < agent_at)
    {
        return Reading::Codex(Via::Server);
    }
    if let Some((agent, by)) = agent {
        let pid = peer.pid.as_raw_pid();
        return Reading::Agent(agent.clone(), How { pid, by });
    }
    if marked_only {
        return Reading::Codex(Via::Environment);
    }
    let outside = if peer.environment_withheld {
        Reading::Withheld
    } else {
        Reading::Outside
    };
    if line.iter().any(|pid| terminals.shells.contains(pid)) {
        return outside;
    }
    if line.iter().any(|pid| terminals.runtimes.contains(pid)) {
        return Reading::Refused(
            "the caller runs under Bazhen's runtime, in no terminal".to_owned(),
        );
    }
    outside
}

/// The reading the guard takes: a peer that can't be read for sure is refused, never the human's,
/// and one not read in time is late. Each is logged with why, since the caller may not say.
///
/// # Errors
///
/// `terminals`'.
pub(crate) fn reading<E>(
    read: PeerRead,
    terminals: impl FnOnce() -> Result<TerminalPids, E>,
) -> Result<Reading, E> {
    Ok(match read {
        PeerRead::Late => {
            tracing::warn!("a caller's process wasn't read in time; it was told to try again");
            Reading::Late
        }
        PeerRead::Unread(why) => {
            let why = format!("the caller's process can't be read for sure: {why}");
            tracing::warn!("refused a caller: {why}");
            Reading::Refused(why)
        }
        PeerRead::Retry(why) => {
            tracing::warn!("a caller changed while it was read; it was told to try again: {why}");
            Reading::Late
        }
        PeerRead::Read(peer) => reading_of(&peer, &terminals()?),
        PeerRead::Held(peers) => held(&peers, &terminals()?),
    })
}

/// What the processes holding a TCP caller's socket say of it: their reading when they all agree,
/// else refused, since one of them may be an agent's.
fn held(peers: &[Peer], terminals: &TerminalPids) -> Reading {
    let mut readings = peers.iter().map(|peer| reading_of(peer, terminals));
    let refused = |why: &str| {
        tracing::warn!("refused a caller: {why}");
        Reading::Refused(why.to_owned())
    };
    match readings.next() {
        None => refused("no process holds the caller's socket"),
        Some(first) if readings.all(|other| other.is_as(&first)) => first,
        Some(_) => refused("the processes holding the caller's socket read as different callers"),
    }
}

#[cfg(test)]
mod tests {
    use std::os::unix::net::UnixStream;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Condvar, Mutex};

    use rustix::process::Pid;

    use super::*;
    use crate::testing::{paused, runtime};

    const AGENT: &str = "agent_0190a1b2c3d47abc8def0123456789ab";
    const OTHER: &str = "agent_0190a1b2c3d47abc8def0123456789ac";

    /// `AGENT`'s pane runs pid 100 and `OTHER`'s 200, a shell's 300, on a tmux server of pid 10.
    fn terminals() -> TerminalPids {
        TerminalPids {
            agents: HashMap::from([(100, id(AGENT)), (200, id(OTHER))]),
            shells: HashSet::from([300]),
            runtimes: HashSet::from([10]),
        }
    }

    fn id(text: &str) -> AgentId {
        AgentId::parse(text).unwrap()
    }

    fn pid(raw: i32) -> Pid {
        Pid::from_raw(raw).unwrap()
    }

    /// A peer with no Codex mark and its environment read; a session of 0 is none.
    fn chain(at: i32, session: i32, ancestors: &[i32]) -> Peer {
        Peer {
            pid: pid(at),
            session: Pid::from_raw(session),
            codex_server: None,
            environment_withheld: false,
            ancestors: ancestors.iter().copied().map(pid).collect(),
            names: vec![String::new(); ancestors.len()],
        }
    }

    fn via(server: i32, line: Peer) -> Peer {
        Peer {
            codex_server: Some(pid(server)),
            ..line
        }
    }

    fn withheld(line: Peer) -> Peer {
        Peer {
            environment_withheld: true,
            ..line
        }
    }

    fn of(peers: &[Peer]) -> Vec<Reading> {
        peers.iter().map(|p| reading_of(p, &terminals())).collect()
    }

    const SERVER: Reading = Reading::Codex(Via::Server);
    const ENVIRONMENT: Reading = Reading::Codex(Via::Environment);

    /// Agent `AGENT`'s caller, read at `pid`.
    fn agent(pid: i32, by: By) -> Reading {
        Reading::Agent(id(AGENT), How { pid, by })
    }

    #[test]
    fn names_the_agent_whose_pane_process_is_the_caller_or_its_nearest_such_ancestor() {
        assert_eq!(
            of(&[
                chain(100, 100, &[10, 1]),
                chain(150, 150, &[140, 100, 10, 1]),
                chain(250, 250, &[200, 100, 10, 1]),
            ]),
            [
                agent(100, By::Ancestry),
                agent(150, By::Ancestry),
                Reading::Agent(
                    id(OTHER),
                    How {
                        pid: 250,
                        by: By::Ancestry
                    }
                )
            ]
        );
    }

    #[test]
    fn names_the_agent_whose_pane_leads_the_session_of_a_caller_orphaned_away_from_it() {
        assert_eq!(of(&[chain(150, 100, &[1])]), [agent(150, By::Session)]);
    }

    #[test]
    fn names_nobody_for_a_caller_in_a_shells_terminal_or_outside_every_terminal() {
        assert_eq!(
            of(&[
                chain(350, 300, &[300, 10, 1]),
                chain(950, 900, &[900, 1]),
                chain(950, 0, &[1])
            ]),
            [Reading::Outside, Reading::Outside, Reading::Outside]
        );
    }

    #[test]
    fn reads_a_caller_under_a_codex_app_server_as_a_codex_tool_call_never_as_outside() {
        assert_eq!(
            of(&[
                via(900, chain(950, 950, &[900, 1])),
                via(900, chain(900, 900, &[1])),
                via(900, chain(950, 950, &[900, 300, 10, 1])),
                via(900, chain(950, 950, &[900, 15, 10, 1])),
                via(900, chain(950, 100, &[900, 1])),
            ]),
            [SERVER, ENVIRONMENT, SERVER, SERVER, SERVER]
        );
    }

    #[test]
    fn reads_whichever_is_nearer_the_caller_a_codex_app_server_or_an_agents_process() {
        assert_eq!(
            of(&[
                via(900, chain(950, 950, &[900, 100, 10, 1])),
                via(900, chain(150, 150, &[100, 10, 900, 1])),
            ]),
            [SERVER, agent(150, By::Ancestry)]
        );
    }

    #[test]
    fn names_the_agent_whose_terminal_a_caller_marked_only_by_its_environment_runs_in() {
        assert_eq!(
            of(&[
                via(150, chain(150, 150, &[100, 10, 1])),
                via(150, chain(150, 100, &[1])),
                via(950, chain(950, 950, &[1])),
                via(350, chain(350, 300, &[300, 10, 1])),
            ]),
            [
                agent(150, By::Ancestry),
                agent(150, By::Session),
                ENVIRONMENT,
                ENVIRONMENT
            ]
        );
    }

    #[test]
    fn refuses_a_caller_the_runtime_runs_in_no_terminal_as_tmux_run_shell_starts_one() {
        assert_eq!(
            of(&[chain(15, 15, &[10, 1])]),
            [Reading::Refused(
                "the caller runs under Bazhen's runtime, in no terminal".to_owned()
            )]
        );
    }

    #[test]
    fn reads_a_caller_whose_environment_was_withheld_as_withheld_only_outside_every_agents_terminal()
     {
        let refused =
            Reading::Refused("the caller runs under Bazhen's runtime, in no terminal".to_owned());
        assert_eq!(
            of(&[
                withheld(chain(950, 950, &[900, 1])),
                withheld(chain(350, 300, &[300, 10, 1])),
                withheld(chain(150, 150, &[100, 10, 1])),
                withheld(chain(150, 100, &[1])),
                withheld(via(900, chain(950, 950, &[900, 1]))),
                withheld(chain(15, 15, &[10, 1])),
            ]),
            [
                Reading::Withheld,
                Reading::Withheld,
                agent(150, By::Ancestry),
                agent(150, By::Session),
                SERVER,
                refused
            ]
        );
    }

    fn live(kind: &str, agent_id: Option<&str>, locator: &str) -> LiveTerminal {
        LiveTerminal {
            kind: kind.to_owned(),
            agent_id: agent_id.map(str::to_owned),
            locator: locator.to_owned(),
        }
    }

    #[test]
    fn names_each_terminals_root_and_runtime_as_its_locator_records_them() {
        let pids = terminal_pids(&[
            live(
                "agent",
                Some(AGENT),
                r#"{"panePid":"100","serverPid":"10"}"#,
            ),
            live(
                "agent",
                Some(OTHER),
                r#"{"holderPid":"700","childPid":"701"}"#,
            ),
            live("shell", None, r#"{"childPid":300,"holderPid":"702"}"#),
            live(
                "agent",
                Some(OTHER),
                r#"{"panePid":"800","childPid":"801"}"#,
            ),
        ]);
        assert_eq!(
            pids,
            TerminalPids {
                agents: HashMap::from([(100, id(AGENT)), (701, id(OTHER)), (800, id(OTHER))]),
                shells: HashSet::from([300]),
                runtimes: HashSet::from([10, 700, 702]),
            }
        );
    }

    #[test]
    fn takes_a_pid_as_javascripts_number_does_and_only_an_integer_past_1() {
        let root = |value: &str| {
            let pids = terminal_pids(&[live("shell", None, &format!(r#"{{"childPid":{value}}}"#))]);
            pids.shells.into_iter().next()
        };
        for (value, expected) in [
            ("42", Some(42)),
            (r#""42""#, Some(42)),
            (r#"" 42 ""#, Some(42)),
            (r#""0x2a""#, Some(42)),
            (r#""4.2e1""#, Some(42)),
            ("[42]", Some(42)),
            (r#"["42"]"#, Some(42)),
            ("[[42]]", Some(42)),
            ("42.0", Some(42)),
            ("1", None),
            ("0", None),
            ("-42", None),
            ("42.5", None),
            ("true", None),
            ("[true]", None),
            ("null", None),
            ("[]", None),
            ("[42, 43]", None),
            (r#"{"pid":42}"#, None),
            (r#""42abc""#, None),
            (r#""""#, None),
            ("2147483648", None),
        ] {
            assert_eq!(root(value), expected, "{value}");
        }
    }

    #[test]
    fn skips_a_terminal_whose_root_or_agent_isnt_one() {
        let pids = terminal_pids(&[
            live(
                "agent",
                Some("agent_x"),
                r#"{"panePid":"100","serverPid":"10"}"#,
            ),
            live("agent", None, r#"{"panePid":"101"}"#),
            live("agent", Some(AGENT), r#"{"serverPid":"11"}"#),
            live("agent", Some(AGENT), "[100]"),
            live("agent", Some(AGENT), "not json"),
            live("shell", None, r#""100""#),
        ]);
        assert_eq!(
            pids,
            TerminalPids {
                runtimes: HashSet::from([10, 11]),
                ..TerminalPids::default()
            }
        );
    }

    #[test]
    fn refuses_a_peer_it_cant_read_for_sure_never_taking_it_for_the_human_and_says_why() {
        let said = crate::shells::tests::Said::default();
        let _logging = said.logging();
        let read = |read| reading(read, || Ok::<_, ()>(terminals())).unwrap();
        assert_eq!(
            [
                read(PeerRead::Unread("why".into())),
                read(PeerRead::Late),
                read(PeerRead::Read(chain(100, 100, &[1]))),
            ],
            [
                Reading::Refused("the caller's process can't be read for sure: why".into()),
                Reading::Late,
                agent(100, By::Ancestry),
            ]
        );
        assert_eq!(
            [
                said.times("refused a caller: the caller's process can't be read for sure: why"),
                said.times("a caller's process wasn't read in time; it was told to try again"),
            ],
            [1, 1]
        );
        assert_eq!(
            reading(PeerRead::Read(chain(100, 100, &[1])), || Err("store")),
            Err("store")
        );
    }

    /// A gate the readings below wait at until it opens.
    #[derive(Default)]
    struct Gate {
        open: Mutex<bool>,
        opened: Condvar,
        started: AtomicUsize,
    }

    impl Gate {
        fn wait(&self) {
            self.started.fetch_add(1, Ordering::SeqCst);
            let mut open = self.open.lock().unwrap();
            while !*open {
                open = self.opened.wait(open).unwrap();
            }
        }

        fn open(&self) {
            *self
                .open
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = true;
            self.opened.notify_all();
        }

        /// Waits until `n` readings have started, letting the runtime's tasks run meanwhile.
        async fn started_by(&self, n: usize) {
            let by = std::time::Instant::now() + Duration::from_secs(10);
            while self.started.load(Ordering::SeqCst) < n {
                assert!(std::time::Instant::now() < by, "{n} readings never started");
                tokio::task::yield_now().await;
                std::thread::sleep(Duration::from_millis(1));
            }
        }
    }

    /// Opens its gate when dropped, so a test that fails with readings still waiting ends.
    struct Opens(Arc<Gate>);

    impl Drop for Opens {
        fn drop(&mut self) {
            self.0.open();
        }
    }

    fn socket() -> (PeerSocket, UnixStream) {
        let (ours, theirs) = UnixStream::pair().unwrap();
        (PeerSocket::accepted_now(ours.as_fd()), theirs)
    }

    #[test]
    fn reads_a_reading_still_running_at_its_deadline_as_late_and_one_done_by_then_as_read() {
        let gate = Arc::new(Gate::default());
        let waiting = Arc::clone(&gate);
        let reader = Peers::with(READ, move |_, _| {
            waiting.wait();
            Err(Refused::Endless)
        });
        let (peer, _theirs) = socket();
        let runtime = paused();
        let _opens = Opens(Arc::clone(&gate));
        runtime.block_on(async {
            let tasks = tokio_util::task::TaskTracker::new();
            let read = tasks.spawn({
                let reader = reader.clone();
                let peer = peer.clone();
                async move { reader.read(&peer).await }
            });
            gate.started_by(1).await;
            tokio::time::advance(READ.saturating_sub(Duration::from_millis(1))).await;
            tokio::task::yield_now().await;
            assert!(!read.is_finished());
            tokio::time::advance(Duration::from_millis(1)).await;
            assert_eq!(read.await.unwrap(), PeerRead::Late);
            gate.open();
            assert_eq!(
                reader.read(&peer).await,
                PeerRead::Unread(Refused::Endless.to_string())
            );
        });
    }

    #[test]
    fn gives_a_read_that_waited_for_its_turn_its_whole_deadline_to_read() {
        let first = Arc::new(Gate::default());
        let ninth = Arc::new(Gate::default());
        let (holding, reading) = (Arc::clone(&first), Arc::clone(&ninth));
        let calls = Arc::new(AtomicUsize::new(0));
        let reader = Peers::with(READ, move |_, _| {
            if calls.fetch_add(1, Ordering::SeqCst) < MAX_READING {
                holding.wait();
            } else {
                reading.wait();
            }
            Err(Refused::Endless)
        });
        let (peer, _theirs) = socket();
        let runtime = paused();
        let _opens = (Opens(Arc::clone(&first)), Opens(Arc::clone(&ninth)));
        runtime.block_on(async {
            let tasks = tokio_util::task::TaskTracker::new();
            let read = |reader: &Peers| {
                let reader = reader.clone();
                let peer = peer.clone();
                tasks.spawn(async move { reader.read(&peer).await })
            };
            let held: Vec<_> = (0..MAX_READING).map(|_| read(&reader)).collect();
            first.started_by(MAX_READING).await;
            let waiting = read(&reader);
            settle().await;
            tokio::time::advance(Duration::from_millis(1500)).await;
            first.open();
            ninth.started_by(1).await;
            for held in held {
                assert_eq!(
                    held.await.unwrap(),
                    PeerRead::Unread(Refused::Endless.to_string())
                );
            }
            // Past two seconds from the request, but one into the read: it reads in time.
            tokio::time::advance(Duration::from_secs(1)).await;
            settle().await;
            assert!(!waiting.is_finished());
            ninth.open();
            assert_eq!(
                waiting.await.unwrap(),
                PeerRead::Unread(Refused::Endless.to_string())
            );
        });
    }

    /// Lets every task the runtime has woken run.
    async fn settle() {
        for _ in 0..10 {
            tokio::task::yield_now().await;
            std::thread::sleep(Duration::from_millis(1));
        }
    }

    #[test]
    fn reads_no_more_than_eight_at_once_and_answers_late_one_still_waiting_for_a_turn_at_its_deadline()
     {
        let gate = Arc::new(Gate::default());
        let waiting = Arc::clone(&gate);
        let reader = Peers::with(Duration::from_millis(10), move |_, _| {
            waiting.wait();
            Err(Refused::Endless)
        });
        let (peer, _theirs) = socket();
        let runtime = runtime();
        let _opens = Opens(Arc::clone(&gate));
        runtime.block_on(async {
            let tasks = tokio_util::task::TaskTracker::new();
            let reads: Vec<_> = (0..=MAX_READING)
                .map(|_| {
                    let reader = reader.clone();
                    let peer = peer.clone();
                    tasks.spawn(async move { reader.read(&peer).await })
                })
                .collect();
            gate.started_by(MAX_READING).await;
            // The eight given up on still hold their turns; the ninth never had one.
            for read in reads {
                let read = tokio::time::timeout(Duration::from_secs(5), read).await;
                assert_eq!(read.map(Result::unwrap), Ok(PeerRead::Late));
            }
            assert_eq!(gate.started.load(Ordering::SeqCst), MAX_READING);
            assert_eq!(reader.read(&peer).await, PeerRead::Late);
            gate.open();
            let by = std::time::Instant::now() + Duration::from_secs(10);
            let mut read = reader.read(&peer).await;
            while read == PeerRead::Late && std::time::Instant::now() < by {
                tokio::time::sleep(Duration::from_millis(1)).await;
                read = reader.read(&peer).await;
            }
            assert_eq!(read, PeerRead::Unread(Refused::Endless.to_string()));
        });
    }

    /// `/proc` as a test sets it out: one table line per connection, each caller's socket held by
    /// a process of its own; the first pass waits until `open`.
    struct View {
        lines: Vec<String>,
        holders: Vec<(i32, u64)>,
        /// What a holder's descriptor reads once its line has been read, if not its socket.
        moved: Option<i32>,
        passes: AtomicUsize,
        open: (Mutex<bool>, Condvar),
    }

    impl View {
        /// Callers from ports 1000, 1001, … to the daemon's 7900, each held by pid 900 + its index.
        fn of(callers: usize) -> Self {
            Self {
                lines: (0..callers)
                    .map(|at| {
                        format!(
                            "{at:4}: 0100007F:{:04X} 0100007F:1EDC 01 00000000:00000000 \
                             00:00000000 00000000  1000        0 {} 1 0000000000000000 20 0 0 \
                             10 -1",
                            1000 + at,
                            70 + at
                        )
                    })
                    .collect(),
                holders: (0..callers)
                    .map(|at| (900 + i32::try_from(at).unwrap(), 70 + at as u64))
                    .collect(),
                moved: None,
                passes: AtomicUsize::new(0),
                open: (Mutex::new(true), Condvar::new()),
            }
        }

        fn shut(self) -> Self {
            *self.open.0.lock().unwrap() = false;
            self
        }

        fn let_through(&self) {
            *self.open.0.lock().unwrap() = true;
            self.open.1.notify_all();
        }
    }

    impl ProcView for View {
        fn tables(&self) -> io::Result<Vec<String>> {
            Ok(vec![self.lines.join("\n"), String::new()])
        }
        fn processes(&self) -> io::Result<Vec<Pid>> {
            if self.passes.fetch_add(1, Ordering::SeqCst) == 0 {
                let open = self.open.0.lock().unwrap();
                let (_open, waited) = self
                    .open
                    .1
                    .wait_timeout_while(open, Duration::from_secs(10), |open| !*open)
                    .unwrap();
                assert!(!waited.timed_out(), "the first pass was never let through");
            }
            Ok(self.holders.iter().map(|(p, _)| pid(*p)).collect())
        }
        fn descriptors(&self, at: Pid) -> io::Result<Vec<(u32, Vec<u8>)>> {
            let (_, inode) = self.holders.iter().find(|(p, _)| pid(*p) == at).unwrap();
            Ok(vec![(3, format!("socket:[{inode}]").into_bytes())])
        }
        fn descriptor(&self, at: Pid, fd: u32) -> io::Result<Vec<u8>> {
            if self.moved == Some(at.as_raw_pid()) {
                return Ok(b"socket:[1]".to_vec());
            }
            Ok(self
                .descriptors(at)?
                .remove(usize::try_from(fd).unwrap() - 3)
                .1)
        }
    }

    /// Readers of TCP callers through `view`, each holder read as a line under `AGENT`'s pane
    /// when it is pid 900, else outside every terminal.
    fn tcp_readers(view: View) -> (Peers, Arc<Tcp>) {
        let tcp = Arc::new(Tcp::new(Arc::new(view), 1000, |at, _| {
            Ok(if at.as_raw_pid() == 900 {
                chain(900, 900, &[100, 10, 1])
            } else {
                chain(at.as_raw_pid(), at.as_raw_pid(), &[1])
            })
        }));
        let peers =
            Peers::with(READ, |_, _| Err(Refused::Endless)).with_tcp(Some(Arc::clone(&tcp)));
        (peers, tcp)
    }

    /// Once `done`, or 5 s on, letting every other task run meanwhile.
    async fn until(done: impl Fn() -> bool) {
        let by = std::time::Instant::now() + Duration::from_secs(5);
        while !done() && std::time::Instant::now() < by {
            tokio::task::yield_now().await;
        }
    }

    fn from_port(port: u16) -> PeerSocket {
        PeerSocket::tcp_accepted_now(
            Ok(SocketAddr::from(([127, 0, 0, 1], port))),
            Ok(SocketAddr::from(([127, 0, 0, 1], 7900))),
        )
    }

    #[test]
    fn reads_a_tcp_caller_as_the_processes_holding_its_socket() {
        let (peers, _) = tcp_readers(View::of(2));
        runtime().block_on(async {
            assert_eq!(
                [
                    peers.read(&from_port(1000)).await,
                    peers.read(&from_port(1001)).await
                ],
                [
                    PeerRead::Held(vec![chain(900, 900, &[100, 10, 1])]),
                    PeerRead::Held(vec![chain(901, 901, &[1])]),
                ]
            );
        });
    }

    #[test]
    fn finds_the_holders_of_tcp_callers_that_wait_together_in_one_pass() {
        let view = Arc::new(View::of(3).shut());
        let tcp = Arc::new(Tcp::new(Arc::clone(&view) as Arc<View>, 1000, |at, _| {
            Ok(chain(at.as_raw_pid(), 0, &[1]))
        }));
        let peers =
            Peers::with(READ, |_, _| Err(Refused::Endless)).with_tcp(Some(Arc::clone(&tcp)));
        let reads = runtime().block_on(async {
            let sockets = [1000, 1001, 1002].map(from_port);
            let later = async {
                until(|| view.passes.load(Ordering::SeqCst) == 1).await;
                let let_through = async {
                    until(|| tcp.waiting() == 2).await;
                    view.let_through();
                };
                let (b, c, ()) = tokio::join!(
                    peers.read(&sockets[1]),
                    peers.read(&sockets[2]),
                    let_through
                );
                (b, c)
            };
            let (a, (b, c)) = tokio::join!(peers.read(&sockets[0]), later);
            [a, b, c]
        });
        assert_eq!(
            (reads, view.passes.load(Ordering::SeqCst)),
            (
                [900, 901, 902].map(|at| PeerRead::Held(vec![chain(at, 0, &[1])])),
                2
            )
        );
    }

    #[test]
    fn refuses_every_tcp_caller_where_proc_cant_say_who_holds_a_socket() {
        let peers = Peers::with(READ, |_, _| Err(Refused::Endless)).with_tcp(None);
        assert_eq!(
            runtime().block_on(peers.read(&from_port(1000))),
            PeerRead::Unread(UNIDENTIFIABLE.to_owned())
        );
    }

    #[test]
    fn tells_a_caller_that_changed_while_it_was_read_to_try_again() {
        let (peer, _theirs) = socket();
        let changing = Peers::with(READ, |_, _| Err(Refused::Changed("it moved")));
        let (moving, _) = tcp_readers(View {
            moved: Some(900),
            ..View::of(1)
        });
        let reads = runtime().block_on(async {
            [
                changing.read(&peer).await,
                moving.read(&from_port(1000)).await,
            ]
        });
        assert_eq!(
            (
                reads.clone(),
                reads.map(|read| reading(read, || Ok::<_, ()>(terminals())))
            ),
            (
                [
                    PeerRead::Retry(Refused::Changed("it moved").to_string()),
                    PeerRead::Retry(Refused::HolderChanged.to_string()),
                ],
                [Ok(Reading::Late), Ok(Reading::Late)]
            )
        );
    }

    #[test]
    fn reads_a_tcp_caller_as_its_holders_say_only_when_they_all_agree() {
        let under = |at: i32| chain(at, at, &[100, 10, 1]);
        let held = |peers: Vec<Peer>| reading(PeerRead::Held(peers), || Ok::<_, ()>(terminals()));
        assert_eq!(
            [
                held(vec![under(150), under(151)]),
                held(vec![under(150), chain(950, 950, &[1])]),
                held(vec![]),
            ],
            [
                Ok(agent(150, By::Ancestry)),
                Ok(Reading::Refused(
                    "the processes holding the caller's socket read as different callers"
                        .to_owned()
                )),
                Ok(Reading::Refused(
                    "no process holds the caller's socket".to_owned()
                )),
            ]
        );
    }

    #[test]
    fn says_why_it_read_nobody_when_a_reading_refuses_or_panics_or_the_socket_wasnt_kept() {
        let (peer, _theirs) = socket();
        let refusing = Peers::with(READ, |_, _| Err(Refused::Foreign { uid: 7 }));
        let panicking = Peers::with(READ, |_, _| panic!("lost"));
        let unkept = PeerSocket {
            end: End::Unreadable("no descriptor".to_owned()),
            accepted: 0,
        };
        runtime().block_on(async {
            assert_eq!(
                [
                    refusing.read(&peer).await,
                    panicking.read(&peer).await,
                    refusing.read(&unkept).await,
                ],
                [
                    PeerRead::Unread("the caller runs as uid 7, another user".into()),
                    PeerRead::Unread("the reader panicked".into()),
                    PeerRead::Unread("no descriptor".into()),
                ]
            );
        });
    }

    #[test]
    fn reads_this_process_at_the_other_end_of_its_own_socket_pair() {
        let (peer, _theirs) = socket();
        let read = runtime().block_on(Peers::default().read(&peer));
        let PeerRead::Read(read) = read else {
            panic!("{read:?}");
        };
        assert_eq!(
            [read.pid, read.ancestors[0]],
            [
                rustix::process::getpid(),
                rustix::process::getppid().unwrap()
            ]
        );
    }
}
