//! A harness of the test's own, independent of any harness id, which records each call: the
//! daemon drives it as it drives any, so a test under each id in turn proves the daemon asks the
//! harness rather than naming one.

use std::sync::{Arc, Mutex};

use bazhen_harness::{
    ActivitySource, AgentRef, Answer, BoxFuture, Capabilities, ChannelPort, Delivery, Evidence,
    Harness, HarnessDeps, HarnessDoctor, Harnesses, IngestContext, Ingested, LaunchError,
    LaunchRequest, LaunchSpec, Listen, MailRefusal, Outgoing, Pending, PushPort, Pushed, Report,
    Resolution, RunPort, Session, SessionRef, production,
};
use bazhen_protocol::agents::{ExternalRef, ExternalRefKind, HarnessId};
use bazhen_protocol::shells::TuiTheme;

/// What the stub's TUI starts with, which only it could give.
pub(crate) const STUB_ARGV: [&str; 2] = ["stub-tui", "--fresh"];
/// The session its launch makes.
pub(crate) const STUB_SESSION: &str = "stub-session-1";

const THEMES: [TuiTheme; 1] = [TuiTheme::Dark];

/// The stub, with what each call it has had was given.
#[derive(Debug, Clone)]
pub(crate) struct StubHarness {
    caps: Capabilities,
    /// Each launch's request, in order.
    pub(crate) launches: Arc<Mutex<Vec<LaunchRequest>>>,
    /// What each launch is refused with, if it is.
    refusal: Option<LaunchError>,
}

impl StubHarness {
    pub(crate) fn new(caps: Capabilities) -> Self {
        Self {
            caps,
            launches: Arc::default(),
            refusal: None,
        }
    }

    /// The same, refusing every launch with `refusal`.
    pub(crate) fn refusing(refusal: LaunchError) -> Self {
        Self {
            refusal: Some(refusal),
            ..Self::new(pull())
        }
    }

    /// Harnesses serving the stub alone, as `id`.
    pub(crate) fn served_as(&self, id: HarnessId) -> Harnesses {
        Harnesses::new(vec![(id, Box::new(self.clone()))])
    }
}

/// What a harness whose hooks take mail can do.
pub(crate) fn pull() -> Capabilities {
    Capabilities {
        delivery: Delivery::Pull,
        approvals: true,
        activity: ActivitySource::Hooks,
    }
}

/// The harnesses this build serves, over a world that answers nothing and names each session
/// `session-1`.
pub(crate) fn production_for_test() -> Harnesses {
    production(HarnessDeps {
        new_session_id: Box::new(|| "session-1".to_owned()),
        hook_command: "exec '/state/hook/bazhen-hook'".to_owned(),
        daemon_env: Box::new(|_| None),
        user_env: Box::new(|_| None),
        home: "/home/u".to_owned(),
        read_file: Box::new(|_| None),
        scan_transcript: Box::new(|_, _| false),
        now_ms: Box::new(|| 0),
        daemon_socket: "/run/b.sock".to_owned(),
        real_path: Arc::new(|_| None),
    })
}

fn ready<'a, T: Send + 'a>(value: T) -> BoxFuture<'a, T> {
    Box::pin(std::future::ready(value))
}

impl Harness for StubHarness {
    fn capabilities(&self) -> Capabilities {
        self.caps
    }

    fn themes(&self) -> &'static [TuiTheme] {
        &THEMES
    }

    fn launch<'a>(
        &'a self,
        request: &'a LaunchRequest,
        _channel: Option<&'a dyn ChannelPort>,
    ) -> BoxFuture<'a, Result<LaunchSpec, LaunchError>> {
        self.launches.lock().unwrap().push(request.clone());
        if let Some(refusal) = &self.refusal {
            return ready(Err(refusal.clone()));
        }
        ready(Ok(LaunchSpec {
            argv: STUB_ARGV.map(str::to_owned).to_vec(),
            env: vec![("STUB_HOME".to_owned(), "/stub".to_owned())],
            // Whatever it was asked for, it draws for its one theme.
            theme: request.theme.map(|_| TuiTheme::Dark),
            session: Some(SessionRef {
                kind: ExternalRefKind::ClaudeSession,
                id: STUB_SESSION.to_owned(),
            }),
        }))
    }

    fn resume<'a>(
        &'a self,
        _request: &'a LaunchRequest,
        _session: &'a ExternalRef,
        _channel: Option<&'a dyn ChannelPort>,
    ) -> Option<BoxFuture<'a, Result<LaunchSpec, LaunchError>>> {
        None
    }

    fn can_resume(&self, _evidence: &Evidence<'_>) -> bool {
        false
    }

    fn ingest(&self, _report: Report<'_>, _context: &IngestContext<'_>) -> Ingested {
        Ingested::nothing()
    }

    fn listening(&self, _agent: &Listen) -> bool {
        false
    }

    fn not_ready_hint(&self) -> Option<&'static str> {
        Some("the stub never says it is up")
    }

    fn accepts_mail(&self, _agent: &AgentRef<'_>) -> Result<(), MailRefusal> {
        Ok(())
    }

    fn push<'a>(
        &'a self,
        _mail: &'a Outgoing<'a>,
        _port: &'a dyn PushPort,
    ) -> BoxFuture<'a, Pushed> {
        ready(Pushed::NotNow)
    }

    fn answer(&self, _to: &Pending<'_>, _with: Resolution<'_>) -> Answer {
        Answer::Unavailable
    }

    fn session(&self) -> Option<Box<dyn Session>> {
        None
    }

    fn doctor<'a>(
        &'a self,
        _channel: Option<&'a dyn ChannelPort>,
        _run: &'a dyn RunPort,
    ) -> BoxFuture<'a, Option<HarnessDoctor>> {
        ready(None)
    }
}
