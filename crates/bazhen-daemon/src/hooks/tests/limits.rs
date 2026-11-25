//! Usage and limits: a stop the account's limit may explain recorded `limited` when the usage
//! shows a window used up, and weighed again as a late reading of the meter comes, while the stop
//! still stands.

use bazhen_harness::LimitStop;
use bazhen_protocol::agents::{Activity, ActivityValue, Usage, UsageLimit};
use jiff::{SignedDuration, Timestamp};
use serde_json::json;

use super::*;

/// When each test's stop is.
fn t0() -> Timestamp {
    "2026-11-25T10:00:00Z".parse().unwrap()
}

fn mins(n: i64) -> SignedDuration {
    SignedDuration::from_mins(n)
}

fn doing(value: ActivityValue, at: Timestamp) -> Activity {
    Activity {
        value,
        source: bazhen_protocol::agents::ActivitySource::Native,
        confidence: 1.0,
        observed_at: format!("{at:.3}"),
        detail: Some("rate_limit".to_owned()),
        resets_at: None,
    }
}

/// Usage whose windows are each used `used` percent, and reset at `resets_at`.
fn usage(windows: &[(&str, f64, Option<&str>)]) -> Usage {
    Usage {
        model: None,
        context_used_percent: None,
        context_window_tokens: None,
        limits: Some(
            windows
                .iter()
                .map(|(window, used, resets)| UsageLimit {
                    window: (*window).to_owned(),
                    used_percent: *used,
                    resets_at: resets.map(str::to_owned),
                })
                .collect(),
        ),
    }
}

impl Fixture {
    /// Records `activity`, the harness's word on why it stopped being `limit`, at `now`.
    async fn stopped(&self, activity: Activity, limit: Option<LimitStop>, now: Timestamp) {
        let (limits, agent) = (Arc::clone(&self.shared.hooks.limits), self.agent.clone());
        write(&self.shared.store, move |w| {
            limits.record(w, &agent, activity, limit, now)
        })
        .await
        .unwrap();
    }

    async fn read(&self, usage: Usage, now: Timestamp) {
        let (limits, agent) = (Arc::clone(&self.shared.hooks.limits), self.agent.clone());
        write(&self.shared.store, move |w| {
            limits.usage(w, &agent, &usage, now)
        })
        .await
        .unwrap();
    }

    /// What the agent was last recorded doing: its value and reset.
    fn latest(&self) -> (String, Option<String>) {
        let reader = self.shared.store.reader().unwrap();
        let latest = reader
            .reads()
            .latest_activity(self.agent.as_str())
            .unwrap()
            .unwrap();
        (latest.value.as_str().to_owned(), latest.resets_at)
    }
}

const SOON: &str = "2026-11-25T11:00:00.000Z";
const LATER: &str = "2026-11-25T12:30:00.000Z";

fn is(value: &str, resets: Option<&str>) -> (String, Option<String>) {
    (value.to_owned(), resets.map(str::to_owned))
}

#[test]
fn records_a_stop_limited_only_as_the_usage_or_the_harness_says_its_account_is_spent() {
    let f = fixture();
    runtime().block_on(async {
        let failed = || doing(ActivityValue::Failed, t0());
        // A rate stop with no window used up may be a passing 429.
        f.stopped(failed(), Some(LimitStop::Rate), t0()).await;
        let passing = f.latest();
        // A quota stop is the account's limit by the harness's word.
        f.stopped(failed(), Some(LimitStop::Quota), t0()).await;
        let quota = f.latest();
        // A window used up, and another; and one whose later text is the earlier time.
        f.read(
            usage(&[
                ("five_hour", 100.0, Some(SOON)),
                ("weekly", 100.0, Some(LATER)),
                ("offset", 100.0, Some("2026-11-25T13:00:00+02:00")),
                ("half", 50.0, Some("2026-11-26T00:00:00.000Z")),
            ]),
            t0(),
        )
        .await;
        f.stopped(failed(), Some(LimitStop::Rate), t0()).await;
        let spent = f.latest();
        assert_eq!(
            (passing, quota, spent),
            (
                is("failed", None),
                is("limited", None),
                is("limited", Some(LATER))
            )
        );
    });
}

#[test]
fn weighs_a_stop_again_against_a_reading_of_the_meter_that_comes_within_minutes_of_it() {
    let f = fixture();
    runtime().block_on(async {
        let spent = |resets| usage(&[("five_hour", 100.0, Some(resets))]);
        f.stopped(
            doing(ActivityValue::Failed, t0()),
            Some(LimitStop::Rate),
            t0(),
        )
        .await;
        // A reading with no window used up, or one only whose reset has passed, says nothing of
        // this stop.
        let passed = "2026-11-25T09:00:00.000Z";
        f.read(
            usage(&[
                ("five_hour", 40.0, Some(SOON)),
                ("old", 100.0, Some(passed)),
            ]),
            t0() + mins(1),
        )
        .await;
        let unspent = f.latest();
        f.read(spent(SOON), t0() + mins(2)).await;
        let read_late = f.latest();
        // Past five minutes, a reading is about the account since.
        f.read(spent(LATER), t0() + mins(8)).await;
        assert_eq!(
            (unspent, read_late, f.latest()),
            (
                is("failed", None),
                is("limited", Some(SOON)),
                is("limited", Some(SOON))
            )
        );
    });
}

#[test]
fn weighs_no_stop_again_once_the_agent_has_gone_on() {
    let f = fixture();
    runtime().block_on(async {
        let failed = |at| doing(ActivityValue::Failed, at);
        f.stopped(failed(t0()), Some(LimitStop::Rate), t0()).await;
        // Through the limits, an activity with no stop forgets the one before it.
        let working = doing(ActivityValue::Working, t0() + mins(1));
        f.stopped(working, None, t0() + mins(1)).await;
        f.read(usage(&[("a", 100.0, Some(SOON))]), t0() + mins(2))
            .await;
        let forgotten = f.latest();
        // Recorded past the limits, as another lane may, a newer activity stands all the same.
        let again = t0() + mins(3);
        f.stopped(failed(again), Some(LimitStop::Rate), again).await;
        let stopped = f.latest();
        let (agent, working) = (
            f.agent.clone(),
            doing(ActivityValue::Working, t0() + mins(4)),
        );
        write(&f.shared.store, move |w| {
            w.record_activity(&agent, &working)
        })
        .await
        .unwrap();
        f.read(usage(&[("a", 100.0, Some(LATER))]), t0() + mins(5))
            .await;
        assert_eq!(
            (forgotten, stopped, f.latest()),
            (
                is("working", None),
                is("limited", Some(SOON)),
                is("working", None)
            )
        );
    });
}

#[test]
fn records_a_turn_its_account_stopped_limited_once_its_status_line_shows_the_window_spent() {
    let f = fixture();
    let resets = Timestamp::now() + SignedDuration::from_hours(2);
    let statusline = json!({
        "session_id": "session-1",
        "model": { "display_name": "Opus" },
        "rate_limits": {
            "five_hour": { "used_percentage": 100, "resets_at": resets.as_second() },
        },
    });
    f.hook(
        "StopFailure",
        &failure("session-1", "rate_limit"),
        its_tui(),
    );
    let stopped = f.latest();
    f.hook("statusline", &statusline, its_tui());
    f.hook("statusline", &statusline, its_tui());
    let resets_at = format!("{:.3}", Timestamp::from_second(resets.as_second()).unwrap());
    assert_eq!(
        (stopped, f.latest(), f.of("agent.usage").len()),
        (is("failed", None), is("limited", Some(&resets_at)), 1)
    );
}
