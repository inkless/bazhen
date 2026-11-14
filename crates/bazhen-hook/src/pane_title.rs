//! `bazhen-hook pane-title <socket> <pane>`: what tmux runs, through Bazhen's
//! `pane-title-changed` hook, when a pane's title changes. A Codex TUI titles its pane with the
//! thread it shows, so the daemon learns of `/new`, `/fork` and `/resume` (foundation-design
//! §5.8). It names the pane and nothing else: the daemon reads the title itself. It runs outside
//! any agent, so the socket is an argument, and like every hook it fails quietly.

use crate::{ACK_DEADLINE, post};

pub(crate) fn run(mut args: impl Iterator<Item = String>) -> Option<i32> {
    let socket = args.next()?;
    let pane = args.next()?;
    post(&socket, "/v1/codex/pane-title", &body(&pane)?, ACK_DEADLINE).ok()?;
    Some(0)
}

/// The request's JSON, for a tmux pane id (`%12`) only, which needs no escaping.
pub fn body(pane: &str) -> Option<Vec<u8>> {
    let digits = pane.strip_prefix('%')?;
    let is_pane = !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit());
    is_pane.then(|| format!("{{\"pane\":\"{pane}\"}}").into_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_a_tmux_pane() {
        assert_eq!(body("%12").as_deref(), Some(&b"{\"pane\":\"%12\"}"[..]));
    }

    #[test]
    fn refuses_anything_but_a_pane_id() {
        for pane in ["", "%", "12", "%1a", "%1\"", "%-1", "@3"] {
            assert_eq!(body(pane), None, "{pane:?}");
        }
    }
}
