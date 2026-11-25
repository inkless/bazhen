//! A harness of the test's own, independent of any harness id, which records each call: the
//! daemon drives it as it drives any, so a test under each id in turn proves the daemon asks the
//! harness rather than naming one.

use std::collections::VecDeque;
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
/// What its TUI starts again with, before the session it resumes.
pub(crate) const STUB_RESUME_ARGV: [&str; 2] = ["stub-tui", "--resume"];
/// The session its launch makes.
pub(crate) const STUB_SESSION: &str = "stub-session-1";

const THEMES: [TuiTheme; 1] = [TuiTheme::Dark];

/// The stub, with what each call it has had was given.
#[derive(Debug, Clone)]
pub(crate) struct StubHarness {
    caps: Capabilities,
    /// Each launch's request, in order.
    pub(crate) launches: Arc<Mutex<Vec<LaunchRequest>>>,
    /// Each resume's request, with the session it resumed, in order.
    pub(crate) resumes_asked: Arc<Mutex<Vec<(LaunchRequest, ExternalRef)>>>,
    /// What each launch is refused with, if it is.
    refusal: Option<LaunchError>,
    /// What each resume is refused with, if it is.
    resume_refusal: Option<LaunchError>,
    /// What it says of whether any session resumes.
    resumes: bool,
    /// What it says of whether a session is one agent's at a time.
    held_alone: bool,
    /// Why it takes no mail for any agent, if it takes none.
    mail_refusal: Option<String>,
    /// What each push answers, in turn; past the last, `NotNow`.
    pushed: Arc<Mutex<VecDeque<Pushed>>>,
    /// Each push it was handed, in order, with when, on the runtime's clock.
    pub(crate) pushes: Arc<Mutex<Vec<StubPush>>>,
}

/// A message handed to the stub to push.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct StubPush {
    pub(crate) message_id: String,
    pub(crate) body: String,
    pub(crate) session: Option<String>,
    pub(crate) at: tokio::time::Instant,
}

impl StubHarness {
    pub(crate) fn new(caps: Capabilities) -> Self {
        Self {
            caps,
            launches: Arc::default(),
            resumes_asked: Arc::default(),
            refusal: None,
            resume_refusal: None,
            resumes: false,
            held_alone: false,
            mail_refusal: None,
            pushed: Arc::default(),
            pushes: Arc::default(),
        }
    }

    /// The same, saying every session resumes.
    pub(crate) fn resuming(self) -> Self {
        Self {
            resumes: true,
            ..self
        }
    }

    /// The same, saying a session is one agent's at a time.
    pub(crate) fn held_alone(self) -> Self {
        Self {
            held_alone: true,
            ..self
        }
    }

    /// The same, refusing every resume with `refusal`, but no launch.
    pub(crate) fn refusing_resumes(self, refusal: LaunchError) -> Self {
        Self {
            resume_refusal: Some(refusal),
            ..self
        }
    }

    /// The same, taking no mail for any agent, for `reason`.
    pub(crate) fn refusing_mail(mut self, reason: &str) -> Self {
        self.mail_refusal = Some(reason.to_owned());
        self
    }

    /// The same, answering its pushes with `answers` in turn.
    pub(crate) fn pushing(self, answers: impl IntoIterator<Item = Pushed>) -> Self {
        self.pushed.lock().unwrap().extend(answers);
        self
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

    /// Resumes the session it is given, where it says sessions resume, on the TUI's own flag.
    fn resume<'a>(
        &'a self,
        request: &'a LaunchRequest,
        session: &'a ExternalRef,
        _channel: Option<&'a dyn ChannelPort>,
    ) -> Option<BoxFuture<'a, Result<LaunchSpec, LaunchError>>> {
        if !self.resumes {
            return None;
        }
        self.resumes_asked
            .lock()
            .unwrap()
            .push((request.clone(), session.clone()));
        if let Some(refusal) = &self.resume_refusal {
            return Some(ready(Err(refusal.clone())));
        }
        let mut argv: Vec<String> = STUB_RESUME_ARGV.map(str::to_owned).to_vec();
        argv.push(session.id.clone());
        Some(ready(Ok(LaunchSpec {
            argv,
            env: vec![("STUB_HOME".to_owned(), "/stub".to_owned())],
            theme: request.theme.map(|_| TuiTheme::Dark),
            session: Some(SessionRef {
                kind: session.kind,
                id: session.id.clone(),
            }),
        })))
    }

    fn session_held_alone(&self) -> bool {
        self.held_alone
    }

    fn can_resume(&self, _evidence: &Evidence<'_>) -> bool {
        self.resumes
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
        self.mail_refusal.as_ref().map_or(Ok(()), |reason| {
            Err(MailRefusal {
                reason: reason.clone(),
            })
        })
    }

    fn push<'a>(
        &'a self,
        mail: &'a Outgoing<'a>,
        _port: &'a dyn PushPort,
    ) -> BoxFuture<'a, Pushed> {
        self.pushes.lock().unwrap().push(StubPush {
            message_id: mail.message_id.to_owned(),
            body: mail.body.to_owned(),
            session: mail.session.map(|s| s.id.clone()),
            at: tokio::time::Instant::now(),
        });
        let answer = self.pushed.lock().unwrap().pop_front();
        ready(answer.unwrap_or(Pushed::NotNow))
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
