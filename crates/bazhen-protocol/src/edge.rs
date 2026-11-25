//! What the daemon's edge takes: a request as serde reads it, held to every rule zod holds it to
//! past its shape, and given back as zod parses it. A message's edge verdict is [`edge`]: its
//! decode, then its [`EdgeCheck`].
//!
//! zod counts a string's length in code points, so the edge does too. The daemon's handlers take
//! their verdict from here: each reads its request as it words a refusal, then holds it to the
//! [`EdgeCheck`] here. A task's creation, which names every rule it breaks as zod does, holds each
//! field to the rule this module names for it.

use serde::de::DeserializeOwned;

use crate::agents::{CloseAgentRequest, RespawnAgentRequest, SignalAgentRequest};
use crate::ids::TaskId;
use crate::mail::{HookAck, HookRequest};
use crate::notices::{DEVICE_NAME_MAX, DismissNoticeRequest, PAIRING_CODE_TYPED_MAX, PairRequest};
use crate::shells::{
    CloseShellRequest, OpenShellRequest, RenameShellRequest, RestartShellRequest,
    SHELL_NAME_MAX_CHARS, ShellDecline, ShellPrompt, ShellReport, UnlinkShellRequest,
};
use crate::tasks::CreateTaskRequest;
use crate::text::{TASK_BRIEF_MAX_CHARS, TASK_TITLE_MAX_CHARS, showable, title_safe, trim};

/// The most code points an idempotency key has.
pub const IDEMPOTENCY_KEY_MAX_CHARS: usize = 200;

/// The most code points the program a close confirms names.
pub const CONFIRMED_PROGRAM_MAX_CHARS: usize = 200;

/// The largest integer a JSON number holds exactly, which zod's `.int()` takes at most.
pub const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

/// Why the edge refuses a request: the rule it breaks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refused(pub String);

impl std::fmt::Display for Refused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// A request's rules past what serde reads.
pub trait EdgeCheck: Sized {
    /// The request as zod parses it, or the first rule it breaks.
    ///
    /// # Errors
    ///
    /// [`Refused`], naming the rule.
    fn checked(self) -> Result<Self, Refused>;
}

/// `body` as the edge takes the request `T`.
///
/// # Errors
///
/// [`Refused`], when `body` isn't a JSON object, serde can't read it as a `T`, or it breaks one of
/// `T`'s rules.
pub fn edge<T: DeserializeOwned + EdgeCheck>(body: &[u8]) -> Result<T, Refused> {
    object::<T>(body)?.checked()
}

/// The rule every request body holds to, as a refusal names it.
pub const OBJECT_RULE: &str = "the body is not a JSON object";

/// Whether `body` is a JSON object as `serde_json` reads JSON, if it is JSON at all: its first
/// byte past JSON's whitespace opens one. serde's derive reads a struct from an array as well,
/// which zod's `z.object` refuses.
#[must_use]
pub fn is_object(body: &[u8]) -> bool {
    body.iter()
        .find(|byte| !matches!(byte, b' ' | b'\t' | b'\n' | b'\r'))
        == Some(&b'{')
}

/// `body` read as `T`, if it is a JSON object.
///
/// # Errors
///
/// [`Refused`], naming [`OBJECT_RULE`] when `body` isn't an object, or serde's error when it
/// can't read it as a `T`.
pub fn object<T: DeserializeOwned>(body: &[u8]) -> Result<T, Refused> {
    if !is_object(body) {
        return Err(Refused(OBJECT_RULE.to_owned()));
    }
    serde_json::from_slice(body).map_err(|err| Refused(err.to_string()))
}

/// A string's length as zod counts it: in code points.
fn chars(text: &str) -> usize {
    text.chars().count()
}

fn holds(holds: bool, rule: &str) -> Result<(), Refused> {
    if holds {
        Ok(())
    } else {
        Err(Refused(rule.to_owned()))
    }
}

/// The rule an idempotency key holds to, as a refusal names it.
pub const KEY_RULE: &str = "idempotencyKey is 1 to 200 characters";

/// The rule a task's title holds to, as a refusal names it.
pub const TITLE_RULE: &str = "title is 1 to 200 characters once trimmed, with no control \
                              characters, bidirectional overrides or invisible ones";

/// The rule a task's brief holds to, as a refusal names it.
pub const BRIEF_RULE: &str = "brief is 1 to 20000 characters";

/// The rule a task's parent holds to, as a refusal names it.
pub const PARENT_RULE: &str = "parentTaskId is a task id";

/// Whether `key` is an idempotency key: 1 to 200 code points.
#[must_use]
pub fn is_key(key: &str) -> bool {
    (1..=IDEMPOTENCY_KEY_MAX_CHARS).contains(&chars(key))
}

/// Whether `title`, as given, is the length a task's title is: 1 to 200 code points.
#[must_use]
pub fn is_task_title_length(title: &str) -> bool {
    (1..=TASK_TITLE_MAX_CHARS).contains(&chars(title))
}

/// A task's title, trimmed, if it holds to `NewTaskTitle`.
#[must_use]
pub fn task_title(text: &str) -> Option<&str> {
    let text = trim(text);
    (is_task_title_length(text) && title_safe(text)).then_some(text)
}

/// Whether `brief` is a task's brief: 1 to 20000 code points.
#[must_use]
pub fn is_task_brief(brief: &str) -> bool {
    (1..=TASK_BRIEF_MAX_CHARS).contains(&chars(brief))
}

fn keyed(key: &str) -> Result<(), Refused> {
    holds(is_key(key), KEY_RULE)
}

/// A shell's name, trimmed, if it holds to `ShellName`.
fn named(text: &str) -> Option<&str> {
    let text = trim(text);
    ((1..=SHELL_NAME_MAX_CHARS).contains(&chars(text)) && showable(text)).then_some(text)
}

fn generation(generation: u64) -> Result<(), Refused> {
    holds(
        generation <= MAX_SAFE_INTEGER,
        "generation is a safe integer",
    )
}

impl EdgeCheck for CreateTaskRequest {
    fn checked(mut self) -> Result<Self, Refused> {
        keyed(&self.idempotency_key)?;
        self.title = task_title(&self.title)
            .ok_or_else(|| Refused(TITLE_RULE.to_owned()))?
            .to_owned();
        holds(is_task_brief(&self.brief), BRIEF_RULE)?;
        holds(
            self.parent_task_id
                .as_deref()
                .is_none_or(|id| TaskId::parse(id).is_some()),
            PARENT_RULE,
        )?;
        Ok(self)
    }
}

impl EdgeCheck for OpenShellRequest {
    fn checked(self) -> Result<Self, Refused> {
        keyed(&self.idempotency_key)?;
        holds(self.cwd.as_deref() != Some(""), "cwd is a path")?;
        holds(
            self.linked_agent_id.is_none() || self.cwd.is_none(),
            "a linked shell opens in its agent's directory, so it takes no cwd",
        )?;
        Ok(self)
    }
}

impl EdgeCheck for CloseShellRequest {
    fn checked(self) -> Result<Self, Refused> {
        keyed(&self.idempotency_key)?;
        generation(self.generation)?;
        holds(
            self.confirmed_program
                .as_deref()
                .is_none_or(|program| chars(program) <= CONFIRMED_PROGRAM_MAX_CHARS),
            "confirmedProgram is at most 200 characters",
        )?;
        Ok(self)
    }
}

impl EdgeCheck for CloseAgentRequest {
    fn checked(self) -> Result<Self, Refused> {
        keyed(&self.idempotency_key)?;
        generation(self.generation)?;
        holds(
            self.confirmed_busy
                .iter()
                .flatten()
                .all(|busy| chars(&busy.program) <= CONFIRMED_PROGRAM_MAX_CHARS),
            "each program confirmedBusy names is at most 200 characters",
        )?;
        Ok(self)
    }
}

impl EdgeCheck for SignalAgentRequest {
    fn checked(self) -> Result<Self, Refused> {
        keyed(&self.idempotency_key)?;
        generation(self.generation)?;
        Ok(self)
    }
}

impl EdgeCheck for RespawnAgentRequest {
    fn checked(self) -> Result<Self, Refused> {
        keyed(&self.idempotency_key)?;
        generation(self.generation)?;
        Ok(self)
    }
}

impl EdgeCheck for RestartShellRequest {
    fn checked(self) -> Result<Self, Refused> {
        keyed(&self.idempotency_key)?;
        generation(self.generation)?;
        holds(self.retype != Some(false), "retype is only ever true")?;
        Ok(self)
    }
}

impl EdgeCheck for UnlinkShellRequest {
    fn checked(self) -> Result<Self, Refused> {
        keyed(&self.idempotency_key)?;
        generation(self.generation)?;
        Ok(self)
    }
}

impl EdgeCheck for RenameShellRequest {
    fn checked(mut self) -> Result<Self, Refused> {
        keyed(&self.idempotency_key)?;
        if let Some(name) = &self.name {
            let trimmed = named(name).ok_or_else(|| {
                Refused(
                    "name is 1 to 80 characters once trimmed, with no control characters or \
                     bidirectional overrides"
                        .to_owned(),
                )
            })?;
            self.name = Some(trimmed.to_owned());
        }
        Ok(self)
    }
}

impl EdgeCheck for DismissNoticeRequest {
    fn checked(self) -> Result<Self, Refused> {
        keyed(&self.idempotency_key)?;
        Ok(self)
    }
}

impl EdgeCheck for PairRequest {
    fn checked(self) -> Result<Self, Refused> {
        holds(
            chars(&self.code) <= PAIRING_CODE_TYPED_MAX,
            "code is at most 32 characters",
        )?;
        holds(
            self.name
                .as_deref()
                .is_none_or(|name| chars(name) <= DEVICE_NAME_MAX),
            "name is at most 64 characters",
        )?;
        Ok(self)
    }
}

impl EdgeCheck for ShellReport {
    fn checked(self) -> Result<Self, Refused> {
        holds(
            self.bounded(),
            "a report is a token of 1 to 128 characters, a safe integer and a line of at most \
             2048",
        )?;
        Ok(self)
    }
}

impl EdgeCheck for ShellPrompt {
    fn checked(self) -> Result<Self, Refused> {
        holds(self.bounded(), "token is 1 to 128 characters")?;
        Ok(self)
    }
}

impl EdgeCheck for ShellDecline {
    fn checked(self) -> Result<Self, Refused> {
        holds(self.bounded(), "token is 1 to 128 characters")?;
        Ok(self)
    }
}

/// Whether `n` is an integer zod's `.int()` takes: within the integers a JSON number holds exactly.
fn safe_integer(n: i64) -> bool {
    n.unsigned_abs() <= MAX_SAFE_INTEGER
}

impl EdgeCheck for HookRequest {
    fn checked(self) -> Result<Self, Refused> {
        holds(safe_integer(self.pid), "pid is a safe integer")?;
        holds(safe_integer(self.ppid), "ppid is a safe integer")?;
        Ok(self)
    }
}

/// An ack holds to no rule past its shape: its agent id and offer tokens are each read whole.
impl EdgeCheck for HookAck {
    fn checked(self) -> Result<Self, Refused> {
        Ok(self)
    }
}

#[cfg(test)]
mod tests {
    use proptest::prelude::*;
    use serde_json::{Value, json};

    use super::*;

    fn verdict<T: DeserializeOwned + EdgeCheck + serde::Serialize>(
        body: &Value,
    ) -> Result<Value, String> {
        edge::<T>(body.to_string().as_bytes())
            .map(|taken| serde_json::to_value(taken).unwrap())
            .map_err(|refused| refused.0)
    }

    fn refused<T: DeserializeOwned + EdgeCheck + serde::Serialize>(body: &Value) -> bool {
        verdict::<T>(body).is_err()
    }

    const KEY: &str = "k1";

    #[test]
    fn a_hook_is_taken_with_its_payload_as_sent_and_refused_past_a_safe_pid() {
        let hook = |pid: Value, ppid: Value| {
            json!({ "protocolVersion": "1.0", "agentId": "agent_01900000000070008000000000000001",
                    "event": "Stop", "pid": pid, "ppid": ppid, "payload": {"a": [1]} })
        };
        let safe = (1_i64 << 53) - 1;
        let taken = edge::<HookRequest>(hook(json!(safe), json!(-safe)).to_string().as_bytes());
        assert_eq!(
            taken.map(|hook| (hook.pid, hook.ppid, hook.payload.get().to_owned())),
            Ok((safe, -safe, r#"{"a":[1]}"#.to_owned()))
        );
        assert_eq!(
            [
                hook(json!(safe + 1), json!(1)),
                hook(json!(1), json!(-safe - 1)),
                json!([hook(json!(1), json!(1))]),
            ]
            .map(|body| edge::<HookRequest>(body.to_string().as_bytes()).err()),
            [
                Some(Refused("pid is a safe integer".to_owned())),
                Some(Refused("ppid is a safe integer".to_owned())),
                Some(Refused(OBJECT_RULE.to_owned())),
            ]
        );
        // A whole number however JSON writes it, as zod's `.int()` takes it, and no fraction.
        let written = |pid: &str, ppid: &str| {
            let body = format!(
                r#"{{"protocolVersion":"1.0","agentId":"agent_01900000000070008000000000000001","event":"Stop","pid":{pid},"ppid":{ppid},"payload":null}}"#
            );
            edge::<HookRequest>(body.as_bytes())
                .map(|hook| (hook.pid, hook.ppid))
                .ok()
        };
        assert_eq!(
            [
                written("2.0", "-2e0"),
                written("2e0", "1e3"),
                written("2.5", "1"),
                written("1", "-2.5"),
            ],
            [Some((2, -2)), Some((2, 1000)), None, None]
        );
    }

    #[test]
    fn an_ack_is_taken_as_its_shape_reads_it() {
        let ack = json!({ "agentId": "agent_01900000000070008000000000000001",
                          "offered": ["msg_0190000000007000800000000000000a-1"] });
        assert_eq!(verdict::<HookAck>(&ack), Ok(ack.clone()));
        assert!(refused::<HookAck>(
            &json!({ "agentId": "agent_1", "offered": [] })
        ));
    }

    #[test]
    fn a_task_is_taken_with_its_title_trimmed_and_refused_past_each_bound() {
        let taken = verdict::<CreateTaskRequest>(
            &json!({ "idempotencyKey": KEY, "title": "  fix it ", "brief": "b" }),
        );
        assert_eq!(taken.unwrap()["title"], "fix it");
        for broken in [
            json!({ "idempotencyKey": "", "title": "t", "brief": "b" }),
            json!({ "idempotencyKey": "k".repeat(201), "title": "t", "brief": "b" }),
            json!({ "idempotencyKey": "\u{1f600}".repeat(201), "title": "t", "brief": "b" }),
            json!({ "idempotencyKey": KEY, "title": "\u{1f600}".repeat(201), "brief": "b" }),
            json!({ "idempotencyKey": KEY, "title": "   ", "brief": "b" }),
            json!({ "idempotencyKey": KEY, "title": "a\u{202e}b", "brief": "b" }),
            json!({ "idempotencyKey": KEY, "title": "t", "brief": "" }),
            json!({ "idempotencyKey": KEY, "title": "t", "brief": "b".repeat(20_001) }),
            json!({ "idempotencyKey": KEY, "title": "t", "brief": "\u{1f600}".repeat(20_001) }),
            json!({ "idempotencyKey": KEY, "title": "t", "brief": "b", "parentTaskId": "x" }),
            json!({ "idempotencyKey": KEY, "title": "t", "brief": "b", "parentTaskId": null }),
            json!({ "idempotencyKey": KEY, "title": "t", "brief": "b", "assign": null }),
        ] {
            assert!(refused::<CreateTaskRequest>(&broken), "{broken}");
        }
        let at_bounds = json!({
            "idempotencyKey": "\u{1f600}".repeat(200),
            "title": "\u{1f600}".repeat(200),
            "brief": "\u{1f600}".repeat(20_000),
        });
        assert!(!refused::<CreateTaskRequest>(&at_bounds));
    }

    #[test]
    fn a_shell_opens_with_a_cwd_or_a_linked_agent_and_not_both() {
        let agent = "agent_0190c3b2a1d47a3b8c1d2e3f4a5b6c7d";
        assert!(!refused::<OpenShellRequest>(
            &json!({ "idempotencyKey": KEY, "cwd": "/w" })
        ));
        assert!(!refused::<OpenShellRequest>(
            &json!({ "idempotencyKey": KEY, "linkedAgentId": agent })
        ));
        for broken in [
            json!({ "idempotencyKey": KEY, "cwd": "" }),
            json!({ "idempotencyKey": KEY, "cwd": "/w", "linkedAgentId": agent }),
            json!({ "idempotencyKey": "" }),
        ] {
            assert!(refused::<OpenShellRequest>(&broken), "{broken}");
        }
    }

    #[test]
    fn an_agents_close_and_signal_hold_their_generation_and_options_to_the_protocol() {
        let safe = MAX_SAFE_INTEGER;
        let term = "term_0190c3b2a1d47a3b8c1d2e3f4a5b6c7d";
        let with = |extra: Value| {
            let mut body = json!({ "idempotencyKey": KEY, "generation": safe, "signal": "SIGINT" });
            body.as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            body
        };
        let busy = |program: String| json!({ "confirmedBusy": [{ "terminalId": term, "program": program }] });
        assert_eq!(
            [
                refused::<CloseAgentRequest>(&with(busy("p".repeat(200)))),
                refused::<CloseAgentRequest>(&with(json!({ "keepShells": [term], "force": true }))),
                refused::<SignalAgentRequest>(&with(json!({ "generation": 2.0 }))),
                refused::<CloseAgentRequest>(&with(busy("p".repeat(201)))),
                refused::<CloseAgentRequest>(&with(json!({ "generation": safe + 1 }))),
                refused::<CloseAgentRequest>(&with(json!({ "force": null }))),
                refused::<CloseAgentRequest>(&with(json!({ "keepShells": ["x"] }))),
                refused::<SignalAgentRequest>(&with(json!({ "generation": safe + 1 }))),
                refused::<SignalAgentRequest>(&with(json!({ "generation": 2.5 }))),
                refused::<SignalAgentRequest>(&with(json!({ "idempotencyKey": "" }))),
                refused::<SignalAgentRequest>(&with(json!({ "signal": "SIGSTOP" }))),
            ],
            [
                false, false, false, true, true, true, true, true, true, true, true
            ]
        );
    }

    #[test]
    fn an_unlink_holds_its_key_and_generation_to_the_protocol() {
        let safe = MAX_SAFE_INTEGER;
        let unlink = |key: &str, generation: Value| {
            refused::<UnlinkShellRequest>(
                &json!({ "idempotencyKey": key, "generation": generation }),
            )
        };
        assert_eq!(
            [
                unlink(KEY, json!(safe)),
                unlink(KEY, json!(2.0)),
                unlink(KEY, json!(safe + 1)),
                unlink(KEY, json!(2.5)),
                unlink(KEY, json!(-1)),
                unlink("", json!(0)),
                refused::<UnlinkShellRequest>(&json!({ "idempotencyKey": KEY })),
            ],
            [false, false, true, true, true, true, true]
        );
    }

    #[test]
    fn a_close_and_a_restart_hold_their_generation_and_their_options_to_the_protocol() {
        let safe = MAX_SAFE_INTEGER;
        let close = |extra: Value| {
            let mut body = json!({ "idempotencyKey": KEY, "generation": safe });
            body.as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            body
        };
        assert!(!refused::<CloseShellRequest>(&close(
            json!({ "confirmedProgram": "p".repeat(200) })
        )));
        assert!(refused::<CloseShellRequest>(&close(
            json!({ "confirmedProgram": "p".repeat(201) })
        )));
        assert!(refused::<CloseShellRequest>(&close(
            json!({ "generation": safe + 1 })
        )));
        assert!(!refused::<RestartShellRequest>(&close(
            json!({ "retype": true })
        )));
        assert!(refused::<RestartShellRequest>(&close(
            json!({ "retype": false })
        )));
        assert!(refused::<RestartShellRequest>(&close(
            json!({ "generation": safe + 1 })
        )));
        let written =
            |generation: &str| format!(r#"{{"idempotencyKey":"{KEY}","generation":{generation}}}"#);
        for (text, read) in [
            ("2.0", Some(2)),
            ("2e0", Some(2)),
            ("9007199254740991.0", Some(safe)),
            ("2.5", None),
            ("9007199254740992", None),
            ("9007199254740992.0", None),
        ] {
            let close = edge::<CloseShellRequest>(written(text).as_bytes()).ok();
            assert_eq!(close.map(|c| c.generation), read, "close {text}");
            let restart = edge::<RestartShellRequest>(written(text).as_bytes()).ok();
            assert_eq!(restart.map(|r| r.generation), read, "restart {text}");
        }
    }

    #[test]
    fn a_rename_needs_its_name_null_or_not_and_trims_it() {
        assert!(refused::<RenameShellRequest>(
            &json!({ "idempotencyKey": KEY })
        ));
        assert_eq!(
            verdict::<RenameShellRequest>(&json!({ "idempotencyKey": KEY, "name": null })),
            Ok(json!({ "idempotencyKey": KEY, "name": null }))
        );
        assert_eq!(
            verdict::<RenameShellRequest>(&json!({ "idempotencyKey": KEY, "name": " dev " })),
            Ok(json!({ "idempotencyKey": KEY, "name": "dev" }))
        );
        for name in [" ", "a\u{7}", "n".repeat(81).as_str()] {
            let body = json!({ "idempotencyKey": KEY, "name": name });
            assert!(refused::<RenameShellRequest>(&body), "{body}");
        }
    }

    /// Whether serde alone reads `body` as a `T`, and the edge's verdict on it.
    fn read_and_judged<T: DeserializeOwned + EdgeCheck>(body: &str) -> (bool, Result<(), String>) {
        (
            serde_json::from_str::<T>(body).is_ok(),
            edge::<T>(body.as_bytes())
                .map(drop)
                .map_err(|refused| refused.0),
        )
    }

    #[test]
    fn a_request_written_as_an_array_is_refused_though_serde_reads_it() {
        let refused = (true, Err(OBJECT_RULE.to_owned()));
        assert_eq!(
            read_and_judged::<CreateTaskRequest>(r#"["k","t","b"]"#),
            refused
        );
        assert_eq!(read_and_judged::<OpenShellRequest>(r#"["o"]"#), refused);
        assert_eq!(read_and_judged::<CloseShellRequest>(r#"["c",0]"#), refused);
        assert_eq!(
            read_and_judged::<RestartShellRequest>(r#"["r",0]"#),
            refused
        );
        assert_eq!(
            read_and_judged::<RenameShellRequest>(r#"["n","dev"]"#),
            refused
        );
        assert_eq!(read_and_judged::<DismissNoticeRequest>(r#"["k"]"#), refused);
        assert_eq!(read_and_judged::<PairRequest>(r#" ["c"]"#), refused);
    }

    #[test]
    fn a_request_is_an_object_past_json_s_whitespace_and_no_other() {
        assert_eq!(
            read_and_judged::<DismissNoticeRequest>(" \t\n\r{\"idempotencyKey\":\"k\"}"),
            (true, Ok(()))
        );
        for other in [
            "\u{c}{}",
            "\u{a0}{}",
            "\u{3000}{}",
            "\u{feff}{}",
            "",
            "null",
            "\"{\"",
        ] {
            assert!(!is_object(other.as_bytes()), "{other:?}");
        }
    }

    #[test]
    fn a_dismissal_and_a_pairing_are_held_to_their_lengths() {
        assert!(!refused::<DismissNoticeRequest>(
            &json!({ "idempotencyKey": KEY })
        ));
        assert!(refused::<DismissNoticeRequest>(
            &json!({ "idempotencyKey": "" })
        ));
        for (key, taken) in [
            ("k".repeat(200), true),
            ("\u{1f600}".repeat(200), true),
            ("k".repeat(201), false),
            ("\u{1f600}".repeat(201), false),
        ] {
            let body = json!({ "idempotencyKey": key });
            assert_eq!(
                verdict::<DismissNoticeRequest>(&body).map_err(|rule| rule == KEY_RULE),
                if taken { Ok(body) } else { Err(true) },
                "{} code points",
                key.chars().count()
            );
        }
        let pair = |code: &str, name: &str| json!({ "code": code, "name": name });
        assert!(!refused::<PairRequest>(&pair(
            &"c".repeat(32),
            &"n".repeat(64)
        )));
        assert!(!refused::<PairRequest>(&pair(
            &"\u{1f600}".repeat(32),
            &"\u{1f600}".repeat(64)
        )));
        assert!(refused::<PairRequest>(&pair(&"c".repeat(33), "n")));
        assert!(refused::<PairRequest>(&pair(&"\u{1f600}".repeat(33), "n")));
        assert!(refused::<PairRequest>(&pair("c", &"n".repeat(65))));
        assert!(refused::<PairRequest>(
            &json!({ "code": "c", "name": null })
        ));
        assert!(!refused::<PairRequest>(&json!({ "code": "c" })));
    }

    #[test]
    fn a_shell_s_reports_are_held_to_their_bounds() {
        let token = "t".repeat(128);
        let report = |token: &str, at: u64| json!({ "token": token, "at": at, "command": null });
        assert!(!refused::<ShellReport>(&report(&token, MAX_SAFE_INTEGER)));
        assert!(refused::<ShellReport>(&report(
            &token,
            MAX_SAFE_INTEGER + 1
        )));
        assert!(refused::<ShellReport>(&report("", 0)));
        assert!(!refused::<ShellPrompt>(&json!({ "token": token })));
        assert!(refused::<ShellPrompt>(&json!({ "token": "t".repeat(129) })));
        let astral = "\u{1f600}".repeat(128);
        assert!(!refused::<ShellPrompt>(&json!({ "token": astral })));
        assert!(refused::<ShellPrompt>(&json!({ "token": astral + "t" })));
        assert!(!refused::<ShellDecline>(&json!({ "token": token })));
        assert!(refused::<ShellDecline>(&json!({ "token": "" })));
    }

    /// Whether any request the edge reads takes `body`.
    fn taken_by_any(body: &[u8]) -> bool {
        edge::<CreateTaskRequest>(body).is_ok()
            || edge::<OpenShellRequest>(body).is_ok()
            || edge::<CloseShellRequest>(body).is_ok()
            || edge::<RestartShellRequest>(body).is_ok()
            || edge::<RenameShellRequest>(body).is_ok()
            || edge::<DismissNoticeRequest>(body).is_ok()
            || edge::<PairRequest>(body).is_ok()
            || edge::<ShellReport>(body).is_ok()
            || edge::<ShellPrompt>(body).is_ok()
            || edge::<ShellDecline>(body).is_ok()
    }

    /// `taken`, written back out, is taken again as itself.
    fn settled<T>(taken: &T) -> bool
    where
        T: DeserializeOwned + EdgeCheck + serde::Serialize + PartialEq,
    {
        edge::<T>(&serde_json::to_vec(taken).unwrap()).is_ok_and(|again| again == *taken)
    }

    /// A body each request takes whole, but for the pairing, which holds a code typed in.
    const TAKEN: [&str; 4] = [
        r#"{"idempotencyKey":"k1","title":"  fix it ","brief":"b"}"#,
        r#"{"idempotencyKey":"k1","generation":2.0,"confirmedProgram":"vim"}"#,
        r#"{"idempotencyKey":"k1","name":" dev "}"#,
        r#"{"token":"t","command":"ls"}"#,
    ];

    /// Text a name or a title might hold: anything, or what sits at their rules' edges.
    const EDGES: &str = "[ \\t\\x{feff}\\x{85}\\x{7}\\x{202e}\\x{200b}a-z\\x{1f600}]{0,210}";

    /// Short text, padded with what JavaScript trims and what it doesn't.
    const PADDED: &str =
        "[ \\t\\x{feff}\\x{85}]{0,3}[a-z\\x{1f600}\\x{200b}]{1,8}[ \\t\\x{feff}\\x{85}]{0,3}";

    proptest! {
        #[test]
        fn every_truncation_of_a_taken_request_is_refused(
            which in prop::sample::select(TAKEN.to_vec()),
            cut in any::<prop::sample::Index>(),
        ) {
            prop_assert!(taken_by_any(which.as_bytes()), "{}", which);
            let cut = cut.index(which.len());
            let cut = &which.as_bytes()[..cut];
            prop_assert!(!taken_by_any(cut), "{}", String::from_utf8_lossy(cut));
        }

        #[test]
        fn a_rename_takes_a_showable_name_of_1_to_80_code_points_and_gives_it_back_trimmed(
            name in prop_oneof![any::<String>(), EDGES, PADDED],
        ) {
            let body = json!({ "idempotencyKey": KEY, "name": name });
            let taken = edge::<RenameShellRequest>(body.to_string().as_bytes());
            let read = taken.as_ref().ok().and_then(|rename| rename.name.as_deref());
            let trimmed = trim(&name);
            let held = (1..=80).contains(&trimmed.chars().count()) && showable(trimmed);
            prop_assert_eq!(read, held.then_some(trimmed));
            prop_assert!(taken.as_ref().ok().is_none_or(settled));
        }

        #[test]
        fn a_task_takes_a_safe_title_of_1_to_200_code_points_and_gives_it_back_trimmed(
            title in prop_oneof![any::<String>(), EDGES, PADDED],
        ) {
            let body = json!({ "idempotencyKey": KEY, "title": title, "brief": "b" });
            let taken = edge::<CreateTaskRequest>(body.to_string().as_bytes());
            let read = taken.as_ref().ok().map(|task| task.title.as_str());
            let trimmed = trim(&title);
            let held = (1..=200).contains(&trimmed.chars().count()) && title_safe(trimmed);
            prop_assert_eq!(read, held.then_some(trimmed));
            prop_assert!(taken.as_ref().ok().is_none_or(settled));
        }

        #[test]
        fn a_close_takes_a_generation_up_to_the_largest_safe_integer_however_written(
            generation in prop_oneof![
                any::<u64>(),
                (MAX_SAFE_INTEGER - 2)..=(MAX_SAFE_INTEGER + 2),
            ],
            written in prop::sample::select(vec!["", ".0", "e0"]),
        ) {
            let number = format!("{generation}{written}");
            let body = format!(r#"{{"idempotencyKey":"{KEY}","generation":{number}}}"#);
            let taken = edge::<CloseShellRequest>(body.as_bytes());
            let read = taken.as_ref().ok().map(|close| close.generation);
            prop_assert_eq!(read, (generation <= MAX_SAFE_INTEGER).then_some(generation));
            prop_assert!(taken.as_ref().ok().is_none_or(settled));
        }

        #[test]
        fn a_dismissal_takes_a_key_of_1_to_200_code_points(
            key in prop_oneof![
                any::<String>(),
                "[a\\x{1f600}]{0,210}",
            ],
        ) {
            let body = json!({ "idempotencyKey": key });
            let taken = edge::<DismissNoticeRequest>(body.to_string().as_bytes());
            let points = key.chars().count();
            prop_assert_eq!(taken.is_ok(), (1..=200).contains(&points), "{} code points", points);
            prop_assert!(taken.as_ref().ok().is_none_or(settled));
        }
    }
}
