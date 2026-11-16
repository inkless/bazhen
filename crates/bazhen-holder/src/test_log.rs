//! What `tracing` writes while a test's body runs, for the tests that hold a warning to being
//! logged: an operator's only sign of what the holder couldn't do.

use std::io::Read as _;

/// What `tracing` wrote while `body` ran, on this thread: a few lines, which a pipe's buffer holds.
pub(crate) fn logged(body: impl FnOnce()) -> String {
    let (mut reader, writer) = std::io::pipe().unwrap();
    let subscriber = tracing_subscriber::fmt()
        .with_writer(move || writer.try_clone().unwrap())
        .with_ansi(false)
        .finish();
    // The subscriber, and with it the last of the pipe's writers, is dropped as this returns.
    tracing::subscriber::with_default(subscriber, body);
    let mut log = String::new();
    reader.read_to_string(&mut log).unwrap();
    log
}
