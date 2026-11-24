#![no_main]

use bazhen_protocol::edge::{EdgeCheck, edge};
use bazhen_protocol::notices::{DismissNoticeRequest, PairRequest};
use bazhen_protocol::shells::{
    CloseShellRequest, OpenShellRequest, RenameShellRequest, RestartShellRequest, ShellDecline,
    ShellPrompt, ShellReport,
};
use bazhen_protocol::tasks::CreateTaskRequest;
use libfuzzer_sys::fuzz_target;
use serde::Serialize;
use serde::de::DeserializeOwned;

/// A request the edge takes, written back out, is taken again as itself: zod parses what it
/// parsed to the same value.
fn settled<T: DeserializeOwned + Serialize + EdgeCheck + PartialEq + std::fmt::Debug>(body: &[u8]) {
    if let Ok(taken) = edge::<T>(body) {
        let written = serde_json::to_vec(&taken).unwrap();
        let again = edge::<T>(&written).unwrap();
        assert!(again == taken, "{again:?} != {taken:?}");
    }
}

// Any bytes at all, as a request's body could hold them: nothing panics, and what each request
// takes it takes again unchanged.
fuzz_target!(|body: &[u8]| {
    settled::<CreateTaskRequest>(body);
    settled::<OpenShellRequest>(body);
    settled::<CloseShellRequest>(body);
    settled::<RestartShellRequest>(body);
    settled::<RenameShellRequest>(body);
    settled::<DismissNoticeRequest>(body);
    settled::<PairRequest>(body);
    settled::<ShellReport>(body);
    settled::<ShellPrompt>(body);
    settled::<ShellDecline>(body);
});
