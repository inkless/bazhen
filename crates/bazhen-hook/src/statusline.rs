//! `bazhen-hook statusline-wrap [command…]`: the status line Bazhen gives a Claude Code agent.
//! Claude Code runs one status line command, so this one runs the user's own (`command…`, as
//! the adapter found it in their settings) with the same input and passes its output through
//! unchanged, and hands that input to the daemon, which reads the model and context-window use
//! from it (foundation-design §11.2). The daemon never holds the status line up: it gets a short
//! bound, and outside a Bazhen agent, or on any failure, it is skipped.

use crate::{hook_request, is_token, post};
use std::env;
use std::io::{self, Read, Write};
use std::os::unix::process::{ExitStatusExt, parent_id};
use std::process::{Command, Stdio, id};
use std::time::Duration;

/// The daemon is told in passing; a status line redraws often, and never waits on it for long.
const REPORT_DEADLINE: Duration = Duration::from_millis(200);

pub(crate) fn run(command: impl Iterator<Item = String>) -> Option<i32> {
    let mut input = Vec::new();
    io::stdin().read_to_end(&mut input).ok()?;
    let user = command.collect::<Vec<_>>();
    // The user's command first, so its line is drawn however long the report takes.
    let child = match user.split_first() {
        Some((program, args)) => Command::new(program)
            .args(args)
            .stdin(Stdio::piped())
            .spawn()
            .ok()
            .map(|mut child| {
                if let Some(mut stdin) = child.stdin.take() {
                    // A command that exits without reading its input still draws its line.
                    let _ = stdin.write_all(&input);
                }
                child
            }),
        None => None,
    };
    report(&input);
    // A command a signal ended exits as a shell reports it, 128 plus the signal.
    let code = child
        .and_then(|mut c| c.wait().ok())
        .and_then(|status| status.code().or(status.signal().map(|n| 128 + n)))
        .unwrap_or(0);
    io::stdout().flush().ok()?;
    Some(code)
}

/// Hands the status line's input to the daemon as the `statusline` hook, ignoring its reply.
fn report(input: &[u8]) -> Option<()> {
    let agent = env::var("BAZHEN_AGENT_ID").ok()?;
    let socket = env::var("BAZHEN_SOCKET").ok()?;
    if !is_token(&agent) {
        return None;
    }
    let request = hook_request(input, &agent, "statusline", id(), parent_id());
    post(&socket, "/v1/hooks", &request, REPORT_DEADLINE).ok()?;
    Some(())
}
