//! What the daemon's edge takes: a request as serde reads it, held to every rule zod holds it to
//! past its shape, and given back as zod parses it. A message's edge verdict is [`edge`]: its
//! decode, then its [`EdgeCheck`].
//!
//! Where zod holds a request to more than the Rust daemon's handlers check, the edge holds it to
//! zod's rule: a dismissal's key to 1 to 200 units, and a close's or a restart's generation to the
//! largest safe integer. The daemon's router test lists both.

use serde::de::DeserializeOwned;

use crate::ids::TaskId;
use crate::notices::{DEVICE_NAME_MAX, DismissNoticeRequest, PAIRING_CODE_TYPED_MAX, PairRequest};
use crate::shells::{
    CloseShellRequest, OpenShellRequest, RenameShellRequest, RestartShellRequest, ShellDecline,
    ShellPrompt, ShellReport, shell_name,
};
use crate::tasks::CreateTaskRequest;
use crate::text::{TASK_BRIEF_MAX_UNITS, new_task_title};

/// The most UTF-16 units an idempotency key has.
pub const IDEMPOTENCY_KEY_MAX_UNITS: usize = 200;

/// The most UTF-16 units the program a close confirms names.
pub const CONFIRMED_PROGRAM_MAX_UNITS: usize = 200;

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
/// [`Refused`], when serde can't read it as a `T` or it breaks one of `T`'s rules.
pub fn edge<T: DeserializeOwned + EdgeCheck>(body: &[u8]) -> Result<T, Refused> {
    serde_json::from_slice::<T>(body)
        .map_err(|err| Refused(err.to_string()))?
        .checked()
}

fn units(text: &str) -> usize {
    text.encode_utf16().count()
}

fn holds(holds: bool, rule: &str) -> Result<(), Refused> {
    if holds {
        Ok(())
    } else {
        Err(Refused(rule.to_owned()))
    }
}

fn keyed(key: &str) -> Result<(), Refused> {
    holds(
        (1..=IDEMPOTENCY_KEY_MAX_UNITS).contains(&units(key)),
        "idempotencyKey is 1 to 200 characters",
    )
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
        self.title = new_task_title(&self.title)
            .ok_or_else(|| {
                Refused(
                    "title is 1 to 200 characters once trimmed, with no control characters, \
                     bidirectional overrides or invisible ones"
                        .to_owned(),
                )
            })?
            .to_owned();
        holds(
            (1..=TASK_BRIEF_MAX_UNITS).contains(&units(&self.brief)),
            "brief is 1 to 20000 characters",
        )?;
        holds(
            self.parent_task_id
                .as_deref()
                .is_none_or(|id| TaskId::parse(id).is_some()),
            "parentTaskId is a task id",
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
                .is_none_or(|program| units(program) <= CONFIRMED_PROGRAM_MAX_UNITS),
            "confirmedProgram is at most 200 characters",
        )?;
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

impl EdgeCheck for RenameShellRequest {
    fn checked(mut self) -> Result<Self, Refused> {
        keyed(&self.idempotency_key)?;
        if let Some(name) = &self.name {
            let trimmed = shell_name(name).ok_or_else(|| {
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
            units(&self.code) <= PAIRING_CODE_TYPED_MAX,
            "code is at most 32 characters",
        )?;
        holds(
            self.name
                .as_deref()
                .is_none_or(|name| units(name) <= DEVICE_NAME_MAX),
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
    fn a_task_is_taken_with_its_title_trimmed_and_refused_past_each_bound() {
        let taken = verdict::<CreateTaskRequest>(
            &json!({ "idempotencyKey": KEY, "title": "  fix it ", "brief": "b" }),
        );
        assert_eq!(taken.unwrap()["title"], "fix it");
        for broken in [
            json!({ "idempotencyKey": "", "title": "t", "brief": "b" }),
            json!({ "idempotencyKey": "k".repeat(201), "title": "t", "brief": "b" }),
            json!({ "idempotencyKey": KEY, "title": "   ", "brief": "b" }),
            json!({ "idempotencyKey": KEY, "title": "a\u{202e}b", "brief": "b" }),
            json!({ "idempotencyKey": KEY, "title": "t", "brief": "" }),
            json!({ "idempotencyKey": KEY, "title": "t", "brief": "b".repeat(20_001) }),
            json!({ "idempotencyKey": KEY, "title": "t", "brief": "b", "parentTaskId": "x" }),
            json!({ "idempotencyKey": KEY, "title": "t", "brief": "b", "parentTaskId": null }),
            json!({ "idempotencyKey": KEY, "title": "t", "brief": "b", "assign": null }),
        ] {
            assert!(refused::<CreateTaskRequest>(&broken), "{broken}");
        }
        let at_bounds = json!({
            "idempotencyKey": "\u{1f600}".repeat(100),
            "title": "t",
            "brief": "b".repeat(20_000),
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

    #[test]
    fn a_dismissal_and_a_pairing_are_held_to_their_lengths() {
        assert!(!refused::<DismissNoticeRequest>(
            &json!({ "idempotencyKey": KEY })
        ));
        assert!(refused::<DismissNoticeRequest>(
            &json!({ "idempotencyKey": "" })
        ));
        let pair = |code: &str, name: &str| json!({ "code": code, "name": name });
        assert!(!refused::<PairRequest>(&pair(
            &"c".repeat(32),
            &"n".repeat(64)
        )));
        assert!(refused::<PairRequest>(&pair(&"c".repeat(33), "n")));
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
        fn a_rename_takes_a_name_exactly_when_shell_name_does_and_gives_it_back_trimmed(
            name in prop_oneof![any::<String>(), EDGES, PADDED],
        ) {
            let body = json!({ "idempotencyKey": KEY, "name": name });
            let taken = edge::<RenameShellRequest>(body.to_string().as_bytes());
            let read = taken.as_ref().ok().and_then(|rename| rename.name.as_deref());
            prop_assert_eq!(read, shell_name(&name));
            prop_assert!(taken.as_ref().ok().is_none_or(settled));
        }

        #[test]
        fn a_task_takes_a_title_exactly_when_new_task_title_does_and_gives_it_back_trimmed(
            title in prop_oneof![any::<String>(), EDGES, PADDED],
        ) {
            let body = json!({ "idempotencyKey": KEY, "title": title, "brief": "b" });
            let taken = edge::<CreateTaskRequest>(body.to_string().as_bytes());
            let read = taken.as_ref().ok().map(|task| task.title.as_str());
            prop_assert_eq!(read, new_task_title(&title));
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
        fn a_dismissal_takes_a_key_of_1_to_200_utf16_units(
            key in prop_oneof![
                any::<String>(),
                "[a\\x{1f600}]{0,210}",
            ],
        ) {
            let body = json!({ "idempotencyKey": key });
            let taken = edge::<DismissNoticeRequest>(body.to_string().as_bytes());
            let units = key.encode_utf16().count();
            prop_assert_eq!(taken.is_ok(), (1..=200).contains(&units), "{} units", units);
            prop_assert!(taken.as_ref().ok().is_none_or(settled));
        }
    }
}
