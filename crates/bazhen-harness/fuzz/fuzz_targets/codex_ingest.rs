#![no_main]

use bazhen_harness::{
    AgentId, Gate, HarnessDeps, HarnessId, IngestContext, Ingested, Key, Observed, Reply, Report,
    compiled,
};
use libfuzzer_sys::fuzz_target;

// One notification, request or terminal title from Codex's app-server, as a server could send
// it: no report may panic the adapter, text that isn't JSON says nothing, every fact is about a
// thread, the account or the agent a title is for, nothing is gated, and nothing is held.
fuzz_target!(|input: (u8, &str, &[u8], &str)| {
    let (kind, method, params, text) = input;
    let harnesses = compiled(HarnessDeps {
        new_session_id: Box::new(String::new),
        hook_command: String::new(),
        daemon_env: Box::new(|_| None),
        user_env: Box::new(|_| None),
        home: "/home/u".to_owned(),
        read_file: Box::new(|_| None),
        scan_transcript: Box::new(|_, _| false),
        now_ms: Box::new(|| 0),
        daemon_socket: String::new(),
        real_path: Box::new(|_| None),
    });
    let codex = harnesses
        .get(HarnessId::Codex)
        .expect("Codex is compiled in");
    let agent = AgentId::parse("agent_0190a1b2c3d47abc8def0123456789a1").expect("an agent id");
    let context = IngestContext {
        agent: (kind & 4 == 0).then_some(&agent),
        offered: &[],
        session: None,
    };
    let report = match kind % 4 {
        0 => Report::Notification { method, params },
        1 => Report::ServerRequest {
            method,
            params,
            id: text,
        },
        2 => Report::TerminalTitle { title: text },
        _ => Report::Hook {
            event: method,
            payload: params,
        },
    };
    let read = codex.ingest(report, &context);
    // serde_json refuses text JavaScript reads: a lone surrogate's escape, a byte that isn't
    // UTF-8, nesting past its limit. Text with none of them that it refuses isn't JSON.
    let plain = !params.contains(&b'\\')
        && std::str::from_utf8(params).is_ok()
        && params.iter().filter(|&&b| b == b'[' || b == b'{').count() < 128;
    let not_json = plain && serde_json::from_slice::<serde_json::Value>(params).is_err();
    if matches!(report, Report::Hook { .. }) || (not_json && kind % 4 < 2) {
        assert_eq!(read, Ingested::nothing());
    }
    assert_eq!((read.origin.clone(), read.reply_gate), (None, Gate::None));
    for keyed in &read.observed {
        assert_eq!(keyed.gate, Gate::None);
        match (&keyed.key, &keyed.fact) {
            (Key::Agent(id), _) => assert!(kind % 4 == 2 && *id == agent),
            (Key::Account, Observed::AccountLimits(_) | Observed::SessionAnnounced { .. }) => {}
            (Key::Session(_), _) => assert!(kind % 4 < 2),
            other => panic!("{other:?}"),
        }
    }
    assert_eq!(read.reply, Reply::Quiet);
});
