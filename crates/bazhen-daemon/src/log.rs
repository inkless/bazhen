//! The daemon's log: each line as `console.log` and `console.error` print it in the TypeScript
//! daemon, the message alone, on stderr, which `start` appends to `state/daemon.log`.

/// Sends every event's message to stderr. A subscriber already set keeps logging.
pub(crate) fn init() {
    let subscriber = tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .without_time()
        .with_level(false)
        .with_target(false)
        .finish();
    let _ = tracing::subscriber::set_global_default(subscriber);
}
