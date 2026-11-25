//! Usage and limits: a stop the account's limit may explain recorded `limited` when the usage
//! shows a window used up, and weighed again as a late reading of the meter comes, while the stop
//! still stands.

use std::collections::HashSet;

use bazhen_harness::LimitStop;
use bazhen_protocol::agents::{Activity, ActivityValue, USAGE_LIMITS_MAX, Usage, UsageLimit};
use jiff::{SignedDuration, Timestamp};
use serde_json::json;

use super::*;
use crate::hooks::limits::merge_limits;

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

#[test]
fn gives_an_accounts_update_to_each_agent_on_it_kept_beside_what_else_its_usage_holds() {
    let f = fixture();
    let bob = with_bob(&f);
    runtime().block_on(async {
        let spent = UsageLimit {
            window: "codex.primary".to_owned(),
            used_percent: 100.0,
            resets_at: Some(SOON.to_owned()),
        };
        let other = UsageLimit {
            window: "codex.secondary".to_owned(),
            used_percent: 20.0,
            resets_at: None,
        };
        let mut held = usage(&[
            ("codex.primary", 50.0, None),
            ("codex.secondary", 20.0, None),
        ]);
        held.model = Some("gpt".to_owned());
        let (limits, agent) = (Arc::clone(&f.shared.hooks.limits), bob.clone());
        write(&f.shared.store, move |w| {
            limits.usage(w, &agent, &held, t0())
        })
        .await
        .unwrap();
        f.stopped(
            doing(ActivityValue::Failed, t0()),
            Some(LimitStop::Rate),
            t0(),
        )
        .await;
        let (limits, agents, update) = (
            Arc::clone(&f.shared.hooks.limits),
            vec![f.agent.clone(), bob.clone()],
            vec![spent.clone()],
        );
        write(&f.shared.store, move |w| {
            limits.account_limits(w, &agents, &update, t0())
        })
        .await
        .unwrap();
        let reader = f.shared.store.reader().unwrap();
        let usage_of = |agent: &AgentId| reader.reads().agent_usage(agent.as_str()).unwrap();
        let mut bobs = usage(&[]);
        bobs.model = Some("gpt".to_owned());
        bobs.limits = Some(vec![spent.clone(), other]);
        assert_eq!(
            (usage_of(&f.agent), usage_of(&bob), f.latest()),
            (
                Some(Usage {
                    limits: Some(vec![spent]),
                    ..usage(&[])
                }),
                Some(bobs),
                is("limited", Some(SOON))
            )
        );
    });
}

/// A limit of `window`, used `used` percent.
fn limit(window: &str, used: f64) -> UsageLimit {
    UsageLimit {
        window: window.to_owned(),
        used_percent: used,
        resets_at: None,
    }
}

fn windows(limits: &[UsageLimit]) -> Vec<String> {
    limits.iter().map(|limit| limit.window.clone()).collect()
}

#[test]
fn merges_an_update_into_the_limits_held_replacing_those_it_names_and_keeping_the_rest() {
    let (primary, secondary) = (limit("codex.primary", 10.0), limit("codex.secondary", 40.0));
    let spent = limit("codex.primary", 100.0);
    let again = limit("codex.primary", 12.0);
    assert_eq!(
        (
            merge_limits(None, std::slice::from_ref(&primary)),
            merge_limits(
                Some(&[primary.clone(), secondary.clone()]),
                std::slice::from_ref(&spent)
            ),
            merge_limits(None, &[primary.clone(), again.clone()]),
            merge_limits(
                Some(std::slice::from_ref(&primary)),
                &[primary.clone(), again.clone()]
            ),
        ),
        (
            vec![primary],
            vec![spent, secondary],
            vec![again.clone()],
            vec![again]
        )
    );
}

#[test]
fn keeps_no_more_limits_than_usage_holds_dropping_first_the_oldest_the_update_leaves_out() {
    let named = |n: usize| {
        (0..n)
            .map(|i| limit(&format!("w{i}"), 1.0))
            .collect::<Vec<_>>()
    };
    // An update that alone names more keeps the first it names.
    let update = named(USAGE_LIMITS_MAX + 5);
    let alone = merge_limits(
        Some(&[limit(&format!("w{}", USAGE_LIMITS_MAX + 4), 1.0)]),
        &update,
    );
    let held = named(USAGE_LIMITS_MAX);
    let merged = merge_limits(Some(&held), &[limit("new", 1.0), limit("w5", 99.0)]);
    assert_eq!(
        (
            windows(&alone),
            merged.len(),
            merged.first().map(|l| l.window.clone()),
            merged.last().map(|l| l.window.clone()),
            merged
                .iter()
                .find(|l| l.window == "w5")
                .map(|l| l.used_percent),
        ),
        (
            windows(&update[..USAGE_LIMITS_MAX]),
            USAGE_LIMITS_MAX,
            Some("w1".to_owned()),
            Some("new".to_owned()),
            Some(99.0)
        )
    );
}

mod merging {
    use proptest::prelude::*;

    use super::*;

    /// Limits of windows drawn from a few more than usage holds, so updates name the same window
    /// twice, and name as many as usage holds, often enough.
    fn limits(most: usize) -> impl Strategy<Value = Vec<UsageLimit>> {
        prop::collection::vec((0..USAGE_LIMITS_MAX + 10, 0u8..=100), 0..=most).prop_map(|drawn| {
            drawn
                .into_iter()
                .map(|(w, used)| limit(&format!("w{w}"), f64::from(used)))
                .collect()
        })
    }

    /// Limits as usage holds them: each window once, and no more than it holds.
    fn held() -> impl Strategy<Value = Vec<UsageLimit>> {
        limits(USAGE_LIMITS_MAX * 2).prop_map(|drawn| {
            let mut seen = HashSet::new();
            let mut held: Vec<UsageLimit> = drawn
                .into_iter()
                .filter(|l| seen.insert(l.window.clone()))
                .collect();
            held.truncate(USAGE_LIMITS_MAX);
            held
        })
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(4096))]

        /// Each window once, no more than usage holds, each as the update last names it or else
        /// as held, and every window the update names kept unless it alone names as many as
        /// usage holds, when the first it names are.
        #[test]
        fn a_merge_holds_each_window_once_as_last_said_within_the_most_usage_holds(
            held in held(),
            update in limits(USAGE_LIMITS_MAX * 2),
        ) {
            let merged = merge_limits(Some(&held), &update);
            let said = |window: &str| {
                update.iter().rev().chain(&held).find(|l| l.window == window).cloned()
            };
            let mut named: Vec<String> = Vec::new();
            for limit in &update {
                if !named.contains(&limit.window) {
                    named.push(limit.window.clone());
                }
            }
            let unique: HashSet<String> = windows(&merged).into_iter().collect();
            prop_assert!(merged.len() <= USAGE_LIMITS_MAX);
            prop_assert_eq!(unique.len(), merged.len());
            for limit in &merged {
                prop_assert_eq!(Some(limit.clone()), said(&limit.window));
            }
            if named.len() >= USAGE_LIMITS_MAX {
                prop_assert_eq!(windows(&merged), named[..USAGE_LIMITS_MAX].to_vec());
            } else {
                // Those held first, in their order, then those new, in the update's; of those
                // the update leaves out, the newest held, as many as there is room for.
                let left_out: Vec<String> =
                    windows(&held).into_iter().filter(|w| !named.contains(w)).collect();
                let room = USAGE_LIMITS_MAX - named.len();
                let kept = &left_out[left_out.len().saturating_sub(room)..];
                let order: Vec<String> = windows(&held)
                    .into_iter()
                    .chain(named.iter().filter(|w| !windows(&held).contains(w)).cloned())
                    .filter(|w| named.contains(w) || kept.contains(w))
                    .collect();
                prop_assert_eq!(windows(&merged), order);
            }
        }
    }
}
