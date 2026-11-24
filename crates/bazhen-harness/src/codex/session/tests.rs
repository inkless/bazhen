//! The connection to Codex's app-server, against a fake server and what the TypeScript daemon did.

use super::*;
use crate::codex::tests::{
    HOME, THREAD, activity, agent, ask, command, fixture, launch_request, notify, ready, status,
    tool, turn,
};
use crate::codex::{Codex, launch};
use crate::{
    Answer, Harness, HarnessActivity, HarnessDoctor, Output, Pending, Resolution, RunError, RunPort,
};
use bazhen_protocol::agents::{ExternalRef, ExternalRefKind};
use bazhen_protocol::ids::EnvironmentId;
use std::time::Duration;

/// Another thread than [`THREAD`], which a title can name.
const OTHER: &str = "019a8f40-0000-7000-8000-000000000003";
/// The prefix a title cut short names [`OTHER`] by.
const OTHER_TITLE: &str = "019a8f40-0000-7000-8000-00000...";
const SOCKET: &str = "/run/bazhen.sock";

type Answers = dyn Fn(&str, &Value) -> Result<Value, ChannelError> + Send + Sync;

/// An app-server that answers each request as `answers` says, and records all it was sent.
struct Wire {
    answers: Box<Answers>,
    sent: Mutex<Vec<Value>>,
}

impl Wire {
    fn new(
        answers: impl Fn(&str, &Value) -> Result<Value, ChannelError> + Send + Sync + 'static,
    ) -> Self {
        Self {
            answers: Box::new(answers),
            sent: Mutex::default(),
        }
    }

    fn sent(&self) -> Vec<Value> {
        self.sent.lock().unwrap().clone()
    }

    /// The methods of the requests sent, in order.
    fn asked(&self) -> Vec<String> {
        let sent = self.sent();
        sent.iter()
            .filter_map(|s| s["method"].as_str().map(str::to_owned))
            .collect()
    }
}

impl ChannelPort for Wire {
    fn request<'a>(
        &'a self,
        method: &'a str,
        params: Value,
    ) -> BoxFuture<'a, Result<Value, ChannelError>> {
        let answer = (self.answers)(method, &params);
        self.sent
            .lock()
            .unwrap()
            .push(json!({ "method": method, "params": params }));
        Box::pin(std::future::ready(answer))
    }

    fn notify<'a>(
        &'a self,
        method: &'a str,
        params: Value,
    ) -> BoxFuture<'a, Result<(), ChannelError>> {
        self.sent
            .lock()
            .unwrap()
            .push(json!({ "notify": method, "params": params }));
        Box::pin(std::future::ready(Ok(())))
    }
}

fn refused(what: &str) -> ChannelError {
    ChannelError {
        kind: ChannelErrorKind::Refused,
        message: what.to_owned(),
    }
}

/// Codex for the daemon at [`SOCKET`], in [`HOME`], with links resolved as `links` says.
fn served(links: &'static [(&'static str, &'static str)]) -> Codex {
    let starts = launch::Starts {
        remote: launch::app_server_address(HOME),
        socket: Some(SOCKET.to_owned()),
    };
    let real_path: Arc<Lookup> = Arc::new(|path| {
        links
            .iter()
            .find(|(link, _)| *link == path)
            .map(|(_, real)| (*real).to_owned())
    });
    Codex::on(starts, Home::new(HOME.to_owned(), real_path))
}

fn session(codex: &Codex) -> Box<dyn Session> {
    codex.session().expect("Codex keeps a connection")
}

fn environment() -> EnvironmentId {
    EnvironmentId::parse("env_0190a1b2c3d47abc8def0123456789ab").unwrap()
}

fn thread_ref(thread: &str) -> ExternalRef {
    ExternalRef {
        environment_id: environment(),
        kind: ExternalRefKind::CodexThread,
        id: thread.to_owned(),
    }
}

/// The agent on `thread`, started to compact at 9000 tokens.
fn bound_to(thread: &str) -> Bound {
    Bound {
        agent: agent(),
        session: thread_ref(thread),
        launch: launch_request(&json!({ "compactWindowTokens": 9000 })),
    }
}

/// A resume of `thread` as an agent started on [`SOCKET`] and to compact at 9000 tokens asks it.
fn resume_of(thread: &str) -> Value {
    json!({ "method": "thread/resume", "params": {
        "threadId": thread,
        "excludeTurns": true,
        "config": {
            "shell_environment_policy.set.BAZHEN_SOCKET": SOCKET,
            "shell_environment_policy.set.BAZHEN_AGENT_ID": "",
            "shell_environment_policy.set.BAZHEN_AGENT_AUTH_FILE": "",
            "model_auto_compact_token_limit": 9000,
        },
    } })
}

/// The `thread/resume` result the fixtures name `name`.
fn result(name: &str) -> Value {
    let cases = fixture("results.json");
    let case = cases.as_array().unwrap().iter().find(|c| c["name"] == name);
    case.expect("a recorded result")["result"].clone()
}

fn on_thread(thread: &str, value: ActivityValue, detail: Option<&str>) -> Keyed {
    on(
        thread,
        Observed::Activity(HarnessActivity {
            value,
            detail: detail.map(str::to_owned),
            limit: None,
        }),
    )
}

fn resumed(thread: &str) -> Keyed {
    on(thread, Observed::Resumed)
}

fn initialized(home: &str, user_agent: &str) -> Wire {
    let answer = json!({ "codexHome": home, "userAgent": user_agent });
    Wire::new(move |method, _| match method {
        "initialize" => Ok(answer.clone()),
        _ => Err(refused(method)),
    })
}

#[test]
fn codexs_server_is_the_one_its_cli_starts_in_the_users_codex_home() {
    let endpoint = session(&served(&[])).endpoint();
    assert_eq!(
        endpoint.address,
        "/home/u/.codex/app-server-control/app-server-control.sock"
    );
    let mut start = vec![json!("codex")];
    start.extend(
        fixture("daemon.json")["startArgs"]
            .as_array()
            .unwrap()
            .clone(),
    );
    assert_eq!(json!(endpoint.start), json!(start));
}

#[test]
fn a_report_from_the_server_is_routed_to_the_thread_it_names() {
    let s = session(&served(&[]));
    let route = |report: Report<'_>| s.route(&report).map(|key| key.0);
    let params = status("idle").to_string();
    let notification = Report::Notification {
        method: "thread/status/changed",
        params: params.as_bytes(),
    };
    assert_eq!(route(notification), Some(THREAD.to_owned()));
    let params = command().to_string();
    let request = Report::ServerRequest {
        method: "item/commandExecution/requestApproval",
        params: params.as_bytes(),
        id: "7",
    };
    assert_eq!(route(request), Some(THREAD.to_owned()));
    let started = json!({ "thread": { "id": OTHER } }).to_string();
    let announced = Report::Notification {
        method: "thread/started",
        params: started.as_bytes(),
    };
    assert_eq!(route(announced), None);
    let garbled = Report::Notification {
        method: "thread/status/changed",
        params: b"{",
    };
    assert_eq!(route(garbled), None);
    assert_eq!(route(Report::TerminalTitle { title: THREAD }), None);
    let hook = Report::Hook {
        event: "Stop",
        payload: params.as_bytes(),
    };
    assert_eq!(route(hook), None);
}

#[test]
fn the_handshake_initializes_and_names_the_servers_version() {
    let codex = served(&[]);
    let mut s = session(&codex);
    let wire = initialized(HOME, "bazhen/0.167.1 (Linux 6.8; x86_64) codex");
    assert_eq!(ready(s.handshake(&wire)), Ok(Some("0.167.1".to_owned())));
    assert_eq!(
        wire.sent(),
        vec![
            json!({ "method": "initialize", "params": {
                "clientInfo": { "name": "bazhen", "version": "0" },
                "capabilities": { "experimentalApi": true },
            } }),
            json!({ "notify": "initialized", "params": null }),
        ]
    );
}

#[test]
fn the_servers_version_is_the_token_after_the_clients_name() {
    let cases = [
        ("bazhen/0.167.1 (Linux; x86_64)", Some("0.167.1")),
        ("bazhen/0.167.1", Some("0.167.1")),
        ("bazhen/0.167.1\tx", Some("0.167.1")),
        ("a/b/c", Some("b/c")),
        ("bazhen 0.167.1", None),
        ("bazhen /0.167.1", None),
        ("/0.167.1", None),
        ("bazhen/", None),
        ("bazhen/ 0.167.1", None),
        ("", None),
    ];
    for (user_agent, version) in cases {
        assert_eq!(
            server_version(user_agent).as_deref(),
            version,
            "{user_agent:?}"
        );
    }
}

#[test]
fn a_server_for_another_codex_home_fails_the_handshake_to_be_tried_again() {
    let codex = served(&[(HOME, "/data/codex"), ("/link", "/data/codex")]);
    let mut s = session(&codex);
    // The same directory by another path is the same home.
    let same = initialized("/link", "bazhen/1");
    assert_eq!(ready(s.handshake(&same)), Ok(Some("1".to_owned())));
    let other = initialized("/elsewhere", "bazhen/1");
    assert_eq!(
        ready(s.handshake(&other)),
        Err(ChannelError {
            kind: ChannelErrorKind::Failed,
            message: "the app-server belongs to /elsewhere, not /data/codex".to_owned(),
        })
    );
    assert_eq!(other.asked(), ["initialize"]);
    assert_eq!(other.sent().len(), 1, "nothing follows it");
}

#[test]
fn an_initialize_answer_without_the_home_and_the_user_agent_fails_the_handshake() {
    let codex = served(&[]);
    let mut s = session(&codex);
    for answer in [
        json!({ "codexHome": HOME }),
        json!({ "userAgent": "bazhen/1" }),
        json!({ "codexHome": 1, "userAgent": "bazhen/1" }),
        json!(null),
    ] {
        let wire = Wire::new(move |_, _| Ok(answer.clone()));
        let got = ready(s.handshake(&wire));
        assert_eq!(got.map_err(|e| e.kind), Err(ChannelErrorKind::Failed));
        assert_eq!(wire.sent().len(), 1, "nothing follows a failure");
    }
    let wire = Wire::new(|method, _| Err(refused(method)));
    assert_eq!(ready(s.handshake(&wire)), Err(refused("initialize")));
}

/// `codex --version`, as it ran, and how long it was given.
struct Version {
    exit: Result<Output, RunError>,
    ran: Mutex<Vec<(Vec<String>, Duration)>>,
}

impl RunPort for Version {
    fn run<'a>(
        &'a self,
        argv: &'a [String],
        timeout: Duration,
    ) -> BoxFuture<'a, Result<Output, RunError>> {
        self.ran.lock().unwrap().push((argv.to_vec(), timeout));
        Box::pin(std::future::ready(self.exit.clone()))
    }
}

fn version(exit: Result<Output, RunError>) -> Version {
    Version {
        exit,
        ran: Mutex::default(),
    }
}

fn printed(code: Option<i32>, stdout: &str) -> Output {
    Output {
        code,
        stdout: stdout.to_owned(),
        stderr: String::new(),
    }
}

#[test]
fn doctor_names_the_version_the_server_last_named_and_the_clis() {
    let codex = served(&[]);
    let cli = version(Ok(printed(Some(0), "codex-cli 0.167.1\n")));
    let doctor = |run: &Version| ready(codex.doctor(None, run));
    let reads = |server: Option<&str>, cli: Option<&str>| {
        Some(HarnessDoctor {
            server: server.map(str::to_owned),
            cli: cli.map(str::to_owned),
            tool_calls: None,
        })
    };
    assert_eq!(doctor(&cli), reads(None, Some("0.167.1")));
    assert_eq!(
        *cli.ran.lock().unwrap(),
        [(
            vec!["codex".to_owned(), "--version".to_owned()],
            Duration::from_secs(1)
        )]
    );
    let mut s = session(&codex);
    ready(s.handshake(&initialized(HOME, "bazhen/0.167.1"))).unwrap();
    assert_eq!(doctor(&cli), reads(Some("0.167.1"), Some("0.167.1")));
    // It stands once the connection ends.
    s.disconnected();
    assert_eq!(doctor(&cli), reads(Some("0.167.1"), Some("0.167.1")));
    let failed = version(Ok(printed(Some(1), "codex-cli 0.167.1\n")));
    assert_eq!(doctor(&failed), reads(Some("0.167.1"), None));
    let killed = version(Ok(printed(None, "codex-cli 0.167.1\n")));
    assert_eq!(doctor(&killed), reads(Some("0.167.1"), None));
    let missing = version(Err(RunError {
        message: "no codex".to_owned(),
    }));
    assert_eq!(doctor(&missing), reads(Some("0.167.1"), None));
    // A server that names no version is reported as naming none.
    assert_eq!(ready(s.handshake(&initialized(HOME, "bazhen"))), Ok(None));
    assert_eq!(doctor(&cli), reads(None, Some("0.167.1")));
}

#[test]
fn the_clis_version_is_read_as_the_typescript_daemon_read_it() {
    let cases = fixture("daemon.json")["cliVersion"].clone();
    for case in cases.as_array().unwrap() {
        let output = case["output"].as_str().unwrap();
        assert_eq!(json!(cli_version(output)), case["version"], "{output:?}");
    }
    // What the TypeScript regex took apart that no recorded output shows.
    assert_eq!(cli_version("codex-cli\t0.1"), None);
    assert_eq!(cli_version("codex-cli  0.1"), None);
    assert_eq!(cli_version("codex-cli 0.1\u{a0}x"), None);
}

/// A server whose resume of each thread answers as `answers` names it, by thread.
fn resumes(answers: &'static [(&'static str, Option<&'static str>)]) -> Wire {
    Wire::new(move |method, params| {
        let thread = params["threadId"].as_str().unwrap_or_default();
        let answer = answers.iter().find(|(t, _)| *t == thread);
        match (method, answer) {
            ("thread/resume", Some((_, Some(name)))) => Ok(result(name)),
            _ => Err(refused("no such thread")),
        }
    })
}

#[test]
fn each_bound_thread_is_resumed_on_a_new_connection_and_said_picked_up_only_if_it_was() {
    let codex = served(&[]);
    let mut s = session(&codex);
    let wire = resumes(&[(THREAD, Some("working")), (OTHER, None)]);
    let bound = [bound_to(OTHER), bound_to(THREAD)];
    let facts = ready(s.connected(&wire, &bound));
    assert_eq!(wire.sent(), vec![resume_of(OTHER), resume_of(THREAD)]);
    assert_eq!(
        facts,
        vec![activity(ActivityValue::Working, None), resumed(THREAD)]
    );
    // Said picked up after every thread says how it is.
    let wire = resumes(&[(THREAD, Some("idle")), (OTHER, Some("no status"))]);
    let facts = ready(s.connected(&wire, &bound));
    assert_eq!(
        facts,
        vec![
            activity(ActivityValue::Idle, None),
            resumed(OTHER),
            resumed(THREAD)
        ]
    );
}

#[test]
fn a_turn_a_server_restart_cut_off_is_auto_continued_or_interrupted() {
    let codex = served(&[]);
    let mut s = session(&codex);
    let a = agent();
    let both = [bound_to(THREAD), bound_to(OTHER)];
    let working = json!({ "threadId": OTHER, "status": { "type": "active", "activeFlags": [] } });
    notify(&codex, Some(&a), "thread/status/changed", &working);
    let approving = json!({ "threadId": THREAD,
        "status": { "type": "active", "activeFlags": ["waitingOnApproval"] } });
    notify(&codex, Some(&a), "thread/status/changed", &approving);
    s.disconnected();
    let wire = resumes(&[(THREAD, Some("working")), (OTHER, Some("idle"))]);
    assert_eq!(
        ready(s.connected(&wire, &both)),
        vec![
            activity(ActivityValue::Working, Some(AUTO_CONTINUED)),
            on_thread(OTHER, ActivityValue::Idle, Some(INTERRUPTED)),
            resumed(THREAD),
            resumed(OTHER),
        ]
    );
    // Once: a thread idle when the next connection ends was cut off from nothing.
    notify(&codex, Some(&a), "turn/completed", &turn(Some("completed")));
    s.disconnected();
    assert_eq!(
        ready(s.connected(&wire, &both[..1])),
        vec![activity(ActivityValue::Working, None), resumed(THREAD)]
    );
}

#[test]
fn a_thread_cut_off_waiting_on_the_human_is_cut_off() {
    for flag in ["waitingOnApproval", "waitingOnUserInput"] {
        let codex = served(&[]);
        let mut s = session(&codex);
        let waiting = json!({ "threadId": THREAD,
            "status": { "type": "active", "activeFlags": [flag] } });
        notify(&codex, Some(&agent()), "thread/status/changed", &waiting);
        s.disconnected();
        let wire = resumes(&[(THREAD, Some("idle"))]);
        assert_eq!(
            ready(s.connected(&wire, &[bound_to(THREAD)])),
            vec![
                activity(ActivityValue::Idle, Some(INTERRUPTED)),
                resumed(THREAD)
            ],
            "{flag}"
        );
    }
}

#[test]
fn a_thread_picked_up_again_alone_is_loaded_once_its_resume_says_so() {
    let codex = served(&[]);
    let mut s = session(&codex);
    let agent = bound_to(THREAD);
    let wire = resumes(&[(THREAD, Some("not loaded"))]);
    assert_eq!(ready(s.reload(&agent, &wire)), Reloaded::NotYet);
    assert_eq!(wire.sent(), vec![resume_of(THREAD)]);
    let wire = resumes(&[]);
    assert_eq!(ready(s.reload(&agent, &wire)), Reloaded::NotYet);
    let wire = resumes(&[(THREAD, Some("waiting on approval"))]);
    assert_eq!(
        ready(s.reload(&agent, &wire)),
        Reloaded::Loaded(vec![activity(ActivityValue::NeedsApproval, None)])
    );
    // No Resumed: what the connection asked stands.
    let wire = resumes(&[(THREAD, Some("no status"))]);
    assert_eq!(ready(s.reload(&agent, &wire)), Reloaded::Loaded(vec![]));
}

#[test]
fn the_idle_a_resume_answers_after_a_failed_turn_doesnt_hide_it() {
    let codex = served(&[]);
    let mut s = session(&codex);
    notify(
        &codex,
        Some(&agent()),
        "turn/completed",
        &turn(Some("failed")),
    );
    let idle = resumes(&[(THREAD, Some("idle"))]);
    assert_eq!(
        ready(s.reload(&bound_to(THREAD), &idle)),
        Reloaded::Loaded(vec![])
    );
    let working = resumes(&[(THREAD, Some("working"))]);
    assert_eq!(
        ready(s.reload(&bound_to(THREAD), &working)),
        Reloaded::Loaded(vec![activity(ActivityValue::Working, None)])
    );
    // On this connection only: the turn working then was cut off, and the idle after is shown.
    s.disconnected();
    assert_eq!(
        ready(s.connected(&idle, &[bound_to(THREAD)])),
        vec![
            activity(ActivityValue::Idle, Some(INTERRUPTED)),
            resumed(THREAD)
        ]
    );
}

#[test]
fn a_request_asked_on_a_connection_that_ended_is_settled_by_nothing_said_after_it() {
    let codex = served(&[]);
    let mut s = session(&codex);
    let a = agent();
    ask(
        &codex,
        Some(&a),
        "item/commandExecution/requestApproval",
        &command(),
        "7",
    );
    let question = json!({ "threadId": THREAD, "turnId": "t1", "itemId": "call-3",
        "questions": [{ "id": "q1", "header": "Name", "question": "What should it be called?" }] });
    ask(
        &codex,
        Some(&a),
        "item/tool/requestUserInput",
        &question,
        "9",
    );
    s.disconnected();
    // The new server numbers its own requests from the start again.
    let resolved = json!({ "threadId": THREAD, "requestId": 7 });
    assert_eq!(
        notify(&codex, None, "serverRequest/resolved", &resolved),
        vec![]
    );
    let key = tool("call-3");
    let pending = Pending::ServerRequest {
        method: "item/tool/requestUserInput",
        key: &key,
    };
    assert_eq!(
        codex.answer(&pending, Resolution::Text("Ada")),
        Answer::Unavailable
    );
}

#[test]
fn a_title_is_not_followed_yet_and_asks_the_server_nothing() {
    let codex = served(&[]);
    let mut s = session(&codex);
    let wire = resumes(&[]);
    assert_eq!(
        ready(s.follow(&bound_to(THREAD), OTHER_TITLE, &wire)),
        Followed::Untracked {
            detail: "thread switches are not being tracked".to_owned()
        }
    );
    assert_eq!(wire.sent(), Vec::<Value>::new());
    assert!(!s.may_follow_to(THREAD, &SessionKey(THREAD.to_owned())));
}

#[test]
fn reads_what_a_resume_answers_as_the_typescript_daemon_did() {
    for case in fixture("results.json").as_array().unwrap() {
        let result = Js::parse(case["result"].to_string().as_bytes()).unwrap();
        let name = &case["name"];
        assert_eq!(json!(result_activity(&result)), case["activity"], "{name}");
        assert_eq!(
            json!(result_not_loaded(&result)),
            case["notLoaded"],
            "{name}"
        );
    }
}

#[test]
fn a_thread_no_agent_is_on_any_more_is_cut_off_from_nothing() {
    let codex = served(&[]);
    let mut s = session(&codex);
    let working = json!({ "threadId": THREAD, "status": { "type": "active", "activeFlags": [] } });
    notify(&codex, Some(&agent()), "thread/status/changed", &working);
    s.disconnected();
    notify(&codex, None, "thread/status/changed", &working);
    let wire = resumes(&[(THREAD, Some("working"))]);
    assert_eq!(
        ready(s.connected(&wire, &[bound_to(THREAD)])),
        vec![activity(ActivityValue::Working, None), resumed(THREAD)]
    );
}

#[test]
fn a_turn_started_before_a_connection_ended_isnt_taken_for_the_new_servers_own() {
    let codex = served(&[]);
    let mut s = session(&codex);
    let a = agent();
    let working = json!({ "threadId": THREAD, "status": { "type": "active", "activeFlags": [] } });
    notify(&codex, Some(&a), "thread/status/changed", &working);
    s.disconnected();
    let idle = resumes(&[(THREAD, Some("idle"))]);
    ready(s.connected(&idle, &[bound_to(THREAD)]));
    // The user's turn on the interrupted thread, whose first item hasn't come yet.
    notify(&codex, Some(&a), "turn/started", &turn(None));
    s.disconnected();
    let item = json!({ "threadId": THREAD, "turnId": "t1", "item": { "type": "agentMessage", "id": "i1" } });
    assert_eq!(notify(&codex, Some(&a), "item/started", &item), vec![]);
}
