#![no_main]

use bazhen_store::{EVENT_KINDS, StoredEvent};
use libfuzzer_sys::fuzz_target;

// A stored row of any registered type holding any payload text, as a database another daemon or a
// fault left could: framing it never panics, and a frame sends only the keys its type streams.
fuzz_target!(|bytes: &[u8]| {
    let Some((&pick, payload)) = bytes.split_first() else {
        return;
    };
    let Some(kind) = EVENT_KINDS.get(usize::from(pick) % EVENT_KINDS.len()) else {
        return;
    };
    let event = StoredEvent {
        id: 1,
        ts: "2026-11-01T00:00:00.000Z".to_owned(),
        kind: kind.name.to_owned(),
        entity_type: kind.entity.to_owned(),
        entity_id: "e".to_owned(),
        actor: "human".to_owned(),
        causation_id: None,
        correlation_id: None,
        payload: String::from_utf8_lossy(payload).into_owned(),
    };
    if let Ok(frame) = event.frame() {
        let frame: serde_json::Value = serde_json::from_str(&frame).expect("a frame is JSON");
        let sent = frame["event"]["payload"]
            .as_object()
            .expect("a payload is an object");
        assert!(
            sent.keys().all(|k| kind.streamed.contains(&k.as_str())),
            "{frame}"
        );
    }
});
