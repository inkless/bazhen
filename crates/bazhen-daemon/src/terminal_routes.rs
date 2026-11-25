//! `GET /v1/terminals/:id/screen` in `http/app.ts`: a terminal's screen as text. A read: it takes
//! no lease, and nothing reaches the terminal.

use axum::extract::rejection::QueryRejection;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use bazhen_protocol::daemon::ErrorCode;
use bazhen_protocol::ids::TerminalId;
use bazhen_protocol::terminals::SCREEN_HISTORY_MAX;

use crate::routes::{Shared, fail, internal};
use crate::terminals::{Recorded, TerminalError};

/// `?history=`: a whole number of rows up to the most, 0 when unset; `None` when neither. The
/// first `history` counts, as Hono reads a query (`screenHistory`).
fn history(query: &[(String, String)]) -> Option<u32> {
    let Some((_, raw)) = query.iter().find(|(name, _)| name == "history") else {
        return Some(0);
    };
    if !(1..=5).contains(&raw.len()) || !raw.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    raw.parse().ok().filter(|rows| *rows <= SCREEN_HISTORY_MAX)
}

/// A screen read's failure as the error it answers (`screenFailure`); a 500 for one it doesn't
/// expect.
fn refusal(id: &str, err: &TerminalError) -> Response {
    let (status, code, message) = match err {
        TerminalError::Unservable { protocol, .. } => (
            StatusCode::CONFLICT,
            ErrorCode::NeedsRestart,
            format!(
                "terminal {id}: its holder speaks only {}, which this build doesn't",
                protocol.join(", ")
            ),
        ),
        TerminalError::Predates { what } => (
            StatusCode::CONFLICT,
            ErrorCode::NeedsRestart,
            format!("terminal {id} runs on a holder that predates {what}: restart it to use them"),
        ),
        TerminalError::Stale(_) | TerminalError::Gone(_) => (
            StatusCode::NOT_FOUND,
            ErrorCode::NotFound,
            format!("no running terminal {id}"),
        ),
        TerminalError::Unreadable { reason } => (
            StatusCode::SERVICE_UNAVAILABLE,
            ErrorCode::Unavailable,
            format!("terminal {id}'s screen can't be read: {reason}"),
        ),
        TerminalError::Unconfirmed(_) => (
            StatusCode::SERVICE_UNAVAILABLE,
            ErrorCode::Unavailable,
            format!("terminal {id}: its server may still be running it"),
        ),
        TerminalError::Unreachable(_) => (
            StatusCode::SERVICE_UNAVAILABLE,
            ErrorCode::Unavailable,
            format!("terminal {id}: what runs it can't be reached"),
        ),
        TerminalError::ProcessState(_) | TerminalError::Other(_) | TerminalError::Unknown(_) => {
            return internal(err);
        }
    };
    fail(status, code, &message)
}

/// The screen of terminal `id`, an agent's or a shell's, after the rows of history asked for.
pub(crate) async fn screen(
    State(shared): State<Shared>,
    Path(id): Path<String>,
    query: Result<Query<Vec<(String, String)>>, QueryRejection>,
) -> Response {
    let Some(history) = query.ok().and_then(|Query(query)| history(&query)) else {
        let why = format!("history is a whole number of rows from 0 to {SCREEN_HISTORY_MAX}");
        return fail(StatusCode::BAD_REQUEST, ErrorCode::InvalidRequest, &why);
    };
    let store = shared.store.clone();
    let asked = id.clone();
    let read =
        tokio::task::spawn_blocking(move || store.reader()?.reads().runtime_row(&asked)).await;
    let row = match read {
        Ok(Ok(row)) => row,
        Ok(Err(err)) => return internal(&err),
        Err(err) => return internal(&err),
    };
    let (Some(row), Some(terminal_id)) = (row, TerminalId::parse(&id)) else {
        return fail(
            StatusCode::NOT_FOUND,
            ErrorCode::NotFound,
            &format!("no terminal {id}"),
        );
    };
    match row.runtime.as_str() {
        "holder" => {}
        // This daemon runs nothing on tmux, but a terminal the TypeScript daemon left there is
        // still recorded on it, and tmux has no screen to read.
        "tmux" => {
            return fail(
                StatusCode::UNPROCESSABLE_ENTITY,
                ErrorCode::Unsupported,
                &format!(
                    "terminal {id} runs on tmux, whose screens can't be read: only a holder terminal's can"
                ),
            );
        }
        other => return internal(&format!("terminal {id} is recorded on runtime {other}")),
    }
    let Some(locator) = row.locator else {
        return internal(&format!("terminal {id}'s runtime recorded no locator"));
    };
    let Some(shells) = &shared.shells else {
        return fail(
            StatusCode::SERVICE_UNAVAILABLE,
            ErrorCode::Unavailable,
            "this daemon runs no terminals",
        );
    };
    let terminal = Recorded {
        terminal_id,
        locator,
    };
    match shells.terminals().screen(&terminal, history).await {
        Ok(screen) => axum::Json(screen).into_response(),
        Err(err) => refusal(&id, &err),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use bazhen_protocol::terminals::SCREEN_HISTORY_MAX;
    use proptest::prelude::*;
    use serde_json::{Value, json};
    use tower::ServiceExt as _;

    use super::history;

    use crate::routes::{Gate, Stop, http_router, socket_router};
    use crate::shells::tests::{Harness, setup};
    use crate::terminals::TerminalError;

    const UNKNOWN: &str = "term_0190a1b2c3d47abc8def0123456789ad";

    /// TS's rule for `?history=`, `/^\d{1,5}$/` and at most the most, written from the regex:
    /// one to five characters, each an ASCII digit.
    fn rule(raw: &str) -> Option<u32> {
        let digits = raw.chars().all(|c| c.is_ascii_digit());
        if !digits || !(1..=5).contains(&raw.chars().count()) {
            return None;
        }
        let rows: u32 = raw.parse().unwrap();
        (rows <= SCREEN_HISTORY_MAX).then_some(rows)
    }

    /// A `history` value: mostly digits, with what a parser might wrongly take as part of a
    /// number (a sign, a space, a newline, a digit from another script) mixed in.
    fn raw_history() -> impl Strategy<Value = String> {
        prop_oneof!["[0-9]{0,8}", "[0-9+\\- \n\t.e٣０]{0,7}", "\\PC{0,6}",]
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(4096))]

        /// Whatever `history` a query carries, alone or after another, it is read as TS's rule
        /// reads it, and only the first counts.
        #[test]
        fn reads_any_history_as_the_whole_number_typescript_s_rule_allows(
            raw in raw_history(),
            later in raw_history(),
        ) {
            let pair = |value: &str| ("history".to_owned(), value.to_owned());
            prop_assert_eq!(history(&[pair(&raw)]), rule(&raw), "{:?}", raw);
            prop_assert_eq!(
                history(&[("rows".to_owned(), later.clone()), pair(&raw), pair(&later)]),
                rule(&raw),
                "{:?} then {:?}", raw, later
            );
        }
    }

    fn shared(h: &Harness) -> crate::routes::Shared {
        crate::routes::Shared {
            shells: Some(Arc::clone(&h.shells)),
            ..crate::routes::Shared::new("f".repeat(64).as_str(), Stop::default(), h.store.clone())
        }
    }

    /// What `router` answers a GET of `path` with, reaching it from this machine.
    fn got(runtime: &tokio::runtime::Runtime, router: axum::Router, path: &str) -> (u16, Value) {
        let request = axum::http::Request::builder()
            .method("GET")
            .uri(path)
            .header("host", "127.0.0.1:7900")
            .body(axum::body::Body::empty())
            .unwrap();
        runtime.block_on(async {
            let answered =
                tokio::time::timeout(std::time::Duration::from_secs(10), router.oneshot(request))
                    .await
                    .expect("the route answers in time")
                    .unwrap();
            let status = answered.status().as_u16();
            let bytes = axum::body::to_bytes(answered.into_body(), 1 << 20)
                .await
                .unwrap();
            let body = serde_json::from_slice(&bytes)
                .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into_owned()));
            (status, body)
        })
    }

    fn refused(status: u16, error: &str, message: &str) -> (u16, Value) {
        (status, json!({ "error": error, "message": message }))
    }

    /// A harness with one shell open, its id, and the runtime its requests run on.
    fn opened() -> (Harness, String, tokio::runtime::Runtime) {
        let h = setup(100);
        let runtime = crate::testing::runtime();
        let id = runtime.block_on(h.open("o")).unwrap();
        (h, id, runtime)
    }

    /// What a screen read of `id` answers once each fails with `err`.
    fn failing(err: TerminalError) -> (String, (u16, Value)) {
        let (h, id, runtime) = opened();
        h.fake.set(|state| state.screens_refused = Some(err));
        let answer = got(
            &runtime,
            socket_router(shared(&h)),
            &format!("/v1/terminals/{id}/screen"),
        );
        (id, answer)
    }

    #[test]
    fn answers_the_screen_after_the_history_asked_for_reading_each_count_as_hono_does() {
        let (h, id, runtime) = opened();
        h.fake.set(|state| {
            state.shown.insert(id.clone(), "$ make\nok\n".to_owned());
        });
        let at = |query: &str| format!("/v1/terminals/{id}/screen{query}");
        let read = [
            "",
            "?history=7",
            "?history=00042",
            "?history=%31%30",
            "?history=10000",
            "?history=3&history=x",
        ]
        .map(|query| got(&runtime, socket_router(shared(&h)), &at(query)));
        let shown = |history: u64| (200, json!({ "text": "$ make\nok\n", "history": history }));
        assert_eq!(
            read,
            [
                shown(0),
                shown(7),
                shown(42),
                shown(10),
                shown(10_000),
                shown(3)
            ]
        );
        let asked: Vec<u32> = h
            .fake
            .state
            .lock()
            .unwrap()
            .screens_read
            .iter()
            .map(|(_, n)| *n)
            .collect();
        assert_eq!(asked, [0, 7, 42, 10, 10_000, 3]);
    }

    #[test]
    fn refuses_a_history_that_isnt_a_whole_number_of_rows_up_to_10000_before_reading_anything() {
        let (h, id, runtime) = opened();
        let refusals = [
            "10001", "-1", "%2B1", "1.5", "x", "", "010000", "1e3", "%201", "%D9%A3", "99999",
        ]
        .map(|given| {
            got(
                &runtime,
                socket_router(shared(&h)),
                &format!("/v1/terminals/{id}/screen?history={given}"),
            )
        });
        let why = "history is a whole number of rows from 0 to 10000";
        assert_eq!(
            refusals,
            [(); 11].map(|()| refused(400, "invalid_request", why))
        );
        assert_eq!(h.fake.state.lock().unwrap().screens_read, []);
    }

    #[test]
    fn answers_not_found_for_no_terminal_and_for_one_running_nothing_now() {
        let (h, id, runtime) = opened();
        let gone = runtime.block_on(h.open("g")).unwrap();
        h.fake.gone(&gone);
        let read = |terminal: &str| {
            got(
                &runtime,
                socket_router(shared(&h)),
                &format!("/v1/terminals/{terminal}/screen"),
            )
        };
        let unknown = [read(UNKNOWN), read("nope")];
        let at_gone = read(&gone);
        h.fake.set(|state| {
            state.screens_refused = Some(TerminalError::Stale("its holder changed".to_owned()));
        });
        let stale = read(&id);
        assert_eq!(
            [unknown[0].clone(), unknown[1].clone(), at_gone, stale],
            [
                refused(404, "not_found", &format!("no terminal {UNKNOWN}")),
                refused(404, "not_found", "no terminal nope"),
                refused(404, "not_found", &format!("no running terminal {gone}")),
                refused(404, "not_found", &format!("no running terminal {id}")),
            ]
        );
    }

    #[test]
    fn answers_a_holder_before_screen_reads_or_one_this_build_cant_speak_to_as_needing_a_restart() {
        let (id, predates) = failing(TerminalError::Predates {
            what: "screen reads".to_owned(),
        });
        let (other, unservable) = failing(TerminalError::Unservable {
            protocol: vec!["0.9".to_owned(), "0.8".to_owned()],
            holder_pid: Some(77),
        });
        assert_eq!(
            [predates, unservable],
            [
                refused(
                    409,
                    "needs_restart",
                    &format!(
                        "terminal {id} runs on a holder that predates screen reads: restart it to use them"
                    )
                ),
                refused(
                    409,
                    "needs_restart",
                    &format!(
                        "terminal {other}: its holder speaks only 0.9, 0.8, which this build doesn't"
                    )
                ),
            ]
        );
    }

    #[test]
    fn answers_a_terminal_recorded_on_tmux_as_unsupported_asking_nothing_of_the_runtime() {
        let (h, id, runtime) = opened();
        rusqlite::Connection::open(h.dir.path().join("bazhen.db"))
            .unwrap()
            .execute("UPDATE terminals SET runtime = 'tmux' WHERE id = ?", [&id])
            .unwrap();
        let answer = got(
            &runtime,
            socket_router(shared(&h)),
            &format!("/v1/terminals/{id}/screen?history=5"),
        );
        assert_eq!(
            answer,
            refused(
                422,
                "unsupported",
                &format!(
                    "terminal {id} runs on tmux, whose screens can't be read: only a holder terminal's can"
                )
            )
        );
        assert_eq!(h.fake.state.lock().unwrap().screens_read, []);
    }

    #[test]
    fn answers_unavailable_while_the_screen_or_what_runs_it_cant_be_read_just_now() {
        let (unreadable, lost) = failing(TerminalError::Unreadable {
            reason: "holder connection ended: hung up".to_owned(),
        });
        let (unconfirmed, unsure) = failing(TerminalError::Unconfirmed("x".to_owned()));
        let (unreachable, refusing) = failing(TerminalError::Unreachable("x".to_owned()));
        assert_eq!(
            [lost, unsure, refusing],
            [
                refused(
                    503,
                    "unavailable",
                    &format!(
                        "terminal {unreadable}'s screen can't be read: holder connection ended: hung up"
                    )
                ),
                refused(
                    503,
                    "unavailable",
                    &format!("terminal {unconfirmed}: its server may still be running it")
                ),
                refused(
                    503,
                    "unavailable",
                    &format!("terminal {unreachable}: what runs it can't be reached")
                ),
            ]
        );
    }

    /// How many rows each table that records a terminal's use holds, and how many events.
    fn uses(h: &Harness) -> [i64; 3] {
        let db = rusqlite::Connection::open(h.dir.path().join("bazhen.db")).unwrap();
        ["attachments_open", "leases", "events"].map(|table| {
            db.query_row(&format!("SELECT count(*) FROM {table}"), (), |row| {
                row.get(0)
            })
            .unwrap()
        })
    }

    #[test]
    fn reads_over_the_socket_and_http_taking_no_lease_and_sending_the_terminal_nothing() {
        let (h, id, runtime) = opened();
        let [attachments, leases, events] = uses(&h);
        let gate = Gate {
            allow: crate::guard::allowlists(7900, None, &[]),
            pairing_required: false,
        };
        let path = format!("/v1/terminals/{id}/screen?history=5");
        let read = [
            got(&runtime, socket_router(shared(&h)), &path),
            got(&runtime, http_router(shared(&h), gate), &path),
        ];
        assert_eq!(read.map(|(status, _)| status), [200, 200]);
        let state = h.fake.state.lock().unwrap();
        assert_eq!(
            (
                state.screens_read.clone(),
                state.pasted.clone(),
                state.closed.clone(),
                state.unlinked.clone(),
            ),
            (
                vec![(id.clone(), 5), (id.clone(), 5)],
                vec![],
                vec![],
                vec![]
            )
        );
        drop(state);
        assert_eq!((attachments, leases, uses(&h)), (0, 0, [0, 0, events]));
        assert_eq!(
            h.state_of(&id),
            Some(bazhen_protocol::shells::TerminalState::Running)
        );
    }
}
