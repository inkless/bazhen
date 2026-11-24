#![no_main]

use bazhen_harness::{
    AgentId, HarnessDeps, HarnessId, Held, IngestContext, Ingested, Key, Observed, Reply, Report,
    StatusLineChoice, production,
};
use libfuzzer_sys::fuzz_target;

// A hook's event and payload, as a hook client could post them: no report may panic the
// adapter, text that isn't JSON says nothing, every fact is about the agent the hook ran for, a
// report is held open only by the hook that waits for its answer, and each tool call's key is the
// JSON of who made it, in which prompt, and the call.
fuzz_target!(|input: (&str, &[u8])| {
    let (event, payload) = input;
    let harnesses = production(HarnessDeps {
        new_session_id: Box::new(|| "s".to_owned()),
        hook_command: "bazhen-hook".to_owned(),
        permission_mode: None,
        status_line: Box::new(|_| StatusLineChoice::Leave),
        scan_transcript: Box::new(|_, _| false),
        now_ms: Box::new(|| 0),
    });
    let claude = harnesses
        .get(HarnessId::ClaudeCode)
        .expect("Claude Code is served");
    let agent = AgentId::parse("agent_0190a1b2c3d47abc8def0123456789a1").expect("an agent id");
    let offered = ["msg_1".to_owned()];
    let context = IngestContext {
        agent: Some(&agent),
        offered: &offered,
    };
    let read = claude.ingest(Report::Hook { event, payload }, &context);
    if serde_json::from_slice::<serde_json::Value>(payload).is_err() {
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
            assert_eq!((event, *wait_ms), ("PermissionRequest", 50_000));
        }
        Reply::Quiet => {}
        Reply::Now(_) => panic!("Claude Code answers no hook before the daemon resolves it"),
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
        let parts: Vec<serde_json::Value> =
            serde_json::from_str(&key.key).expect("a tool key is a JSON array");
        assert_eq!(parts.len(), 4);
        assert_eq!(
            parts[0].as_str(),
            Some(key.caller.as_deref().unwrap_or("main"))
        );
        assert_eq!(parts[1].as_str(), key.prompt_id.as_deref());
    }
});
