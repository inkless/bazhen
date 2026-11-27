//! The channel to one harness's server, made again whenever it ends for as long as any agent is
//! bound: nothing announces a server's restart or update, and only a client that picked up a
//! session hears its approvals. Where nothing listens, the harness's own command starts the server;
//! the daemon never runs one of its own.
//!
//! One task drives the connections: it dials, says the [`Session::handshake`], forwards what the
//! server sends to the daemon's queue, picks up every bound session ([`Session::connected`]), and
//! tells of the connection ending. Forwarding never waits on the server, nor on the session: a
//! message that comes while the bound sessions are picked up is in the queue at once, as the
//! TypeScript daemon handled its listener's messages during the resumes, but for one that comes
//! between a reply and the pickup's next step, which waits for that step so the pickup's facts
//! land where its last reply did (`Driver::serve`).

use std::fmt;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use bazhen_harness::{
    Bound, BoxFuture, ChannelError, ChannelErrorKind, ChannelPort, Keyed, RunPort, Session,
};
use futures_util::FutureExt as _;
use serde_json::Value;
use tokio::sync::{Mutex, MutexGuard, Notify, mpsc, oneshot, watch};
use tokio::task::coop::unconstrained;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

use super::rpc::{self, Heard, Inbound, Progress, Rpc};

/// The first wait before connecting again after a connection ends or fails.
pub const FIRST_RETRY: Duration = Duration::from_secs(1);
/// The longest wait before connecting again: it doubles up to this.
const MAX_RETRY: Duration = Duration::from_secs(60);
/// A connection that lasted this long was a good one: the wait starts again from the first.
const STABLE: Duration = Duration::from_secs(30);
/// How long the harness's command to start its server may take.
pub const START_TIMEOUT: Duration = Duration::from_secs(60);
/// How many servers a request is tried on when each is draining as it arrives.
const DRAINING_ATTEMPTS: u32 = 3;

/// The wait before the connection after next, after one that failed, or that lived `lived`: it
/// doubles up to a minute, so a server that accepts and drops at once isn't dialled every second,
/// and starts again from `first` after a connection that held.
fn next_delay(current: Duration, lived: Option<Duration>, first: Duration) -> Duration {
    match lived {
        Some(lived) if lived >= STABLE => first,
        _ => (current * 2).min(MAX_RETRY),
    }
}

/// What the channel tells the daemon, in the order it happened.
#[derive(Debug)]
pub enum Event {
    /// The server's own request or notification, and the connection to answer a request on.
    Inbound { message: Inbound, on: Rpc },
    /// A connection's handshake named the server's version, none when it named none.
    Version(Option<String>),
    /// A connection picked up every bound session, and is still up: what holds of them. A
    /// connection that ended meanwhile tells nothing, as what it held may come again on the next.
    Connected(Vec<Keyed>),
    /// A connection that passed its handshake ended.
    Disconnected(Vec<Keyed>),
}

/// What the channel needs of the daemon.
pub struct Options {
    pub session: Box<dyn Session>,
    /// The agents bound to the harness's sessions, each picked up on every new connection.
    pub bound: Box<dyn Fn() -> Vec<Bound> + Send + Sync>,
    pub run: Arc<dyn RunPort>,
    /// The daemon's queue, which the channel waits on when it is full.
    pub events: mpsc::Sender<Event>,
    /// The first wait before connecting again, [`FIRST_RETRY`] but in tests.
    pub first_retry: Duration,
}

/// The connection that is up, and the last failure to make one.
#[derive(Debug, Clone, Default)]
struct Link {
    up: Option<Rpc>,
    failures: u64,
    failed: Option<ChannelError>,
}

struct Shared {
    session: Mutex<Box<dyn Session>>,
    bound: Box<dyn Fn() -> Vec<Bound> + Send + Sync>,
    link: watch::Sender<Link>,
    /// A request, or an agent newly bound, wants a connection now.
    wanted: Notify,
    stop: CancellationToken,
}

/// A handle to the channel. It connects on first use, or at once when an agent is bound, and ends
/// when its stop token is cancelled.
#[derive(Clone)]
pub struct Channel {
    shared: Arc<Shared>,
}

/// The session, held from the channel's own task, and the connection that was up when it was
/// taken. Nothing said under it may go through [`Channel`]: a connection made again waits on it.
pub struct Locked<'a> {
    session: MutexGuard<'a, Box<dyn Session>>,
    on: Option<Rpc>,
}

impl Locked<'_> {
    /// The session, and the connection it was up on, if one was.
    pub fn parts(&mut self) -> (&mut dyn Session, Option<&dyn ChannelPort>) {
        (
            &mut **self.session,
            self.on.as_ref().map(|on| on as &dyn ChannelPort),
        )
    }
}

impl fmt::Debug for Options {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Options")
            .field("first_retry", &self.first_retry)
            .finish_non_exhaustive()
    }
}

impl fmt::Debug for Channel {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Channel")
            .field("link", &*self.shared.link.borrow())
            .finish_non_exhaustive()
    }
}

impl fmt::Debug for Locked<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Locked")
            .field("on", &self.on)
            .finish_non_exhaustive()
    }
}

fn closed() -> ChannelError {
    ChannelError {
        kind: ChannelErrorKind::Failed,
        message: "the daemon is stopping".to_owned(),
    }
}

impl Channel {
    /// Starts the channel's task under `tasks`. It connects at once if any agent is bound.
    pub fn start(options: Options, tasks: &TaskTracker, stop: CancellationToken) -> Self {
        let endpoint = options.session.endpoint();
        let shared = Arc::new(Shared {
            session: Mutex::new(options.session),
            bound: options.bound,
            link: watch::Sender::new(Link::default()),
            wanted: Notify::new(),
            stop,
        });
        let driver = Driver {
            shared: Arc::clone(&shared),
            socket: PathBuf::from(endpoint.address),
            start: endpoint.start,
            run: options.run,
            events: options.events,
            first: options.first_retry,
            tasks: tasks.clone(),
        };
        tasks.spawn(driver.drive());
        Self { shared }
    }

    /// Connects now if any agent is bound and no connection is up, so its approvals reach the
    /// inbox without waiting for a request.
    pub fn keep_connected(&self) {
        let up = self.shared.link.borrow().up.as_ref().is_some_and(Rpc::open);
        if !up && !(self.shared.bound)().is_empty() {
            self.shared.wanted.notify_one();
        }
    }

    /// Whether a connection is up.
    #[cfg(test)]
    pub(crate) fn up(&self) -> bool {
        self.shared.link.borrow().up.as_ref().is_some_and(Rpc::open)
    }

    /// The session, once the channel's task isn't using it, and the connection up then. While it
    /// is held the channel can neither pick up the bound sessions on a new connection nor tell of
    /// one that ended, so never call [`Channel::request`] or [`Channel::notify`] while holding
    /// it: they wait on a connection only that task can make. Use the one [`Locked::parts`] gives.
    pub async fn locked(&self) -> Locked<'_> {
        let session = self.shared.session.lock().await;
        let on = self.shared.link.borrow().up.clone();
        Locked { session, on }
    }

    /// One request's result. A server draining before it exits refuses new work, so the request
    /// waits for that server to go and is sent to the next one, up to three.
    ///
    /// # Errors
    ///
    /// No connection could be made, or the request's own, as [`Rpc::request`] fails it.
    pub async fn request(&self, method: &str, params: Value) -> Result<Value, ChannelError> {
        let mut attempt = 1;
        loop {
            let on = self.connected().await?;
            match on.request(method, params.clone()).await {
                Err(error) if error.draining() && attempt < DRAINING_ATTEMPTS => {
                    self.ended(&on).await;
                    attempt += 1;
                }
                outcome => return Ok(outcome?),
            }
        }
    }

    /// One notification.
    ///
    /// # Errors
    ///
    /// No connection could be made, or it ended.
    pub async fn notify(&self, method: &str, params: Value) -> Result<(), ChannelError> {
        Ok(self.connected().await?.notify(method, params)?)
    }

    /// The connection that is up, or the next one made, which a connection that can't be made
    /// fails.
    async fn connected(&self) -> Result<Rpc, ChannelError> {
        let mut link = self.shared.link.subscribe();
        let failures = link.borrow().failures;
        loop {
            {
                let now = link.borrow_and_update();
                if let Some(up) = now.up.as_ref().filter(|up| up.open()) {
                    return Ok(up.clone());
                }
                if now.failures > failures {
                    return Err(now.failed.clone().unwrap_or_else(closed));
                }
            }
            if self.shared.stop.is_cancelled() {
                return Err(closed());
            }
            // Asked again on every change that shows none up: a connection that came and went
            // before this request looked took its ask with it, and with no agent bound nothing
            // else would make the next.
            self.shared.wanted.notify_one();
            if link.changed().await.is_err() {
                return Err(closed());
            }
        }
    }

    /// Once `on` has ended, which the channel's task tells as it lets the connection go, or a
    /// request's timeout has passed, for a draining server that holds its connections.
    async fn ended(&self, on: &Rpc) {
        let mut link = self.shared.link.subscribe();
        // The sender lives as long as this handle does; a server still there is asked again.
        let _ = tokio::time::timeout(rpc::REQUEST_TIMEOUT, link.wait_for(|_| !on.open())).await;
    }
}

impl ChannelPort for Channel {
    fn request<'a>(
        &'a self,
        method: &'a str,
        params: Value,
    ) -> BoxFuture<'a, Result<Value, ChannelError>> {
        Box::pin(Self::request(self, method, params))
    }

    fn notify<'a>(
        &'a self,
        method: &'a str,
        params: Value,
    ) -> BoxFuture<'a, Result<(), ChannelError>> {
        Box::pin(Self::notify(self, method, params))
    }
}

/// Whether a message that came at `at` came after one of the pickup's replies while none of its
/// requests waited, the requests sent before the pickup's own numbering `before`: whether it
/// came before the pickup's last reply hangs on the pickup's next step.
fn between(at: Progress, before: u64) -> bool {
    at.sent > before && at.waiting == 0
}

/// The channel's task.
struct Driver {
    shared: Arc<Shared>,
    socket: PathBuf,
    start: Vec<String>,
    run: Arc<dyn RunPort>,
    events: mpsc::Sender<Event>,
    first: Duration,
    tasks: TaskTracker,
}

impl Driver {
    async fn drive(self) {
        let stop = self.shared.stop.clone();
        let mut retry = self.first;
        let mut wait = Duration::ZERO;
        loop {
            let bound = !(self.shared.bound)().is_empty();
            tokio::select! {
                biased;
                () = stop.cancelled() => break,
                () = self.shared.wanted.notified() => {}
                () = tokio::time::sleep(wait), if bound => {}
            }
            let opened = tokio::select! {
                biased;
                () = stop.cancelled() => break,
                opened = self.open() => opened,
            };
            let lived = match opened {
                Ok((on, inbox, ending)) => Some(self.serve(on, inbox, ending).await.elapsed()),
                Err(error) => {
                    tracing::warn!(
                        "bazhen: can't connect to {}: {}",
                        self.socket.display(),
                        error.message
                    );
                    // What asked while it was tried is told of the failure: the next try waits.
                    let _ = self.shared.wanted.notified().now_or_never();
                    self.shared.link.send_modify(|link| {
                        link.failures += 1;
                        link.failed = Some(error);
                    });
                    None
                }
            };
            wait = retry;
            retry = next_delay(retry, lived, self.first);
        }
        self.shared.link.send_modify(|link| {
            link.up = None;
            link.failures += 1;
            link.failed = Some(closed());
        });
    }

    /// A connection that passed its handshake, starting the server first where nothing listens.
    async fn open(&self) -> Result<(Rpc, rpc::Inbox, CancellationToken), ChannelError> {
        let ending = self.shared.stop.child_token();
        let (on, inbox) = match rpc::connect(&self.socket, &self.tasks, ending.clone()).await {
            Err(error) if error.absent => {
                self.start_server().await?;
                rpc::connect(&self.socket, &self.tasks, ending.clone()).await?
            }
            connected => connected?,
        };
        // A handshake that fails drops the connection's every handle, which ends it.
        let version = self.shared.session.lock().await.handshake(&on).await?;
        self.tell(Event::Version(version)).await;
        Ok((on, inbox, ending))
    }

    /// Tells the daemon `event`, unless the channel stops first; false when it did, or when
    /// nobody reads the queue any more.
    async fn tell(&self, event: Event) -> bool {
        tokio::select! {
            biased;
            () = self.shared.stop.cancelled() => false,
            sent = self.events.send(event) => sent.is_ok(),
        }
    }

    async fn start_server(&self) -> Result<(), ChannelError> {
        let failed = |why: &str| ChannelError {
            kind: ChannelErrorKind::Failed,
            message: format!("`{}` didn't start the server: {why}", self.start.join(" ")),
        };
        let output = self
            .run
            .run(&self.start, START_TIMEOUT)
            .await
            .map_err(|error| failed(&error.message))?;
        let why = match (output.code, output.stderr.trim()) {
            (Some(0), _) => return Ok(()),
            (_, stderr) if !stderr.is_empty() => stderr.to_owned(),
            (Some(code), _) => format!("it exited {code}"),
            (None, _) => "a signal ended it".to_owned(),
        };
        Err(failed(&why))
    }

    /// Until the connection ends: forwards what the server sends while the bound sessions are
    /// picked up, then tells of the end. When they were picked up, from which the connection
    /// counts as held, as the TypeScript daemon counted it.
    ///
    /// `Connected` falls where the pickup's last reply did among what the server sent: after
    /// everything before it, a resumed session's requests asked again among them, and before
    /// everything after it, which is newer than the facts the reply gave. The reader queues each
    /// message in the order it came, with how far the requests had got then, and a reply skips
    /// the queue, so what came before the reply is already queued once the pickup has it. A
    /// message that came after a reply while no request waited, once the pickup had asked one,
    /// waits until the pickup asks another, which puts it before that one's reply, or ends,
    /// which puts it after `Connected`. Nothing else waits: the pickup's next step after a reply
    /// is to ask again or end, so it waits on neither the server nor the session.
    async fn serve(&self, on: Rpc, mut inbox: rpc::Inbox, ending: CancellationToken) -> Instant {
        let mut progress = on.progress();
        // What was sent before the pickup asked anything: the handshake.
        let before = progress.borrow().sent;
        let (picked, mut connected) = oneshot::channel();
        let forward = async {
            let mut waiting = true;
            // The message that waits, and everything queued behind it.
            let mut held: Option<Heard> = None;
            loop {
                // The requests sent when the held message came.
                let then = held.as_ref().map_or(u64::MAX, |heard| heard.at.sent);
                let told = tokio::select! {
                    // The pickup first, which comes once, so where Connected falls among what
                    // the server sends after it is fixed by what arrived, not by a random pick.
                    biased;
                    picked = &mut connected, if waiting => {
                        waiting = false;
                        match picked {
                            Ok((facts, last)) => {
                                self.tell_connected(&on, &mut inbox, &mut held, facts, before, last)
                                    .await
                            }
                            // The connection ended while they were picked up.
                            Err(_) => match held.take() {
                                Some(heard) => self.tell_heard(&on, heard).await,
                                None => true,
                            },
                        }
                    }
                    // The pickup asked again, so the held message came before that reply.
                    () = progress.wait_for(|now| now.sent > then).map(drop), if held.is_some() => {
                        match held.take() {
                            Some(heard) => self.tell_heard(&on, heard).await,
                            None => true,
                        }
                    }
                    heard = inbox.next(), if held.is_none() => match heard {
                        Some(heard) if waiting && between(heard.at, before) => {
                            held = Some(heard);
                            true
                        }
                        Some(heard) => self.tell_heard(&on, heard).await,
                        None => break,
                    },
                };
                if !told {
                    // Nobody reads what the server says any more, or the channel stopped.
                    ending.cancel();
                }
            }
        };
        let resume = async {
            let bound = (self.shared.bound)();
            let mut session = self.shared.session.lock().await;
            let facts = session.connected(&on, &bound).await;
            // The replies read by the last of the pickup's, as no request of its own waits now
            // and none other is sent before the connection is up.
            let last = on.progress().borrow().read;
            let picked_up = Instant::now();
            if !on.open() {
                return picked_up;
            }
            self.shared
                .link
                .send_modify(|link| link.up = Some(on.clone()));
            // A request that asked for a connection while this one was made has it.
            let _ = self.shared.wanted.notified().now_or_never();
            drop(session);
            let _ = picked.send((facts, last));
            picked_up
        };
        let ((), picked_up) = tokio::join!(forward, resume);
        let facts = {
            let mut session = self.shared.session.lock().await;
            self.shared.link.send_modify(|link| link.up = None);
            session.disconnected()
        };
        self.tell(Event::Disconnected(facts)).await;
        picked_up
    }

    /// Tells one message of the server's own; false when it couldn't be told.
    async fn tell_heard(&self, on: &Rpc, heard: Heard) -> bool {
        let on = on.clone();
        self.tell(Event::Inbound {
            message: heard.message,
            on,
        })
        .await
    }

    /// Tells what the server sent before the pickup's last reply, the `last`th read, or before
    /// the pickup asked anything, the requests sent then numbering `before`, that is still
    /// queued, then that the connection is up with `facts`, then the message `held` waiting, or
    /// the first queued after the reply; false when one of the server's messages couldn't be
    /// told.
    async fn tell_connected(
        &self,
        on: &Rpc,
        inbox: &mut rpc::Inbox,
        held: &mut Option<Heard>,
        facts: Vec<Keyed>,
        before: u64,
        last: u64,
    ) -> bool {
        // A message held came after the last reply: none was read after it, as none was asked.
        if held.is_none() {
            // Out of the task's coop budget, a receive would say there is nothing though there is.
            while let Some(Some(heard)) = unconstrained(inbox.next()).now_or_never() {
                if heard.at.sent > before && heard.at.read >= last {
                    *held = Some(heard);
                    break;
                }
                if !self.tell_heard(on, heard).await {
                    return false;
                }
            }
        }
        self.tell(Event::Connected(facts)).await;
        match held.take() {
            Some(heard) => self.tell_heard(on, heard).await,
            None => true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rpc::RequestId;
    use crate::testing::{Server, TempDir, accepted, heard, paused, say, within};
    use bazhen_harness::{
        AgentId, Endpoint, Followed, Gate, Key, LaunchRequest, Observed, Output, Reloaded,
        RunError, SessionKey,
    };
    use bazhen_protocol::agents::{ExternalRef, ExternalRefKind};
    use bazhen_protocol::ids::EnvironmentId;
    use futures_util::StreamExt as _;
    use serde_json::json;
    use std::collections::VecDeque;
    use tokio::net::UnixListener;
    use tokio_tungstenite::tungstenite::Message;

    /// Long enough for any test in paused time, where waiting costs nothing.
    const LIMIT: Duration = Duration::from_secs(3600);
    /// For one step that comes at once or never, as `bounded` gives a whole test: a step that never
    /// comes fails at the test's own line, saying what didn't happen.
    const PROMPTLY: Duration = Duration::from_secs(5);
    const START: [&str; 2] = ["serve", "--start"];

    /// A harness's session as the channel drives it: `initialize` names the version, and each
    /// bound session is picked up with a `resume`.
    struct Fake {
        socket: String,
    }

    impl Session for Fake {
        fn endpoint(&self) -> Endpoint {
            Endpoint {
                address: self.socket.clone(),
                start: START.map(str::to_owned).to_vec(),
            }
        }

        fn handshake<'a>(
            &'a mut self,
            channel: &'a dyn ChannelPort,
        ) -> BoxFuture<'a, Result<Option<String>, ChannelError>> {
            Box::pin(async move {
                let answer = channel.request("initialize", json!({})).await?;
                Ok(answer["version"].as_str().map(str::to_owned))
            })
        }

        fn connected<'a>(
            &'a mut self,
            channel: &'a dyn ChannelPort,
            bound: &'a [Bound],
        ) -> BoxFuture<'a, Vec<Keyed>> {
            Box::pin(async move {
                let mut facts = Vec::new();
                for agent in bound {
                    let id = &agent.session.id;
                    let params = json!({ "session": id });
                    if channel.request("resume", params).await.is_ok() {
                        facts.push(resumed(id));
                    }
                }
                facts
            })
        }

        fn reload<'a>(
            &'a mut self,
            _agent: &'a Bound,
            _channel: &'a dyn ChannelPort,
        ) -> BoxFuture<'a, Reloaded> {
            Box::pin(async { Reloaded::NotYet })
        }

        fn disconnected(&mut self) -> Vec<Keyed> {
            vec![ended()]
        }

        fn follow<'a>(
            &'a mut self,
            _agent: &'a Bound,
            _candidate: &'a str,
            _channel: &'a dyn ChannelPort,
        ) -> BoxFuture<'a, Followed> {
            Box::pin(async { Followed::Pending })
        }

        fn may_follow_to(&self, _candidate: &str, _announced: &SessionKey) -> bool {
            false
        }
    }

    fn resumed(id: &str) -> Keyed {
        Keyed {
            key: Key::Session(SessionKey(id.to_owned())),
            gate: Gate::None,
            fact: Observed::Resumed,
        }
    }

    /// What the fake session says when a connection ends, to tell it from the rest.
    fn ended() -> Keyed {
        Keyed {
            key: Key::Account,
            gate: Gate::None,
            fact: Observed::Resumed,
        }
    }

    fn bound(id: &str) -> Bound {
        Bound {
            agent: AgentId::parse("agent_0190a1b2c3d47abc8def0123456789a1").unwrap(),
            session: ExternalRef {
                environment_id: EnvironmentId::parse("env_0190a1b2c3d47abc8def0123456789ab")
                    .unwrap(),
                kind: ExternalRefKind::CodexThread,
                id: id.to_owned(),
            },
            launch: LaunchRequest::default(),
        }
    }

    type Then = dyn Fn() -> Result<Output, RunError> + Send + Sync;

    /// The command that starts the server: it records each run, and ends as `then` says.
    struct Starts {
        ran: std::sync::Mutex<Vec<(Vec<String>, Duration, Instant)>>,
        then: Box<Then>,
    }

    impl RunPort for Starts {
        fn run<'a>(
            &'a self,
            argv: &'a [String],
            timeout: Duration,
        ) -> BoxFuture<'a, Result<Output, RunError>> {
            let mut ran = self.ran.lock().unwrap();
            ran.push((argv.to_vec(), timeout, Instant::now()));
            let outcome = (self.then)();
            Box::pin(async move { outcome })
        }
    }

    fn exited(code: Option<i32>, stderr: &str) -> Output {
        Output {
            code,
            stdout: String::new(),
            stderr: stderr.to_owned(),
        }
    }

    fn never_started() -> Box<Then> {
        Box::new(|| {
            Err(RunError {
                message: "no such command".to_owned(),
            })
        })
    }

    /// What the channel told the daemon, with the connection an inbound message came on left out.
    #[derive(Debug, PartialEq)]
    enum Told {
        Inbound(Inbound),
        Version(Option<String>),
        Connected(Vec<Keyed>),
        Disconnected(Vec<Keyed>),
    }

    struct Rig {
        channel: Channel,
        events: mpsc::Receiver<Event>,
        starts: Arc<Starts>,
        stop: CancellationToken,
        tasks: TaskTracker,
    }

    impl Rig {
        async fn next(&mut self) -> Event {
            self.events.recv().await.unwrap()
        }

        async fn told(&mut self) -> Told {
            match self.next().await {
                Event::Inbound { message, .. } => Told::Inbound(message),
                Event::Version(version) => Told::Version(version),
                Event::Connected(facts) => Told::Connected(facts),
                Event::Disconnected(facts) => Told::Disconnected(facts),
            }
        }

        fn ran(&self) -> Vec<(Vec<String>, Duration)> {
            let ran = self.starts.ran.lock().unwrap();
            ran.iter().map(|(argv, t, _)| (argv.clone(), *t)).collect()
        }
    }

    fn socket(dir: &TempDir) -> std::path::PathBuf {
        dir.path().join("server.sock")
    }

    /// A channel to the server at `dir`'s socket, which waits a second before connecting again.
    fn rig(dir: &TempDir, bound: Vec<Bound>, then: Box<Then>) -> Rig {
        rig_with(dir, bound, then, 64)
    }

    /// The same, with room in the daemon's queue for `capacity` events.
    fn rig_with(dir: &TempDir, bound: Vec<Bound>, then: Box<Then>, capacity: usize) -> Rig {
        let (sender, events) = mpsc::channel(capacity);
        let starts = Arc::new(Starts {
            ran: std::sync::Mutex::default(),
            then,
        });
        let stop = CancellationToken::new();
        let tasks = TaskTracker::new();
        let options = Options {
            session: Box::new(Fake {
                socket: socket(dir).display().to_string(),
            }),
            bound: Box::new(move || bound.clone()),
            run: Arc::clone(&starts) as Arc<dyn RunPort>,
            events: sender,
            first_retry: FIRST_RETRY,
        };
        let channel = Channel::start(options, &tasks, stop.clone());
        Rig {
            channel,
            events,
            starts,
            stop,
            tasks,
        }
    }

    /// Answers the next request, which must be `method`, with `outcome`; its params.
    async fn reply(server: &mut Server, method: &str, outcome: Value) -> Value {
        let request = heard(server).await;
        assert_eq!(request["method"], json!(method), "{request}");
        let mut answer = outcome;
        answer["id"] = request["id"].clone();
        say(server, answer).await;
        request["params"].clone()
    }

    async fn answer(server: &mut Server, method: &str, result: Value) -> Value {
        reply(server, method, json!({ "result": result })).await
    }

    async fn handshake(server: &mut Server, version: Option<&str>) {
        let named = version.map_or_else(|| json!({}), |v| json!({ "version": v }));
        answer(server, "initialize", named).await;
    }

    /// Whether the client ended the connection.
    async fn ends(server: &mut Server) -> bool {
        loop {
            match server.next().await {
                None | Some(Err(_) | Ok(Message::Close(_))) => return true,
                Some(Ok(Message::Text(_))) => return false,
                Some(Ok(_)) => {}
            }
        }
    }

    fn draining() -> Value {
        json!({ "error": { "code": -32600, "message": "Server is draining",
            "data": { "reason": "serverShuttingDown" } } })
    }

    fn listen(dir: &TempDir) -> UnixListener {
        UnixListener::bind(socket(dir)).unwrap()
    }

    #[test]
    fn waits_twice_as_long_after_each_failure_up_to_a_minute_and_starts_again_after_a_held_connection()
     {
        let first = Duration::from_secs(1);
        let mut wait = first;
        let mut waits = vec![wait];
        for _ in 0..8 {
            wait = next_delay(wait, None, first);
            waits.push(wait);
        }
        let secs: Vec<u64> = waits.iter().map(Duration::as_secs).collect();
        assert_eq!(secs, [1, 2, 4, 8, 16, 32, 60, 60, 60]);
        let four = Duration::from_secs(4);
        let dropped_at_once = next_delay(four, Some(Duration::from_millis(200)), first);
        let held = next_delay(four, Some(STABLE), first);
        let just_short = next_delay(four, Some(Duration::from_millis(29_999)), first);
        assert_eq!(
            [dropped_at_once, held, just_short],
            [Duration::from_secs(8), first, Duration::from_secs(8)]
        );
    }

    #[test]
    fn starts_the_server_where_nothing_listens_then_connects_to_it() {
        let dir = TempDir::new("channel-start");
        paused().block_on(within(LIMIT, async {
            let (sender, mut started) = mpsc::unbounded_channel();
            let path = socket(&dir);
            let then: Box<Then> = Box::new(move || {
                let listener = std::os::unix::net::UnixListener::bind(&path).unwrap();
                listener.set_nonblocking(true).unwrap();
                sender.send(listener).unwrap();
                Ok(exited(Some(0), ""))
            });
            let mut rig = rig(&dir, vec![], then);
            let server = async {
                let listener = UnixListener::from_std(started.recv().await.unwrap()).unwrap();
                let mut server = accepted(&listener).await;
                handshake(&mut server, Some("1.0")).await;
                answer(&mut server, "work", json!("ok")).await;
                server
            };
            let (done, _server) = tokio::join!(rig.channel.request("work", json!({})), server);
            assert_eq!(done, Ok(json!("ok")));
            let start = START.map(str::to_owned).to_vec();
            assert_eq!(rig.ran(), [(start, START_TIMEOUT)]);
            assert_eq!(rig.told().await, Told::Version(Some("1.0".to_owned())));
            assert_eq!(rig.told().await, Told::Connected(vec![]));
        }));
    }

    #[test]
    fn fails_a_request_with_why_the_server_couldnt_be_started() {
        let dir = TempDir::new("channel-unstarted");
        paused().block_on(within(LIMIT, async {
            let outcomes = std::sync::Mutex::new(VecDeque::from([
                Err(RunError {
                    message: "no such command".to_owned(),
                }),
                Ok(exited(Some(1), "  no home\n")),
                Ok(exited(Some(2), " ")),
                Ok(exited(None, "")),
            ]));
            let rig = rig(
                &dir,
                vec![],
                Box::new(move || outcomes.lock().unwrap().pop_front().unwrap()),
            );
            let mut why = Vec::new();
            for _ in 0..4 {
                let failed = rig.channel.request("work", json!({})).await.unwrap_err();
                assert_eq!(failed.kind, ChannelErrorKind::Failed);
                why.push(failed.message);
            }
            let said = "`serve --start` didn't start the server: ";
            assert_eq!(
                why,
                [
                    "no such command",
                    "no home",
                    "it exited 2",
                    "a signal ended it"
                ]
                .map(|why| format!("{said}{why}"))
            );
        }));
    }

    #[test]
    fn connects_again_on_the_next_request_after_the_connection_ends() {
        let dir = TempDir::new("channel-again");
        paused().block_on(within(LIMIT, async {
            let listener = listen(&dir);
            let mut rig = rig(&dir, vec![], never_started());
            let server = async {
                let mut server = accepted(&listener).await;
                handshake(&mut server, Some("1.0")).await;
                answer(&mut server, "work", json!("one")).await;
                server
            };
            let (first, mut server) = tokio::join!(rig.channel.request("work", json!({})), server);
            assert_eq!(first, Ok(json!("one")));
            assert_eq!(rig.told().await, Told::Version(Some("1.0".to_owned())));
            assert_eq!(rig.told().await, Told::Connected(vec![]));
            // The session is lent with the connection that is up, to say what it says alone.
            let mut locked = rig.channel.locked().await;
            locked
                .parts()
                .1
                .unwrap()
                .notify("ping", json!(1))
                .await
                .unwrap();
            drop(locked);
            assert_eq!(
                heard(&mut server).await,
                json!({ "method": "ping", "params": 1 })
            );
            drop(server);
            assert_eq!(rig.told().await, Told::Disconnected(vec![ended()]));
            assert!(rig.channel.locked().await.parts().1.is_none());
            let server = async {
                let mut server = accepted(&listener).await;
                handshake(&mut server, None).await;
                answer(&mut server, "work", json!("two")).await;
                server
            };
            let (second, _server) = tokio::join!(rig.channel.request("work", json!({})), server);
            assert_eq!(second, Ok(json!("two")));
            assert_eq!(rig.told().await, Told::Version(None));
            assert_eq!(rig.told().await, Told::Connected(vec![]));
        }));
    }

    #[test]
    fn picks_up_every_bound_session_again_by_itself_a_second_after_the_server_goes_away() {
        let dir = TempDir::new("channel-bound");
        paused().block_on(within(LIMIT, async {
            let listener = listen(&dir);
            let mut rig = rig(&dir, vec![bound("s1"), bound("s2")], never_started());
            let mut server = accepted(&listener).await;
            handshake(&mut server, Some("1.0")).await;
            for id in ["s1", "s2"] {
                let params = answer(&mut server, "resume", json!({})).await;
                assert_eq!(params, json!({ "session": id }));
            }
            assert_eq!(rig.told().await, Told::Version(Some("1.0".to_owned())));
            let both = vec![resumed("s1"), resumed("s2")];
            assert_eq!(rig.told().await, Told::Connected(both.clone()));
            // A connection is up: there is nothing to make now, nor sooner after it ends.
            rig.channel.keep_connected();
            drop(server);
            let dropped = Instant::now();
            assert_eq!(rig.told().await, Told::Disconnected(vec![ended()]));
            let mut server = accepted(&listener).await;
            assert_eq!(dropped.elapsed(), FIRST_RETRY);
            handshake(&mut server, Some("1.1")).await;
            assert_eq!(rig.told().await, Told::Version(Some("1.1".to_owned())));
            // What comes while the bound sessions are picked up reaches the daemon at once, and
            // is answered on its own connection.
            let resume = heard(&mut server).await;
            let asked = json!({ "id": 9, "method": "approve", "params": { "session": "s1" } });
            say(&mut server, asked).await;
            let Event::Inbound { message, on } = rig.next().await else {
                panic!("the server's request isn't the next thing told");
            };
            assert_eq!(
                message,
                Inbound::Request {
                    id: RequestId::Number(9.into()),
                    method: "approve".to_owned(),
                    params: Some(json!({ "session": "s1" })),
                }
            );
            on.respond(RequestId::Number(9.into()), json!("yes"));
            assert_eq!(
                heard(&mut server).await,
                json!({ "id": 9, "result": "yes" })
            );
            say(&mut server, json!({ "id": resume["id"], "result": {} })).await;
            answer(&mut server, "resume", json!({})).await;
            assert_eq!(rig.told().await, Told::Connected(both));
        }));
    }

    #[test]
    fn tells_what_the_server_sent_before_the_pickup_ended_ahead_of_connected() {
        let dir = TempDir::new("channel-order");
        paused().block_on(within(LIMIT, async {
            let listener = listen(&dir);
            // Room for one event, which the version holds until it is read, so each event after
            // it waits its turn, in the order the channel told it.
            let mut rig = rig_with(&dir, vec![bound("s1")], never_started(), 1);
            let mut server = accepted(&listener).await;
            handshake(&mut server, None).await;
            let resume = heard(&mut server).await;
            // A resumed session's requests, asked again before its resume is answered.
            for id in [9, 10] {
                let asked = json!({ "id": id, "method": "approve", "params": { "session": "s1" } });
                say(&mut server, asked).await;
            }
            say(&mut server, json!({ "id": resume["id"], "result": {} })).await;
            // Everything the channel can do before the daemon reads anything is done.
            tokio::time::sleep(Duration::from_millis(1)).await;
            let mut told = Vec::new();
            for _ in 0..4 {
                let next = tokio::time::timeout(PROMPTLY, rig.told()).await;
                told.push(next.expect("the channel told fewer than four events"));
            }
            let asked = |id: u64| {
                Told::Inbound(Inbound::Request {
                    id: RequestId::Number(id.into()),
                    method: "approve".to_owned(),
                    params: Some(json!({ "session": "s1" })),
                })
            };
            assert_eq!(
                told,
                [
                    Told::Version(None),
                    asked(9),
                    asked(10),
                    Told::Connected(vec![resumed("s1")]),
                ]
            );
        }));
    }

    #[test]
    fn tells_every_request_asked_again_ahead_of_connected_however_many() {
        const ASKED: u64 = 300;
        let dir = TempDir::new("channel-many");
        paused().block_on(within(LIMIT, async {
            let listener = listen(&dir);
            // Room for every event, so no tell waits: the task's coop budget, which a tell that
            // waits would renew, runs out partway through what is queued.
            let room = usize::try_from(ASKED).unwrap() + 2;
            let mut rig = rig_with(&dir, vec![bound("s1")], never_started(), room);
            let mut server = accepted(&listener).await;
            handshake(&mut server, None).await;
            let resume = heard(&mut server).await;
            for id in 0..ASKED {
                let asked = json!({ "id": id, "method": "approve", "params": { "session": "s1" } });
                say(&mut server, asked).await;
            }
            say(&mut server, json!({ "id": resume["id"], "result": {} })).await;
            tokio::time::sleep(Duration::from_millis(1)).await;
            let mut told = Vec::new();
            for _ in 0..ASKED + 2 {
                let next = tokio::time::timeout(PROMPTLY, rig.told()).await;
                told.push(next.expect("the channel told fewer events than the server sent"));
            }
            let at = told
                .iter()
                .position(|event| matches!(event, Told::Connected(_)));
            assert_eq!(
                at,
                Some(told.len() - 1),
                "Connected told before the last request"
            );
        }));
    }

    /// A notification of the server's own, to tell one message from another.
    fn note(n: u64) -> Value {
        json!({ "method": "note", "params": n })
    }

    fn noted(n: u64) -> Told {
        Told::Inbound(Inbound::Notification {
            method: "note".to_owned(),
            params: Some(json!(n)),
        })
    }

    #[test]
    fn tells_what_the_server_sent_after_the_pickup_ended_behind_connected() {
        let dir = TempDir::new("channel-after");
        paused().block_on(within(LIMIT, async {
            let listener = listen(&dir);
            let mut rig = rig(&dir, vec![bound("s1")], never_started());
            let mut server = accepted(&listener).await;
            handshake(&mut server, None).await;
            let resume = heard(&mut server).await;
            say(&mut server, note(1)).await;
            // The pickup's facts hold as of its reply: what the server says after it is newer.
            say(&mut server, json!({ "id": resume["id"], "result": {} })).await;
            say(&mut server, note(2)).await;
            say(&mut server, note(3)).await;
            tokio::time::sleep(Duration::from_millis(1)).await;
            let mut told = Vec::new();
            for _ in 0..5 {
                let next = tokio::time::timeout(PROMPTLY, rig.told()).await;
                told.push(next.expect("the channel told fewer than five events"));
            }
            assert_eq!(
                told,
                [
                    Told::Version(None),
                    noted(1),
                    Told::Connected(vec![resumed("s1")]),
                    noted(2),
                    noted(3),
                ]
            );
        }));
    }

    #[test]
    fn tells_what_the_server_sent_between_two_pickups_ahead_of_connected() {
        let dir = TempDir::new("channel-between");
        paused().block_on(within(LIMIT, async {
            let listener = listen(&dir);
            let mut rig = rig(&dir, vec![bound("s1"), bound("s2")], never_started());
            let mut server = accepted(&listener).await;
            handshake(&mut server, None).await;
            let first = heard(&mut server).await;
            // Sent before the second resume is asked, so it may come while none waits.
            say(&mut server, json!({ "id": first["id"], "result": {} })).await;
            say(&mut server, note(1)).await;
            answer(&mut server, "resume", json!({})).await;
            say(&mut server, note(2)).await;
            tokio::time::sleep(Duration::from_millis(1)).await;
            let mut told = Vec::new();
            for _ in 0..4 {
                let next = tokio::time::timeout(PROMPTLY, rig.told()).await;
                told.push(next.expect("the channel told fewer than four events"));
            }
            assert_eq!(
                told,
                [
                    Told::Version(None),
                    noted(1),
                    Told::Connected(vec![resumed("s1"), resumed("s2")]),
                    noted(2),
                ]
            );
        }));
    }

    #[test]
    fn tells_nothing_of_a_connection_that_ended_while_it_picked_up_the_bound_sessions() {
        let dir = TempDir::new("channel-mid-resume");
        paused().block_on(within(LIMIT, async {
            let listener = listen(&dir);
            let mut rig = rig(&dir, vec![bound("s1")], never_started());
            let mut server = accepted(&listener).await;
            handshake(&mut server, None).await;
            heard(&mut server).await;
            drop(server);
            assert_eq!(rig.told().await, Told::Version(None));
            assert_eq!(rig.told().await, Told::Disconnected(vec![ended()]));
            // And it is made again.
            let mut server = accepted(&listener).await;
            handshake(&mut server, None).await;
            assert_eq!(rig.told().await, Told::Version(None));
        }));
    }

    #[test]
    fn a_request_waiting_on_its_reply_holds_up_nothing_the_server_says() {
        let dir = TempDir::new("channel-inbox");
        paused().block_on(within(LIMIT, async {
            let listener = listen(&dir);
            let mut rig = rig(&dir, vec![], never_started());
            let channel = rig.channel.clone();
            let slow = rig
                .tasks
                .spawn(async move { channel.request("slow", json!({})).await });
            let mut server = accepted(&listener).await;
            handshake(&mut server, None).await;
            let asked = heard(&mut server).await;
            say(&mut server, json!({ "method": "note", "params": 1 })).await;
            assert_eq!(rig.told().await, Told::Version(None));
            assert_eq!(rig.told().await, Told::Connected(vec![]));
            let note = Inbound::Notification {
                method: "note".to_owned(),
                params: Some(json!(1)),
            };
            let told = tokio::time::timeout(PROMPTLY, rig.told())
                .await
                .expect("the server's note waits behind the request");
            assert_eq!(told, Told::Inbound(note));
            assert!(!slow.is_finished());
            say(&mut server, json!({ "id": asked["id"], "result": "late" })).await;
            assert_eq!(slow.await.unwrap(), Ok(json!("late")));
        }));
    }

    #[test]
    fn tries_again_while_an_agent_is_bound_waiting_twice_as_long_each_time() {
        let dir = TempDir::new("channel-backoff");
        paused().block_on(within(LIMIT, async {
            let began = Instant::now();
            let rig = rig(&dir, vec![bound("s1")], never_started());
            while rig.starts.ran.lock().unwrap().len() < 9 {
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            let ran = rig.starts.ran.lock().unwrap();
            let at: Vec<u64> = ran.iter().map(|(.., at)| (*at - began).as_secs()).collect();
            assert_eq!(at, [0, 1, 3, 7, 15, 31, 63, 123, 183]);
        }));
    }

    #[test]
    fn asks_again_for_a_connection_that_ended_before_the_request_saw_it() {
        paused().block_on(within(LIMIT, async {
            // No task drives this channel: the test plays it, so the end comes between the
            // connection being made and the request looking.
            let shared = Arc::new(Shared {
                session: Mutex::new(Box::new(Fake {
                    socket: String::new(),
                })),
                bound: Box::new(Vec::new),
                link: watch::Sender::new(Link::default()),
                wanted: Notify::new(),
                stop: CancellationToken::new(),
            });
            let channel = Channel {
                shared: Arc::clone(&shared),
            };
            let driver = async {
                shared.wanted.notified().await;
                shared.link.send_modify(|link| link.up = None);
                shared.wanted.notified().await;
                shared.stop.cancel();
                shared.link.send_modify(|_| {});
            };
            let (outcome, ()) = tokio::join!(channel.request("work", json!({})), driver);
            assert_eq!(outcome.unwrap_err().message, "the daemon is stopping");
        }));
    }

    #[test]
    fn counts_a_connection_held_only_from_when_its_sessions_were_picked_up() {
        let dir = TempDir::new("channel-held");
        paused().block_on(within(LIMIT, async {
            let began = Instant::now();
            let listener = listen(&dir);
            let _rig = rig(&dir, vec![bound("s1"), bound("s2")], never_started());
            let mut at = Vec::new();
            // The first takes 40 s to pick up its two sessions, then ends at once: it never held.
            for resuming in [20, 0, 0] {
                let mut server = accepted(&listener).await;
                at.push((Instant::now() - began).as_secs());
                handshake(&mut server, None).await;
                for _ in 0..2 {
                    tokio::time::sleep(Duration::from_secs(resuming)).await;
                    answer(&mut server, "resume", json!({})).await;
                }
            }
            assert_eq!(at, [0, 41, 43]);
        }));
    }

    #[test]
    fn waits_out_the_backoff_after_a_failure_a_request_was_told_of() {
        let dir = TempDir::new("channel-asked");
        paused().block_on(within(LIMIT, async {
            let began = Instant::now();
            let listener = listen(&dir);
            let rig = rig(&dir, vec![bound("s1")], never_started());
            let asking = async {
                tokio::time::sleep(Duration::from_secs(10)).await;
                rig.channel.request("work", json!({})).await
            };
            // Each server takes the connection and never answers its handshake.
            let accepting = async {
                let mut held = Vec::new();
                for _ in 0..2 {
                    held.push(accepted(&listener).await);
                }
                (Instant::now() - began).as_secs()
            };
            let (failed, second) = tokio::join!(asking, accepting);
            assert_eq!(
                failed.unwrap_err().message,
                "initialize: no reply in 30000 ms"
            );
            assert_eq!(second, 31);
        }));
    }

    #[test]
    fn connects_by_itself_only_while_an_agent_is_bound() {
        let dir = TempDir::new("channel-unbound");
        paused().block_on(within(LIMIT, async {
            let rig = rig(&dir, vec![], never_started());
            tokio::time::sleep(Duration::from_secs(600)).await;
            rig.channel.keep_connected();
            tokio::time::sleep(Duration::from_secs(600)).await;
            assert_eq!(rig.ran(), []);
        }));
    }

    #[test]
    fn tries_at_once_when_kept_connected_rather_than_wait_out_the_backoff() {
        let dir = TempDir::new("channel-keep");
        paused().block_on(within(LIMIT, async {
            let began = Instant::now();
            let rig = rig(&dir, vec![bound("s1")], never_started());
            tokio::time::sleep(Duration::from_millis(500)).await;
            rig.channel.keep_connected();
            tokio::time::sleep(Duration::from_millis(100)).await;
            let ran = rig.starts.ran.lock().unwrap();
            let at: Vec<u128> = ran
                .iter()
                .map(|(.., at)| (*at - began).as_millis())
                .collect();
            assert_eq!(at, [0, 500]);
        }));
    }

    #[test]
    fn sends_a_request_a_draining_server_refused_to_the_server_that_comes_next() {
        let dir = TempDir::new("channel-drain");
        paused().block_on(within(LIMIT, async {
            let listener = listen(&dir);
            let rig = rig(&dir, vec![], never_started());
            let servers = async {
                let mut server = accepted(&listener).await;
                handshake(&mut server, None).await;
                reply(&mut server, "work", draining()).await;
                // A draining server holds its connections a while before it exits.
                tokio::time::sleep(Duration::from_secs(1)).await;
                drop(server);
                let mut server = accepted(&listener).await;
                handshake(&mut server, None).await;
                answer(&mut server, "work", json!("done")).await;
                server
            };
            let (done, _server) = tokio::join!(rig.channel.request("work", json!({})), servers);
            assert_eq!(done, Ok(json!("done")));
        }));
    }

    #[test]
    fn tries_three_servers_while_each_drains_then_fails_with_the_last_as_no_refusal() {
        let dir = TempDir::new("channel-drained");
        paused().block_on(within(LIMIT, async {
            let listener = listen(&dir);
            let rig = rig(&dir, vec![], never_started());
            let servers = async {
                for _ in 0..3 {
                    let mut server = accepted(&listener).await;
                    handshake(&mut server, None).await;
                    reply(&mut server, "work", draining()).await;
                }
            };
            let (failed, ()) = tokio::join!(rig.channel.request("work", json!({})), servers);
            assert_eq!(
                failed,
                Err(ChannelError {
                    kind: ChannelErrorKind::Failed,
                    message: "work: Server is draining (-32600)".to_owned(),
                })
            );
        }));
    }

    #[test]
    fn a_request_the_server_refuses_is_refused_and_one_it_fails_inside_is_not() {
        let dir = TempDir::new("channel-refused");
        paused().block_on(within(LIMIT, async {
            let listener = listen(&dir);
            let rig = rig(&dir, vec![], never_started());
            let server = async {
                let mut server = accepted(&listener).await;
                handshake(&mut server, None).await;
                let refusal = json!({ "error": { "code": -32601, "message": "no such method" } });
                reply(&mut server, "work", refusal).await;
                let inside = json!({ "error": { "code": -32603, "message": "can't read" } });
                reply(&mut server, "read", inside).await;
                server
            };
            let asked = async {
                let work = rig.channel.request("work", json!({})).await;
                (work, rig.channel.request("read", json!({})).await)
            };
            let ((work, read), _server) = tokio::join!(asked, server);
            let kinds = [work.unwrap_err().kind, read.unwrap_err().kind];
            assert_eq!(kinds, [ChannelErrorKind::Refused, ChannelErrorKind::Failed]);
        }));
    }

    #[test]
    fn leaves_a_server_whose_handshake_fails_and_fails_the_request_with_why() {
        let dir = TempDir::new("channel-handshake");
        paused().block_on(within(LIMIT, async {
            let listener = listen(&dir);
            let mut rig = rig(&dir, vec![], never_started());
            let server = async {
                let mut server = accepted(&listener).await;
                let wrong = json!({ "error": { "code": -32603, "message": "another home" } });
                reply(&mut server, "initialize", wrong).await;
                ends(&mut server).await
            };
            let (failed, ended) = tokio::join!(rig.channel.request("work", json!({})), server);
            assert_eq!(
                failed.unwrap_err().message,
                "initialize: another home (-32603)"
            );
            assert!(ended, "the connection is left");
            assert!(rig.events.try_recv().is_err(), "nothing is told of it");
        }));
    }

    #[test]
    fn ends_its_connection_and_fails_what_waits_once_stopped() {
        let dir = TempDir::new("channel-stop");
        paused().block_on(within(LIMIT, async {
            let listener = listen(&dir);
            let rig = rig(&dir, vec![], never_started());
            let channel = rig.channel.clone();
            let slow = rig
                .tasks
                .spawn(async move { channel.request("slow", json!({})).await });
            let mut server = accepted(&listener).await;
            handshake(&mut server, None).await;
            heard(&mut server).await;
            rig.stop.cancel();
            let ended = tokio::time::timeout(PROMPTLY, ends(&mut server))
                .await
                .expect("the connection outlives the stop");
            assert!(ended);
            let failed = slow.await.unwrap().unwrap_err();
            assert_eq!(failed.message, "slow: the connection ended");
            let refused = rig.channel.request("work", json!({})).await.unwrap_err();
            assert_eq!(refused.message, "the daemon is stopping");
            rig.tasks.close();
            rig.tasks.wait().await;
        }));
    }

    #[test]
    fn stops_though_the_daemon_never_takes_what_it_is_told() {
        let dir = TempDir::new("channel-full");
        paused().block_on(within(LIMIT, async {
            let listener = listen(&dir);
            let rig = rig_with(&dir, vec![], never_started(), 1);
            let server = async {
                let mut server = accepted(&listener).await;
                handshake(&mut server, None).await;
                answer(&mut server, "work", json!("done")).await;
                for method in ["a", "b"] {
                    say(&mut server, json!({ "method": method, "params": {} })).await;
                }
                server
            };
            let (done, _server) = tokio::join!(rig.channel.request("work", json!({})), server);
            assert_eq!(done, Ok(json!("done")));
            // The version filled the queue: the rest wait on it.
            tokio::time::sleep(Duration::from_secs(1)).await;
            rig.stop.cancel();
            rig.tasks.close();
            rig.tasks.wait().await;
        }));
    }

    #[test]
    fn gives_up_waiting_for_a_draining_server_that_holds_its_connection() {
        let dir = TempDir::new("channel-held-drain");
        paused().block_on(within(LIMIT, async {
            let listener = listen(&dir);
            let rig = rig(&dir, vec![], never_started());
            let began = Instant::now();
            let server = async {
                let mut server = accepted(&listener).await;
                handshake(&mut server, None).await;
                for _ in 0..DRAINING_ATTEMPTS {
                    reply(&mut server, "work", draining()).await;
                }
                server
            };
            let (failed, _server) = tokio::join!(rig.channel.request("work", json!({})), server);
            assert_eq!(
                failed.unwrap_err().message,
                "work: Server is draining (-32600)"
            );
            assert_eq!(Instant::now() - began, rpc::REQUEST_TIMEOUT * 2);
        }));
    }

    #[test]
    fn ends_the_connection_once_nobody_reads_what_the_server_says() {
        let dir = TempDir::new("channel-unread");
        paused().block_on(within(LIMIT, async {
            let listener = listen(&dir);
            let rig = rig(&dir, vec![], never_started());
            let Rig {
                channel, events, ..
            } = rig;
            drop(events);
            let server = async {
                let mut server = accepted(&listener).await;
                handshake(&mut server, None).await;
                answer(&mut server, "work", json!("ok")).await;
                say(&mut server, json!({ "method": "note" })).await;
                ends(&mut server).await
            };
            let (done, ended) = tokio::join!(channel.request("work", json!({})), server);
            assert_eq!((done, ended), (Ok(json!("ok")), true));
        }));
    }
}
