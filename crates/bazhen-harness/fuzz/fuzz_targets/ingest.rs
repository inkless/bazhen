#![no_main]

use bazhen_harness::{
    AgentId, Gate, HarnessDeps, HarnessId, Held, IngestContext, Ingested, Key, Observed, Reply,
    Report, production,
};
use libfuzzer_sys::fuzz_target;
use serde::de::IgnoredAny;

/// The key serde_json's `Value` takes for a raw value's: `serde_json::raw::TOKEN`, which it
/// doesn't export.
const RAW_VALUE_KEY: &[u8] = b"$serde_json::private::RawValue";

// A hook's event and payload, as a hook client could post them: no report may panic the
// adapter, text that isn't JSON says nothing, every fact is about the agent the hook ran for, a
// report is held open only by the hook that waits for its answer, and each tool call's key is the
// JSON of who made it, in which prompt, and the call.
fuzz_target!(|input: (&str, &[u8])| {
    let (event, payload) = input;
    let harnesses = production(HarnessDeps {
        new_session_id: Box::new(|| "s".to_owned()),
        hook_command: "bazhen-hook".to_owned(),
        daemon_env: Box::new(|_| None),
        user_env: Box::new(|_| None),
        home: "/home/u".to_owned(),
        read_file: Box::new(|_| None),
        scan_transcript: Box::new(|_, _| false),
        now_ms: Box::new(|| 0),
        daemon_socket: String::new(),
        real_path: Box::new(|_| None),
    });
    let claude = harnesses
        .get(HarnessId::ClaudeCode)
        .expect("Claude Code is served");
    let agent = AgentId::parse("agent_0190a1b2c3d47abc8def0123456789a1").expect("an agent id");
    let offered = ["msg_1".to_owned()];
    let context = IngestContext {
        agent: Some(&agent),
        offered: &offered,
        session: None,
    };
    let read = claude.ingest(Report::Hook { event, payload }, &context);
    // serde_json refuses text JavaScript reads: a lone surrogate's escape, a byte that isn't
    // UTF-8, nesting past its limit, and, with the workspace's `raw_value`, an object whose first
    // key is its raw value's private name, whose value it reads again as JSON text. Text with none
    // of them that it refuses isn't JSON.
    let plain = !payload.contains(&b'\\')
        && std::str::from_utf8(payload).is_ok()
        && payload.iter().filter(|&&b| b == b'[' || b == b'{').count() < 128
        && !payload
            .windows(RAW_VALUE_KEY.len())
            .any(|w| w == RAW_VALUE_KEY);
    if plain && serde_json::from_slice::<serde_json::Value>(payload).is_err() {
        assert_eq!(read, Ingested::nothing());
        return;
    }
    assert!(
        read.observed
            .iter()
            .all(|k| k.key == Key::Agent(agent.clone()))
    );
    match &read.reply {
        Reply::Hold(Held::Waiter) => assert_eq!(event, "wait"),
        Reply::Hold(Held::Fold { .. }) => assert_eq!(event, "PostToolUse"),
        Reply::Hold(Held::Approval { wait_ms, .. }) => {
            assert_eq!((event, *wait_ms), ("PermissionRequest", Some(50_000)));
        }
        Reply::Quiet => {}
        Reply::Now(_) => panic!("Claude Code answers no hook before the daemon resolves it"),
    }
    // Only a waiter or a fold is held for the agent's own session alone, and mail and turns are
    // taken only from it.
    let held_for_owner = matches!(read.reply, Reply::Hold(Held::Waiter | Held::Fold { .. }));
    assert_eq!(read.reply_gate == Gate::Owner, held_for_owner);
    for k in &read.observed {
        let owners = matches!(
            k.fact,
            Observed::Ready { .. }
                | Observed::PromptStarted { .. }
                | Observed::TurnStarted
                | Observed::TurnEnded { .. }
                | Observed::TurnFailed { .. }
                | Observed::MessageObserved { .. }
                | Observed::SessionStarted { .. }
        );
        assert!(!owners || k.gate == Gate::Owner, "{k:?}");
        let in_session = matches!(
            k.fact,
            Observed::Activity(_)
                | Observed::Usage(_)
                | Observed::SubagentStarted { .. }
                | Observed::SubagentStopped { .. }
        );
        assert!(!in_session || k.gate != Gate::None, "{k:?}");
        let anyones = matches!(k.fact, Observed::TurnOver | Observed::SubagentOver { .. });
        assert!(!anyones || k.gate == Gate::None, "{k:?}");
    }
    let activities = read
        .observed
        .iter()
        .filter(|k| matches!(k.fact, Observed::Activity(_)));
    assert!(activities.count() <= 1);
    for fact in read.observed.iter().map(|k| &k.fact) {
        let key = match fact {
            Observed::ToolStarted { key, .. }
            | Observed::ApprovalAsked { key, .. }
            | Observed::QuestionAsked { key, .. } => key,
            _ => continue,
        };
        let mut text = serde_json::Deserializer::from_str(&key.key);
        text.disable_recursion_limit();
        // The call is passed over, not read as a `Value`, which would read a tool input whose
        // first key is serde_json's raw value's name as JSON text.
        let (caller, prompt_id, _, _): (String, Option<String>, IgnoredAny, IgnoredAny) =
            serde::Deserialize::deserialize(&mut text).expect("a tool key is a JSON array of four");
        assert_eq!(caller, key.caller.as_deref().unwrap_or("main"));
        assert_eq!(prompt_id.as_deref(), key.prompt_id.as_deref());
    }
});
