#![no_main]

use bazhen_protocol::agents::{CloseAgentRequest, SignalAgentRequest};
use bazhen_protocol::edge::{EdgeCheck, edge, is_object, object};
use bazhen_protocol::notices::{DismissNoticeRequest, PairRequest};
use bazhen_protocol::shells::{
    CloseShellRequest, OpenShellRequest, RenameShellRequest, RestartShellRequest, ShellDecline,
    ShellPrompt, ShellReport, UnlinkShellRequest,
};
use bazhen_protocol::tasks::CreateTaskRequest;
use libfuzzer_sys::fuzz_target;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

/// A request the edge takes, written back out, is taken again as itself. This holds the edge to
/// its own reading, not to zod's: the planted corpus holds it to zod's.
fn settled<T: DeserializeOwned + Serialize + EdgeCheck + PartialEq + std::fmt::Debug>(body: &[u8]) {
    if let Ok(taken) = edge::<T>(body) {
        let written = serde_json::to_vec(&taken).unwrap();
        let again = edge::<T>(&written).unwrap();
        assert!(again == taken, "{again:?} != {taken:?}");
    }
}

/// Whatever JSON `body` is, the edge calls it an object exactly when it is one, and reads exactly
/// those.
fn objects_alone(body: &[u8]) {
    let read = serde_json::from_slice::<Value>(body).ok();
    if let Some(read) = &read {
        assert_eq!(is_object(body), read.is_object(), "{read}");
    }
    assert_eq!(
        object::<Value>(body).is_ok(),
        read.as_ref().is_some_and(Value::is_object)
    );
}

// Any bytes at all, as a request's body could hold them: nothing panics, only an object is read,
// and what each request takes it takes again unchanged.
fuzz_target!(|body: &[u8]| {
    objects_alone(body);
    settled::<CreateTaskRequest>(body);
    settled::<OpenShellRequest>(body);
    settled::<CloseShellRequest>(body);
    settled::<RestartShellRequest>(body);
    settled::<RenameShellRequest>(body);
    settled::<UnlinkShellRequest>(body);
    settled::<CloseAgentRequest>(body);
    settled::<SignalAgentRequest>(body);
    settled::<DismissNoticeRequest>(body);
    settled::<PairRequest>(body);
    settled::<ShellReport>(body);
    settled::<ShellPrompt>(body);
    settled::<ShellDecline>(body);
});
