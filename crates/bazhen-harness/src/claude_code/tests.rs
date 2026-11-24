//! The Claude Code adapter against what the TypeScript one gives for the same input: each
//! expected argv and reply was printed by packages/harness-claude-code.

use super::*;
use crate::{
    HarnessActivity, Held, HookOutput, Key, Keyed, LimitStop, Mail, Observed, Origin, Reply,
    SentMessage, ToolKey,
};
use bazhen_protocol::agent_events::{CompactedSign, ReadySign};
use bazhen_protocol::agents::{Usage, UsageLimit};
use bazhen_protocol::ids::{AgentId, EnvironmentId};
use bazhen_protocol::mail::HOOK_REPLY_MAX_BYTES;
use bazhen_protocol::mail_events::ApprovalDecision;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};

fn deps(status: StatusLineChoice, mode: Option<&str>) -> HarnessDeps {
    HarnessDeps {
        new_session_id: Box::new(|| "s-1".to_owned()),
        hook_command: "bazhen-hook".to_owned(),
        permission_mode: mode.map(str::to_owned),
        status_line: Box::new(move |_| status.clone()),
        scan_transcript: Box::new(|_, _| false),
        now_ms: Box::new(|| 0),
    }
}

fn wrapped() -> StatusLineChoice {
    StatusLineChoice::Wrap(Some(UserStatusLine {
        command: "echo 'hi' $X".to_owned(),
        padding: Some(1.0),
    }))
}

fn ready<T>(future: BoxFuture<'_, T>) -> T {
    let waker = std::task::Waker::noop();
    let mut cx = std::task::Context::from_waker(waker);
    let mut future = future;
    match future.as_mut().poll(&mut cx) {
        std::task::Poll::Ready(value) => value,
        std::task::Poll::Pending => panic!("Claude Code's futures never wait"),
    }
}

fn argv_of(spec: Result<LaunchSpec, Refused>) -> Vec<String> {
    spec.unwrap().argv
}

fn golden(line: &str) -> Vec<String> {
    serde_json::from_str(line).unwrap()
}

const LAUNCH: &str = r#"["claude","--session-id","s-1","-n","ann","--autocompact","150000","--settings","{\"hooks\":{\"SessionStart\":[{\"hooks\":[{\"type\":\"command\",\"command\":\"bazhen-hook wait\",\"timeout\":86400,\"asyncRewake\":true}]}],\"Stop\":[{\"hooks\":[{\"type\":\"command\",\"command\":\"bazhen-hook wait\",\"timeout\":86400,\"asyncRewake\":true},{\"type\":\"command\",\"command\":\"bazhen-hook Stop\",\"timeout\":10}]}],\"StopFailure\":[{\"hooks\":[{\"type\":\"command\",\"command\":\"bazhen-hook wait\",\"timeout\":86400,\"asyncRewake\":true},{\"type\":\"command\",\"command\":\"bazhen-hook StopFailure\",\"timeout\":10}]}],\"UserPromptSubmit\":[{\"hooks\":[{\"type\":\"command\",\"command\":\"bazhen-hook UserPromptSubmit\",\"timeout\":10}]}],\"PreToolUse\":[{\"matcher\":\"*\",\"hooks\":[{\"type\":\"command\",\"command\":\"bazhen-hook PreToolUse\",\"timeout\":10}]}],\"PermissionRequest\":[{\"matcher\":\"*\",\"hooks\":[{\"type\":\"command\",\"command\":\"bazhen-hook PermissionRequest\",\"timeout\":60}]}],\"PostToolUse\":[{\"matcher\":\"*\",\"hooks\":[{\"type\":\"command\",\"command\":\"bazhen-hook PostToolUse\",\"timeout\":10}]}],\"PostToolUseFailure\":[{\"matcher\":\"*\",\"hooks\":[{\"type\":\"command\",\"command\":\"bazhen-hook PostToolUseFailure\",\"timeout\":10,\"async\":true}]}],\"SubagentStart\":[{\"hooks\":[{\"type\":\"command\",\"command\":\"bazhen-hook SubagentStart\",\"timeout\":10}]}],\"SubagentStop\":[{\"hooks\":[{\"type\":\"command\",\"command\":\"bazhen-hook SubagentStop\",\"timeout\":10}]}]},\"permissions\":{\"allow\":[\"Bash(bazhen agents list:*)\",\"Bash(bazhen agents whoami:*)\",\"Bash(bazhen agents rename:*)\",\"Bash(bazhen agents send:*)\",\"Bash(bazhen agents wait:*)\",\"Bash(bazhen tasks:*)\",\"Bash(bazhen inbox escalate:*)\",\"Bash(bazhen roles:*)\"],\"ask\":[\"Bash(bazhen *-file*)\"]},\"statusLine\":{\"type\":\"command\",\"command\":\"bazhen-hook statusline-wrap sh -c 'echo '\\\\''hi'\\\\'' $X'\",\"padding\":1},\"theme\":\"dark\"}","--permission-mode","plan","--append-system-prompt","be kind"]"#;
const RESUME: &str = r#"["claude","--resume","old","--settings","{\"hooks\":{\"SessionStart\":[{\"hooks\":[{\"type\":\"command\",\"command\":\"bazhen-hook wait\",\"timeout\":86400,\"asyncRewake\":true}]}],\"Stop\":[{\"hooks\":[{\"type\":\"command\",\"command\":\"bazhen-hook wait\",\"timeout\":86400,\"asyncRewake\":true},{\"type\":\"command\",\"command\":\"bazhen-hook Stop\",\"timeout\":10}]}],\"StopFailure\":[{\"hooks\":[{\"type\":\"command\",\"command\":\"bazhen-hook wait\",\"timeout\":86400,\"asyncRewake\":true},{\"type\":\"command\",\"command\":\"bazhen-hook StopFailure\",\"timeout\":10}]}],\"UserPromptSubmit\":[{\"hooks\":[{\"type\":\"command\",\"command\":\"bazhen-hook UserPromptSubmit\",\"timeout\":10}]}],\"PreToolUse\":[{\"matcher\":\"*\",\"hooks\":[{\"type\":\"command\",\"command\":\"bazhen-hook PreToolUse\",\"timeout\":10}]}],\"PermissionRequest\":[{\"matcher\":\"*\",\"hooks\":[{\"type\":\"command\",\"command\":\"bazhen-hook PermissionRequest\",\"timeout\":60}]}],\"PostToolUse\":[{\"matcher\":\"*\",\"hooks\":[{\"type\":\"command\",\"command\":\"bazhen-hook PostToolUse\",\"timeout\":10}]}],\"PostToolUseFailure\":[{\"matcher\":\"*\",\"hooks\":[{\"type\":\"command\",\"command\":\"bazhen-hook PostToolUseFailure\",\"timeout\":10,\"async\":true}]}],\"SubagentStart\":[{\"hooks\":[{\"type\":\"command\",\"command\":\"bazhen-hook SubagentStart\",\"timeout\":10}]}],\"SubagentStop\":[{\"hooks\":[{\"type\":\"command\",\"command\":\"bazhen-hook SubagentStop\",\"timeout\":10}]}]},\"permissions\":{\"allow\":[\"Bash(bazhen agents list:*)\",\"Bash(bazhen agents whoami:*)\",\"Bash(bazhen agents rename:*)\",\"Bash(bazhen agents send:*)\",\"Bash(bazhen agents wait:*)\",\"Bash(bazhen tasks:*)\",\"Bash(bazhen inbox escalate:*)\",\"Bash(bazhen roles:*)\"],\"ask\":[\"Bash(bazhen *-file*)\"]},\"statusLine\":{\"type\":\"command\",\"command\":\"bazhen-hook statusline-wrap sh -c 'echo '\\\\''hi'\\\\'' $X'\",\"padding\":1}}","--permission-mode","plan","--append-system-prompt-file","/f"]"#;

#[test]
fn launches_on_a_session_it_chose_with_its_hooks_name_window_theme_mode_and_instructions() {
    let harness = ClaudeCode::new(deps(wrapped(), Some("plan")));
    let request = LaunchRequest {
        cwd: "/work".to_owned(),
        theme: Some(TuiTheme::Dark),
        instructions: Some("be kind".to_owned()),
        name: Some("ann".to_owned()),
        compact_window_tokens: Some(150_000),
        ..LaunchRequest::default()
    };
    let spec = ready(harness.launch(&request, None));
    assert_eq!(
        spec.as_ref().ok().and_then(|s| s.session.clone()),
        Some(SessionRef {
            kind: ExternalRefKind::ClaudeSession,
            id: "s-1".to_owned()
        })
    );
    assert_eq!(
        spec.as_ref().ok().and_then(|s| s.theme),
        Some(TuiTheme::Dark)
    );
    assert_eq!(argv_of(spec), golden(LAUNCH));
}

#[test]
fn resumes_the_agents_own_session_reading_instructions_from_their_file() {
    let harness = ClaudeCode::new(deps(wrapped(), Some("plan")));
    let request = LaunchRequest {
        cwd: "/work".to_owned(),
        instructions: Some("x".to_owned()),
        instructions_file: Some("/f".to_owned()),
        ..LaunchRequest::default()
    };
    let session = ExternalRef {
        environment_id: EnvironmentId::parse("env_0190a1b2c3d47abc8def0123456789ab").unwrap(),
        kind: ExternalRefKind::ClaudeSession,
        id: "old".to_owned(),
    };
    let spec = harness.resume(&request, &session, None).map(ready);
    assert_eq!(spec.map(argv_of), Some(golden(RESUME)));
}

#[test]
fn sets_no_status_line_to_leave_claudes_and_bazhens_alone_for_none() {
    let settings = |choice| {
        let harness = ClaudeCode::new(deps(choice, None));
        let argv = argv_of(ready(harness.launch(&LaunchRequest::default(), None)));
        let at = argv
            .iter()
            .position(|a| a == "--settings")
            .map_or(0, |i| i + 1);
        argv.get(at).cloned().unwrap_or_default()
    };
    let leave = settings(StatusLineChoice::Leave);
    let alone = settings(StatusLineChoice::Wrap(None));
    assert!(!leave.contains("statusLine") && !leave.contains("--permission-mode"));
    assert!(
        alone.ends_with(
            r#""statusLine":{"type":"command","command":"bazhen-hook statusline-wrap"}}"#
        )
    );
}

#[test]
fn takes_a_transcript_line_for_a_conversation_entry_only_by_its_own_type() {
    let lines = [
        r#"{"type":"user","isMeta":true,"message":{"role":"user","content":"<command-name>"}}"#,
        r#"{"type":"assistant","message":{"role":"assistant","content":[]}}"#,
        r#"{"type":"attachment","attachment":{}}"#,
        r#"{"type":"system","subtype":"local_command","content":"Kept model"}"#,
        r#"{"type":"mode","mode":"normal"}"#,
        r#"{"type":"permission-mode","permissionMode":"default"}"#,
        r#"{"type":"atis-latch","atis":""}"#,
        r#"{"type":"file-history-snapshot","snapshot":{}}"#,
        r#"{"type":"cost-state","snapshot":{"type":"user"}}"#,
        r#""user""#,
        "null",
        "{not json",
    ];
    let read: Vec<bool> = lines.iter().map(|l| is_conversation_entry(l)).collect();
    let mut expected = vec![true; 4];
    expected.extend([false; 8]);
    assert_eq!(read, expected);
}

/// An adapter whose transcripts hold a conversation when `written`, counting each look.
fn resumable(
    written: Arc<AtomicUsize>,
    looked: Arc<AtomicUsize>,
    now: Arc<AtomicI64>,
) -> ClaudeCode {
    let mut d = deps(StatusLineChoice::Leave, None);
    d.scan_transcript = Box::new(move |path, line| {
        looked.fetch_add(1, Ordering::SeqCst);
        written.load(Ordering::SeqCst) == 1 && path.starts_with('/') && line(r#"{"type":"user"}"#)
    });
    d.now_ms = Box::new(move || now.load(Ordering::SeqCst));
    ClaudeCode::new(d)
}

#[test]
fn resumes_only_once_the_transcript_holds_a_conversation_never_keeping_a_no() {
    let (written, looked, now) = (
        Arc::new(AtomicUsize::new(0)),
        Arc::default(),
        Arc::default(),
    );
    let harness = resumable(Arc::clone(&written), looked, now);
    let asks = |t| harness.can_resume(&Evidence { transcript: t });
    let before = asks(Some("/c/s.jsonl"));
    written.store(1, Ordering::SeqCst);
    assert_eq!(
        [before, asks(Some("/c/s.jsonl")), asks(None)],
        [false, true, false]
    );
}

#[test]
fn looks_at_a_transcript_once_per_check_window_and_again_once_it_has_passed() {
    let (looked, now) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicI64::new(0)));
    let harness = resumable(
        Arc::new(AtomicUsize::new(1)),
        Arc::clone(&looked),
        Arc::clone(&now),
    );
    let asks = || {
        harness.can_resume(&Evidence {
            transcript: Some("/c/s.jsonl"),
        })
    };
    asks();
    now.store(1_999, Ordering::SeqCst);
    asks();
    let within = looked.load(Ordering::SeqCst);
    now.store(2_000, Ordering::SeqCst);
    asks();
    assert_eq!([within, looked.load(Ordering::SeqCst)], [1, 2]);
}

fn agent() -> AgentId {
    AgentId::parse("agent_0190a1b2c3d47abc8def0123456789a1").unwrap()
}

fn ingest(event: &str, payload: &str) -> Ingested {
    ingest_offered(event, payload, &[])
}

fn ingest_offered(event: &str, payload: &str, offered: &[String]) -> Ingested {
    let harness = ClaudeCode::new(deps(StatusLineChoice::Leave, None));
    let agent = agent();
    let context = IngestContext {
        agent: Some(&agent),
        offered,
    };
    harness.ingest(
        Report::Hook {
            event,
            payload: payload.as_bytes(),
        },
        &context,
    )
}

fn facts(ingested: &Ingested) -> Vec<Observed> {
    ingested.observed.iter().map(|k| k.fact.clone()).collect()
}

fn doing(value: ActivityValue) -> Observed {
    Observed::Activity(HarnessActivity::of(value))
}

const READY: Observed = Observed::Ready {
    sign: ReadySign::ClaudeHook,
};

#[test]
fn keys_every_fact_by_the_agent_the_hook_ran_for_and_reads_nothing_without_one() {
    let read = ingest("Stop", r#"{"prompt_id":"p"}"#);
    assert!(read.observed.iter().all(|k| k.key == Key::Agent(agent())));
    let harness = ClaudeCode::new(deps(StatusLineChoice::Leave, None));
    let none = harness.ingest(
        Report::Hook {
            event: "Stop",
            payload: b"{}",
        },
        &IngestContext::default(),
    );
    assert_eq!(none, Ingested::nothing());
    assert_eq!(ingest("Stop", "{not json"), Ingested::nothing());
}

#[test]
fn settles_a_turns_end_before_recording_the_idle_it_reports_and_holds_the_waiter() {
    let at = r#""session_id":"s","prompt_id":"p-1""#;
    let stop = ingest("wait", &format!(r#"{{{at},"hook_event_name":"Stop"}}"#));
    let failed = ingest(
        "wait",
        &format!(r#"{{{at},"hook_event_name":"StopFailure","error":"rate_limit"}}"#),
    );
    assert_eq!(
        facts(&stop),
        [
            READY,
            Observed::TurnEnded {
                prompt_id: Some("p-1".to_owned())
            },
            doing(ActivityValue::Idle)
        ]
    );
    assert_eq!(stop.reply, Reply::Hold(Held::Waiter));
    assert_eq!(
        facts(&failed),
        [
            READY,
            Observed::TurnFailed {
                prompt_id: Some("p-1".to_owned()),
                error: Some("rate_limit".to_owned())
            },
            Observed::Activity(HarnessActivity {
                value: ActivityValue::Failed,
                detail: Some("rate_limit".to_owned()),
                limit: Some(LimitStop::Rate),
            }),
        ]
    );
    assert_eq!(
        facts(&ingest("Stop", r#"{"prompt_id":"p-1"}"#)),
        [
            READY,
            Observed::TurnEnded {
                prompt_id: Some("p-1".to_owned())
            },
            doing(ActivityValue::Idle)
        ]
    );
    assert_eq!(
        facts(&ingest(
            "StopFailure",
            r#"{"prompt_id":"p","error":"server_error"}"#
        ))
        .get(2),
        Some(&Observed::Activity(HarnessActivity {
            value: ActivityValue::Failed,
            detail: Some("server_error".to_owned()),
            limit: None,
        }))
    );
}

#[test]
fn tells_the_waiter_a_session_start_ran_it_which_waits_idle_unless_it_only_compacted() {
    let start = ingest(
        "wait",
        r#"{"hook_event_name":"SessionStart","source":"startup"}"#,
    );
    let compact = ingest(
        "wait",
        r#"{"hook_event_name":"SessionStart","source":"compact"}"#,
    );
    assert_eq!(
        facts(&start),
        [
            READY,
            Observed::SessionStarted { compacted: false },
            doing(ActivityValue::Idle)
        ]
    );
    assert_eq!(
        facts(&compact),
        [
            READY,
            Observed::SessionStarted { compacted: true },
            Observed::Compacted {
                sign: CompactedSign::ClaudeHook
            },
        ]
    );
    assert_eq!(
        facts(&ingest("wait", r#"{"hook_event_name":"UserPromptSubmit"}"#)),
        [READY]
    );
}

#[test]
fn reads_the_model_context_and_each_usage_limit_from_a_status_lines_input() {
    let line = r#"{"model":{"display_name":"Opus 5.5"},"context_window":{"context_window_size":1000000,"used_percentage":12.5},
        "rate_limits":{"seven_day":{"used_percentage":250,"resets_at":1700000000},"five_hour":{"used_percentage":3.5,"resets_at":1.5},
        "group":[{"used_percentage":1}],"bad":{"used_percentage":-1},"2":{"used_percentage":0}}}"#;
    let limit = |window: &str, used, resets: Option<&str>| UsageLimit {
        window: window.to_owned(),
        used_percent: used,
        resets_at: resets.map(str::to_owned),
    };
    assert_eq!(
        facts(&ingest("statusline", line)),
        [Observed::Usage(Usage {
            model: Some("Opus 5.5".to_owned()),
            context_used_percent: Some(13.0),
            context_window_tokens: Some(1_000_000),
            limits: Some(vec![
                limit("2", 0.0, None),
                limit("seven_day", 250.0, Some("2023-11-14T22:13:20.000Z")),
                limit("five_hour", 3.5, None),
            ]),
        })]
    );
    let empty =
        r#"{"context_window":{"context_window_size":0,"used_percentage":null},"rate_limits":[]}"#;
    assert_eq!(
        facts(&ingest("statusline", empty)),
        [Observed::Usage(Usage {
            model: None,
            context_used_percent: None,
            context_window_tokens: None,
            limits: None,
        })]
    );
    let listed = r#"{"rate_limits":[{"used_percentage":1},{"used_percentage":2}]}"#;
    let Some(Observed::Usage(usage)) = facts(&ingest("statusline", listed)).pop() else {
        panic!("no usage")
    };
    assert_eq!(
        usage.limits,
        Some(vec![limit("0", 1.0, None), limit("1", 2.0, None)])
    );
}

const ASKED: &str = r#"{"kind":"permission","summary":"Bash: {\"1\":1e+21,\"2\":true,\"b\":1,\"a\":[1.5,null,\"x\"]}","tool":"[\"sub\",\"p\",\"Bash\",{\"1\":1e+21,\"2\":true,\"b\":1,\"a\":[1.5,null,\"x\"]}]"}"#;

fn tool(key: &str, caller: Option<&str>) -> ToolKey {
    ToolKey {
        key: key.to_owned(),
        caller: caller.map(str::to_owned),
        prompt_id: Some("p".to_owned()),
    }
}

#[test]
fn keys_a_permission_request_as_json_stringify_does_its_call_and_holds_it_for_the_inbox() {
    let payload = r#"{"prompt_id":"p","agent_id":"sub","tool_name":"Bash","tool_input":{"b":1,"a":[1.5,null,"x"],"2":true,"1":1e21}}"#;
    let asked: serde_json::Value = serde_json::from_str(ASKED).unwrap_or_default();
    let key = tool(asked["tool"].as_str().unwrap_or_default(), Some("sub"));
    let read = ingest("PermissionRequest", payload);
    assert_eq!(
        facts(&read),
        [
            doing(ActivityValue::NeedsApproval),
            Observed::ApprovalAsked {
                key: key.clone(),
                summary: asked["summary"].as_str().unwrap_or_default().to_owned(),
            },
        ]
    );
    assert_eq!(
        read.reply,
        Reply::Hold(Held::Approval {
            key,
            wait_ms: 50_000
        })
    );
}

#[test]
fn ties_a_permission_request_to_the_call_that_started_it_and_that_calls_result_to_both() {
    let call = r#""prompt_id":"p","tool_name":"Bash","tool_input":{"command":"touch x"}"#;
    let key = tool(r#"["main","p","Bash",{"command":"touch x"}]"#, None);
    assert!(key.main_agent());
    assert_eq!(
        facts(&ingest(
            "PreToolUse",
            &format!(r#"{{{call},"tool_use_id":"t-1"}}"#)
        )),
        [
            doing(ActivityValue::Working),
            Observed::ToolStarted {
                key: key.clone(),
                use_id: "t-1".to_owned()
            }
        ]
    );
    assert_eq!(
        facts(&ingest("PermissionRequest", &format!("{{{call}}}"))).pop(),
        Some(Observed::ApprovalAsked {
            key,
            summary: r#"Bash: {"command":"touch x"}"#.to_owned()
        })
    );
    let failed = ingest(
        "PostToolUseFailure",
        &format!(r#"{{{call},"tool_use_id":"t-1"}}"#),
    );
    assert_eq!(
        facts(&failed),
        [
            doing(ActivityValue::Working),
            Observed::ToolSettled {
                use_id: "t-1".to_owned()
            }
        ]
    );
    assert_eq!(failed.reply, Reply::Quiet);
    assert_eq!(facts(&ingest("PreToolUse", "{}")), []);
}

#[test]
fn folds_mail_into_the_turn_at_a_post_tool_use_that_names_its_prompt() {
    let fold = ingest("PostToolUse", r#"{"prompt_id":"p-1","tool_use_id":"t-1"}"#);
    assert_eq!(
        facts(&fold),
        [
            doing(ActivityValue::Working),
            Observed::ToolSettled {
                use_id: "t-1".to_owned()
            },
            READY
        ]
    );
    assert_eq!(
        fold.reply,
        Reply::Hold(Held::Fold {
            prompt_id: "p-1".to_owned()
        })
    );
    assert_eq!(
        ingest("PostToolUse", r#"{"tool_use_id":"t-1"}"#).reply,
        Reply::Quiet
    );
}

#[test]
fn reports_the_agents_own_send_and_none_by_a_subagent_a_structured_message_or_another_tool() {
    let send = |extra: &str, input: &str| {
        let payload = format!(
            r#"{{"prompt_id":"p","tool_use_id":"t","tool_name":"SendMessage","tool_input":{input},"tool_response":{{"success":true}}{extra}}}"#
        );
        facts(&ingest("PostToolUse", &payload))
            .into_iter()
            .find(|f| matches!(f, Observed::MessageObserved { .. }))
    };
    assert_eq!(
        send("", r#"{"to":"Bob","message":"hi","summary":""}"#),
        Some(Observed::MessageObserved {
            use_id: "t".to_owned(),
            sent: SentMessage {
                to: "Bob".to_owned(),
                text: "hi".to_owned(),
                summary: None,
                accepted: true,
            }
        })
    );
    assert_eq!(
        send(r#","agent_id":null"#, r#"{"to":"Bob","message":"hi"}"#),
        None
    );
    assert_eq!(
        send("", r#"{"to":"Bob","message":{"type":"shutdown"}}"#),
        None
    );
    assert_eq!(send("", r#"{"to":"","message":"hi"}"#), None);
}

#[test]
fn reads_a_question_for_the_human_as_one_only_the_tui_can_answer() {
    let asked = r#"{"prompt_id":"p","tool_name":"AskUserQuestion","tool_input":{"questions":[{"question":"A?"},{"q":1},{"question":"B?"}]}}"#;
    let read = ingest("PermissionRequest", asked);
    let Some(Observed::QuestionAsked { summary, .. }) = facts(&read).pop() else {
        panic!("no usage")
    };
    assert_eq!((summary.as_str(), &read.reply), ("A? / B?", &Reply::Quiet));
    assert_eq!(
        facts(&read).first(),
        Some(&doing(ActivityValue::WaitingInput))
    );
    let bare = ingest("PermissionRequest", r#"{"tool_name":"AskUserQuestion"}"#);
    assert!(
        matches!(facts(&bare).pop(), Some(Observed::QuestionAsked { summary, .. }) if summary == "The agent asks you a question")
    );
}

#[test]
fn reads_a_prompt_and_which_offered_messages_it_carries_as_a_wake_handed_them_over() {
    let prompt = r"<task-notification>Message for you from Bazhen (msg_a1):\nhi</task-notification> and msg_b2";
    let offered = ["msg_a1".to_owned(), "msg_b2".to_owned()];
    let read = ingest_offered(
        "UserPromptSubmit",
        &format!(r#"{{"prompt":"{prompt}","prompt_id":"p-1"}}"#),
        &offered,
    );
    assert_eq!(
        facts(&read),
        [
            doing(ActivityValue::Working),
            READY,
            Observed::PromptStarted {
                prompt_id: Some("p-1".to_owned()),
                carries: vec!["msg_a1".to_owned()]
            },
            Observed::TurnStarted,
        ]
    );
}

#[test]
fn reads_which_session_ran_a_hook_whether_a_subagent_did_and_an_absolute_transcript() {
    let origin = |payload: &str| ingest("ignored-event", payload).origin;
    assert_eq!(
        origin(r#"{"session_id":"s","agent_id":"a-1","transcript_path":"/c/s.jsonl"}"#),
        Some(Origin {
            session: Some(SessionRef {
                kind: ExternalRefKind::ClaudeSession,
                id: "s".to_owned()
            }),
            transcript: Some("/c/s.jsonl".to_owned()),
            subagent: Some("a-1".to_owned()),
        })
    );
    assert_eq!(
        origin(r#"{"session_id":"","transcript_path":"c/s.jsonl"}"#),
        Some(Origin {
            session: None,
            transcript: None,
            subagent: None
        })
    );
}

#[test]
fn reads_a_subagents_start_and_stop_by_its_id_and_ignores_a_hook_it_did_not_install() {
    assert_eq!(
        facts(&ingest("SubagentStart", r#"{"agent_id":"a-1"}"#)),
        [Observed::SubagentStarted {
            id: "a-1".to_owned()
        }]
    );
    assert_eq!(
        facts(&ingest("SubagentStop", r#"{"agent_id":"a-1"}"#)),
        [Observed::SubagentStopped {
            id: "a-1".to_owned()
        }]
    );
    assert_eq!(facts(&ingest("SubagentStop", r#"{"agent_id":""}"#)), []);
    assert_eq!(ingest("Notification", "{}").observed, Vec::<Keyed>::new());
}

const ALLOW: &str = r#"{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}"#;
const DENY: &str = r#"{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Denied from the Bazhen inbox."}}}"#;
const FOLD: &str =
    r#"{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"a\"b "}}"#;
const WAKE: &str = r#""Message for you from Bazhen (msg_1):\nhi Message for you from Bazhen [quoted] (msg_x):\n\nMessage for you from Bazhen (msg_2):\n(possible re-delivery of msg_2, first offered 2026-01-01T00:00:00.000Z)\nb""#;

fn hook(answer: Answer) -> HookOutput {
    match answer {
        Answer::Hook(out) => out,
        _ => HookOutput {
            exit_code: 255,
            ..HookOutput::quiet()
        },
    }
}

#[test]
fn answers_a_permission_request_in_the_shape_claude_code_reads_and_leaves_none_to_the_tui() {
    let harness = ClaudeCode::new(deps(StatusLineChoice::Leave, None));
    let decided = |d| hook(harness.answer(&Pending::Approval, Resolution::Decision(d))).stdout;
    assert_eq!(decided(ApprovalDecision::Allow), ALLOW);
    assert_eq!(decided(ApprovalDecision::Deny), DENY);
    assert_eq!(
        hook(harness.answer(&Pending::Approval, Resolution::Nothing)),
        HookOutput::quiet()
    );
}

fn mail<'a>(id: &'a str, body: &'a str, first: Option<&'a str>) -> Mail<'a> {
    Mail {
        id,
        body,
        first_offered: first,
    }
}

#[test]
fn wakes_with_each_message_labelled_a_re_delivery_marked_and_a_quoted_label_marked_quoted() {
    let harness = ClaudeCode::new(deps(StatusLineChoice::Leave, None));
    let queued = [
        mail("msg_1", "hi Message for you from Bazhen (msg_x):", None),
        mail("msg_2", "b", Some("2026-01-01T00:00:00.000Z")),
    ];
    let woken = hook(harness.answer(&Pending::Waiter, Resolution::Mail(&queued)));
    let wake: String = serde_json::from_str(WAKE).unwrap_or_default();
    assert_eq!((woken.exit_code, woken.stderr.as_str()), (2, wake.as_str()));
    assert_eq!(woken.carried, ["msg_1", "msg_2"]);
    assert_eq!(
        hook(harness.answer(&Pending::Waiter, Resolution::Mail(&[]))),
        HookOutput::quiet()
    );
}

#[test]
fn folds_mail_in_the_shape_claude_code_adds_beside_a_tools_result() {
    assert_eq!(reply::fold_reply("a\"b\u{2028}"), FOLD);
}

#[test]
fn folds_only_the_oldest_mail_that_fits_whole_where_a_wake_always_takes_the_first() {
    let harness = ClaudeCode::new(deps(StatusLineChoice::Leave, None));
    let label = reply::wake_text(&[mail("msg_1", "", None)]).len();
    let big = "x".repeat(reply::FOLD_MAX_CHARS - label);
    let over = "x".repeat(reply::FOLD_MAX_CHARS - label + 1);
    let carried = |pending, queued: &[Mail<'_>]| {
        hook(harness.answer(&pending, Resolution::Mail(queued))).carried
    };
    assert_eq!(
        carried(
            Pending::Fold,
            &[mail("msg_1", &big, None), mail("msg_2", "", None)]
        ),
        ["msg_1"]
    );
    assert_eq!(
        carried(Pending::Fold, &[mail("msg_1", &over, None)]),
        Vec::<String>::new()
    );
    let huge = "x".repeat(HOOK_REPLY_MAX_BYTES);
    assert_eq!(
        carried(
            Pending::Waiter,
            &[mail("msg_1", &huge, None), mail("msg_2", "", None)]
        ),
        ["msg_1"]
    );
    let many: Vec<Mail<'_>> = (0..101).map(|_| mail("msg_1", "", None)).collect();
    assert_eq!(carried(Pending::Waiter, &many).len(), 100);
}

#[test]
fn says_mail_reaches_the_waiter_and_a_turn_only_while_working() {
    let harness = ClaudeCode::new(deps(StatusLineChoice::Leave, None));
    let listens = |hooks, activity| {
        harness.listening(&Listen {
            activity,
            hooks,
            bound: true,
            held: false,
        })
    };
    assert_eq!(
        [
            listens(Waiting::Waiter, None),
            listens(Waiting::Turn, Some(ActivityValue::Working)),
            listens(Waiting::Turn, Some(ActivityValue::Idle)),
            listens(Waiting::Nothing, Some(ActivityValue::Working)),
        ],
        [true, true, false, false]
    );
}
