//! The lines restarts are to type into their new shells (`shells/retype.ts`), held in memory
//! only, never written anywhere, until the new shell reports its first prompt. Each is typed once
//! at most; dropped at once if the shell's integration says at that prompt that it won't take one;
//! and dropped if no prompt comes in time: the shell's integration didn't load. A log names the
//! shell, never the line.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use bazhen_protocol::shells::shell_command_line;
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

use crate::terminals::{Recorded, Terminals};

/// How long a restarted shell has to report its first prompt before its line is dropped.
pub(crate) const RETYPE_WITHIN: Duration = Duration::from_secs(30);

/// How long a paste waits for the shell to hold its foreground again, and how often it looks.
const FOREGROUND_WAIT: Duration = Duration::from_millis(3000);
const FOREGROUND_POLL: Duration = Duration::from_millis(100);

/// What the daemon logs for a shell whose integration said it won't take a line typed back.
const DECLINED: &str = "the shell's integration said it can't take a line typed back";

/// Says why the line held for the shell `terminal_id` wasn't typed, never naming the line.
pub(crate) fn skipped(terminal_id: &str, why: &str) {
    tracing::warn!("shell {terminal_id}: last command not retyped: {why}");
}

struct Pending {
    line: String,
    /// Where the shell runs, once its start has answered.
    at: Option<Recorded>,
    /// `None` until the shell reports its prompt; then whether its editor reads a marked paste.
    brackets: Option<bool>,
    /// Which hold this is, so an expiry ends only its own.
    hold: u64,
    expiry: CancellationToken,
}

/// A line to type now: where, and whether marked as a paste.
pub(crate) struct Typing {
    pub(crate) terminal_id: String,
    pub(crate) at: Recorded,
    pub(crate) line: String,
    pub(crate) brackets: bool,
}

/// The line may hold a secret typed at the shell's prompt, so it is never shown.
impl std::fmt::Debug for Typing {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Typing")
            .field("terminal_id", &self.terminal_id)
            .field("at", &self.at)
            .field("brackets", &self.brackets)
            .finish_non_exhaustive()
    }
}

/// The lines held, each until its shell's first prompt, for no longer than [`RETYPE_WITHIN`], and
/// none past the daemon's stop.
#[derive(Clone)]
pub(crate) struct PendingRetypes {
    pending: Arc<Mutex<HashMap<String, Pending>>>,
    holds: Arc<std::sync::atomic::AtomicU64>,
    tracker: TaskTracker,
    stop: CancellationToken,
}

/// By the shells held for alone: a line is never shown.
impl std::fmt::Debug for PendingRetypes {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let held: Vec<String> = self.lock().keys().cloned().collect();
        f.debug_struct("PendingRetypes")
            .field("held", &held)
            .finish_non_exhaustive()
    }
}

impl PendingRetypes {
    /// Lines held on `tracker`'s tasks, each dropped unsaid once `stop` is cancelled.
    pub(crate) fn new(tracker: TaskTracker, stop: CancellationToken) -> Self {
        Self {
            pending: Arc::default(),
            holds: Arc::default(),
            tracker,
            stop,
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Pending>> {
        self.pending.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Holds `line` for the shell `terminal_id`, recorded but not yet started.
    pub(crate) fn hold(&self, terminal_id: &str, line: String) {
        self.drop(terminal_id);
        let hold = self
            .holds
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let expiry = self.stop.child_token();
        self.lock().insert(
            terminal_id.to_owned(),
            Pending {
                line,
                at: None,
                brackets: None,
                hold,
                expiry: expiry.clone(),
            },
        );
        let (pending, id) = (Arc::clone(&self.pending), terminal_id.to_owned());
        self.tracker.spawn(async move {
            if expiry
                .run_until_cancelled(tokio::time::sleep(RETYPE_WITHIN))
                .await
                .is_none()
            {
                return;
            }
            let mut pending = pending.lock().unwrap_or_else(PoisonError::into_inner);
            if pending.get(&id).is_some_and(|held| held.hold == hold) {
                pending.remove(&id);
                skipped(
                    &id,
                    &format!("no prompt reported within {} s", RETYPE_WITHIN.as_secs()),
                );
            }
        });
    }

    /// The shell started at `at`; a prompt it reported meanwhile gets its line now.
    pub(crate) fn opened(&self, terminal_id: &str, at: Recorded) -> Option<Typing> {
        let mut pending = self.lock();
        let held = pending.get_mut(terminal_id)?;
        held.at = Some(at);
        held.brackets?;
        typed(&mut pending, terminal_id)
    }

    /// The shell reported its first prompt: its line is typed, once it is known where. A later
    /// report changes nothing: the first is the shell's integration's own, at its first prompt.
    pub(crate) fn prompted(&self, terminal_id: &str, brackets: bool) -> Option<Typing> {
        let mut pending = self.lock();
        let held = pending.get_mut(terminal_id)?;
        if held.brackets.is_some() {
            return None;
        }
        held.brackets = Some(brackets);
        held.at.as_ref()?;
        typed(&mut pending, terminal_id)
    }

    /// The shell reached its first prompt and said it won't take a line typed back, as a fish too
    /// new for the check before a paste: its line is dropped now, not once its time to report runs
    /// out. Like a prompt, only its first report counts.
    pub(crate) fn declined(&self, terminal_id: &str) {
        let mut pending = self.lock();
        if pending
            .get(terminal_id)
            .is_none_or(|held| held.brackets.is_some())
        {
            return;
        }
        if let Some(held) = pending.remove(terminal_id) {
            held.expiry.cancel();
        }
        skipped(terminal_id, DECLINED);
    }

    /// Forgets the shell's line, as for one that failed to open.
    pub(crate) fn drop(&self, terminal_id: &str) {
        if let Some(held) = self.lock().remove(terminal_id) {
            held.expiry.cancel();
        }
    }
}

/// The line held for `terminal_id`, taken to be typed: checked again as it is, so whatever held
/// it, nothing but a line safe to type gets past.
fn typed(pending: &mut HashMap<String, Pending>, terminal_id: &str) -> Option<Typing> {
    let held = pending.remove(terminal_id)?;
    held.expiry.cancel();
    let at = held.at?;
    if !shell_command_line(&held.line) {
        skipped(terminal_id, "it is not a line that can be typed safely");
        return None;
    }
    Some(Typing {
        terminal_id: terminal_id.to_owned(),
        at,
        line: held.line,
        brackets: held.brackets == Some(true),
    })
}

/// Types a restart's line at its new shell's prompt, only while the shell itself holds the
/// terminal's foreground: a program the user started meanwhile, as one typed ahead while the shell
/// started, or a password prompt, would take the line as its own input. A program the prompt runs,
/// as `git status` or a zle-line-init widget's, holds it for a moment, so the paste waits for the
/// shell to have it again, for a while, then gives up. Why it typed nothing never names the line.
pub(crate) async fn paste(terminals: &dyn Terminals, typing: &Typing) -> Result<(), String> {
    let mut waited = Duration::ZERO;
    loop {
        let program = terminals
            .foreground(&typing.at)
            .await
            .map_err(|e| e.to_string())?;
        let Some(program) = program else {
            return terminals
                .paste(&typing.at, &typing.line, typing.brackets)
                .await
                .map_err(|e| e.to_string());
        };
        if waited >= FOREGROUND_WAIT {
            return Err(format!("{program} kept the shell's foreground"));
        }
        tokio::time::sleep(FOREGROUND_POLL).await;
        waited += FOREGROUND_POLL;
    }
}

#[cfg(test)]
mod tests {
    use bazhen_protocol::ids::TerminalId;
    use bazhen_protocol::shells::{
        RestartShellRequest, ShellDecline, ShellPrompt, ShellReport, TerminalState,
    };
    use bazhen_store::TerminalChange;

    use super::*;
    use crate::shells::ShellError;
    use crate::shells::tests::{Harness, Said, integration, setup_with};
    use crate::terminals::TerminalError;
    use crate::testing::runtime;

    const LINE: &str = r#"echo "$HOME" 'a  b' TOKEN=s3cret"#;

    /// Lets the tasks the daemon spawned run as far as they can without time passing.
    async fn settle() {
        for _ in 0..20 {
            tokio::task::yield_now().await;
        }
    }

    /// Lets `by` pass on a paused clock, running what falls due in that time in order, each as it
    /// comes due, so a wait that sets the next one sees that come due too.
    async fn pass(by: Duration) {
        tokio::time::sleep(by).await;
        settle().await;
    }

    /// A lost shell, opened with the integration on, whose integration reported `line` first.
    async fn lost_shell(h: &Harness, line: Option<&str>) -> (String, String) {
        let id = h.open("lost").await.unwrap();
        let token = h.token_of(&id).unwrap();
        if let Some(line) = line {
            let report = ShellReport {
                token: token.clone(),
                at: 1,
                command: Some(line.to_owned()),
            };
            h.shells.report(&id, report).await.unwrap();
        }
        h.fake.set(|state| {
            state.running.remove(&id);
        });
        h.mark(&id, TerminalChange::Lost).await;
        (id, token)
    }

    fn restarting(key: &str, retype: bool) -> RestartShellRequest {
        RestartShellRequest {
            idempotency_key: key.to_owned(),
            generation: 0,
            theme: None,
            retype: retype.then_some(true),
        }
    }

    impl Harness {
        /// Restarts the lost shell `lost`, asking to retype its line where `retype` says so.
        async fn restarted(&self, lost: &str, retype: bool) -> String {
            let restarted = self
                .shells
                .restart(lost, &restarting("r", retype), None)
                .await
                .unwrap();
            restarted.terminal_id.as_str().to_owned()
        }

        /// The shell `id`'s integration reports its first prompt with `token`, its own if `None`.
        async fn prompt(&self, id: &str, token: Option<&str>, brackets: Option<bool>) -> bool {
            let token = token.map_or_else(|| self.token_of(id).unwrap(), str::to_owned);
            let prompt = ShellPrompt { token, brackets };
            self.shells.prompt(id, &prompt).await.unwrap()
        }

        async fn decline(&self, id: &str, token: Option<&str>) -> bool {
            let token = token.map_or_else(|| self.token_of(id).unwrap(), str::to_owned);
            let decline = ShellDecline { token };
            self.shells.decline(id, &decline).await.unwrap()
        }

        fn pasted(&self) -> Vec<(String, String, bool)> {
            self.fake.state.lock().unwrap().pasted.clone()
        }

        /// Whether the state offers the shell `id` to restart with its line typed back, where
        /// new shells report as `reports` says.
        fn retypeable_while(&self, id: &str, reports: bool) -> Option<bool> {
            let view = bazhen_store::SnapshotView {
                host: "h".to_owned(),
                restart_holders: std::collections::HashMap::new(),
                shells_report: reports,
            };
            let reader = self.store.reader().unwrap();
            let shells = reader.reads().snapshot(&view).unwrap().shells;
            shells
                .into_iter()
                .find(|shell| shell.id.as_str() == id)
                .map(|shell| shell.retypeable)
        }

        fn retypeable(&self, id: &str) -> Option<bool> {
            self.listed()
                .into_iter()
                .find(|shell| shell.id.as_str() == id)
                .map(|shell| shell.retypeable)
        }
    }

    fn typed(id: &str, brackets: bool) -> (String, String, bool) {
        (id.to_owned(), LINE.to_owned(), brackets)
    }

    fn not_retyped(id: &str, why: &str) -> String {
        format!("shell {id}: last command not retyped: {why}")
    }

    #[test]
    fn offers_it_only_for_a_lost_shell_whose_line_was_kept_while_new_shells_can_report() {
        let kept = setup_with(100, Some(integration()));
        let none = setup_with(100, Some(integration()));
        let off = setup_with(100, Some(integration()));
        runtime().block_on(async {
            let (lost, _) = lost_shell(&kept, Some(LINE)).await;
            let (unkept, _) = lost_shell(&none, None).await;
            let (unoffered, _) = lost_shell(&off, Some(LINE)).await;
            let unreporting = off.again(None);
            let offered = [
                kept.retypeable(&lost),
                none.retypeable(&unkept),
                off.retypeable_while(&unoffered, unreporting.reports()),
            ];
            let running = kept.restarted(&lost, false).await;
            let report = ShellReport {
                token: kept.token_of(&running).unwrap(),
                at: 2,
                command: Some("make".to_owned()),
            };
            kept.shells.report(&running, report).await.unwrap();
            assert_eq!(
                (
                    offered,
                    kept.last_command(&running),
                    kept.retypeable(&running)
                ),
                (
                    [Some(true), Some(false), Some(false)],
                    Some("make".to_owned()),
                    Some(false)
                )
            );
        });
    }

    #[test]
    fn types_the_line_exactly_only_once_the_new_shell_reports_its_first_prompt_and_once() {
        let h = setup_with(100, Some(integration()));
        runtime().block_on(async {
            let (lost, _) = lost_shell(&h, Some(LINE)).await;
            let id = h.restarted(&lost, true).await;
            settle().await;
            let before = h.pasted();
            let first = h.prompt(&id, None, None).await;
            settle().await;
            let second = h.prompt(&id, None, None).await;
            settle().await;
            assert_eq!(
                (before, first, second, h.pasted()),
                (vec![], true, true, vec![typed(&id, false)])
            );
        });
    }

    #[test]
    fn marks_the_paste_itself_only_where_the_shell_s_own_prompt_report_says_its_editor_reads_one() {
        let mut typed_as = Vec::new();
        for brackets in [Some(true), Some(false), None] {
            let h = setup_with(100, Some(integration()));
            let said = Said::default();
            let _logging = said.logging();
            runtime().block_on(async {
                let (lost, _) = lost_shell(&h, Some(LINE)).await;
                let id = h.restarted(&lost, true).await;
                h.prompt(&id, None, brackets).await;
                settle().await;
                typed_as.push((
                    h.pasted().into_iter().map(|p| p.2).collect::<Vec<_>>(),
                    said.times("not retyped"),
                ));
            });
        }
        assert_eq!(
            typed_as,
            [(vec![true], 0), (vec![false], 0), (vec![false], 0)]
        );
    }

    #[test]
    fn types_nothing_while_a_program_other_than_the_shell_keeps_its_foreground_and_says_so() {
        let h = setup_with(100, Some(integration()));
        let said = Said::default();
        let _logging = said.logging();
        runtime().block_on(async {
            let (lost, _) = lost_shell(&h, Some(LINE)).await;
            let id = h.restarted(&lost, true).await;
            h.fake.run_in_foreground(&id, "vim");
            h.prompt(&id, None, None).await;
            tokio::time::pause();
            pass(Duration::from_millis(2_900)).await;
            let early = said.times("not retyped");
            pass(Duration::from_millis(200)).await;
            assert_eq!((early, h.pasted()), (0, vec![]));
            assert_eq!(
                said.times(&not_retyped(&id, "vim kept the shell's foreground")),
                1
            );
        });
    }

    #[test]
    fn types_nothing_behind_input_typed_ahead_of_it_and_says_why_in_the_runtime_s_words() {
        let h = setup_with(100, Some(integration()));
        let said = Said::default();
        let _logging = said.logging();
        runtime().block_on(async {
            let (lost, _) = lost_shell(&h, Some(LINE)).await;
            let id = h.restarted(&lost, true).await;
            h.fake.set(|state| {
                state.pastes_refused = Some(TerminalError::Other(
                    "the shell isn't reading at its prompt".to_owned(),
                ));
            });
            h.prompt(&id, None, None).await;
            settle().await;
            assert_eq!(
                said.times(&not_retyped(&id, "the shell isn't reading at its prompt")),
                1
            );
            assert_eq!(said.times("s3cret"), 0);
        });
    }

    #[test]
    fn waits_for_the_shell_to_hold_its_foreground_again_as_after_a_program_its_prompt_runs() {
        let h = setup_with(100, Some(integration()));
        runtime().block_on(async {
            let (lost, _) = lost_shell(&h, Some(LINE)).await;
            let id = h.restarted(&lost, true).await;
            h.fake.run_in_foreground(&id, "git");
            h.prompt(&id, None, None).await;
            tokio::time::pause();
            pass(Duration::from_millis(500)).await;
            let waiting = h.pasted();
            h.fake.at_prompt(&id, None);
            pass(Duration::from_millis(100)).await;
            assert_eq!((waiting, h.pasted()), (vec![], vec![typed(&id, false)]));
        });
    }

    #[test]
    fn types_nothing_into_a_shell_restarted_without_asking_to_retype() {
        let h = setup_with(100, Some(integration()));
        runtime().block_on(async {
            let (lost, _) = lost_shell(&h, Some(LINE)).await;
            let id = h.restarted(&lost, false).await;
            h.prompt(&id, None, None).await;
            settle().await;
            assert_eq!(h.pasted(), vec![]);
        });
    }

    #[test]
    fn types_nothing_for_a_prompt_report_that_isn_t_the_new_shell_s_own() {
        let h = setup_with(100, Some(integration()));
        runtime().block_on(async {
            let (lost, lost_token) = lost_shell(&h, Some(LINE)).await;
            let id = h.restarted(&lost, true).await;
            let refused = [
                h.prompt(&id, Some(""), None).await,
                h.prompt(&id, Some("forged"), None).await,
                h.prompt(&id, Some(&lost_token), None).await,
                h.prompt(&lost, Some(&lost_token), None).await,
            ];
            settle().await;
            assert_eq!((refused, h.pasted()), ([false; 4], vec![]));
        });
    }

    #[test]
    fn types_nothing_once_its_time_to_report_a_prompt_has_passed_and_logs_that_without_the_line() {
        let h = setup_with(100, Some(integration()));
        let said = Said::default();
        let _logging = said.logging();
        runtime().block_on(async {
            let (lost, _) = lost_shell(&h, Some(LINE)).await;
            // The line is held from some time in the restart, which takes real time to answer.
            let asked = tokio::time::Instant::now();
            let id = h.restarted(&lost, true).await;
            let answered = tokio::time::Instant::now();
            tokio::time::pause();
            let short = Duration::from_millis(1) + asked.elapsed();
            pass(RETYPE_WITHIN.checked_sub(short).unwrap()).await;
            let early = said.times("not retyped");
            pass(answered - asked + Duration::from_millis(1)).await;
            let expired = said.times(&not_retyped(&id, "no prompt reported within 30 s"));
            h.prompt(&id, None, None).await;
            settle().await;
            assert_eq!((early, expired, h.pasted()), (0, 1, vec![]));
            assert_eq!(said.times("not retyped"), 1);
            assert_eq!(said.times("s3cret"), 0);
        });
    }

    #[test]
    fn drops_the_line_as_soon_as_the_new_shell_says_it_won_t_take_one_and_logs_that_without_the_line()
     {
        let h = setup_with(100, Some(integration()));
        let said = Said::default();
        let _logging = said.logging();
        runtime().block_on(async {
            let (lost, _) = lost_shell(&h, Some(LINE)).await;
            let id = h.restarted(&lost, true).await;
            let declined = h.decline(&id, None).await;
            let at = said.times(&not_retyped(&id, DECLINED));
            h.prompt(&id, None, None).await;
            tokio::time::pause();
            pass(RETYPE_WITHIN).await;
            assert_eq!((declined, at, h.pasted()), (true, 1, vec![]));
            assert_eq!(said.times("not retyped"), 1);
            assert_eq!(said.times("s3cret"), 0);
        });
    }

    #[test]
    fn keeps_the_line_for_a_word_that_it_won_t_take_one_that_isn_t_the_new_shell_s_own() {
        let h = setup_with(100, Some(integration()));
        let said = Said::default();
        let _logging = said.logging();
        runtime().block_on(async {
            let (lost, lost_token) = lost_shell(&h, Some(LINE)).await;
            let id = h.restarted(&lost, true).await;
            let refused = [
                h.decline(&id, Some("forged")).await,
                h.decline(&id, Some(&lost_token)).await,
                h.decline(&lost, Some(&lost_token)).await,
            ];
            h.prompt(&id, None, None).await;
            settle().await;
            assert_eq!(
                (refused, h.pasted(), said.times("not retyped")),
                ([false; 3], vec![typed(&id, false)], 0)
            );
        });
    }

    #[test]
    fn refuses_to_retype_a_shell_with_no_line_kept_or_with_the_integration_off_and_stays_lost() {
        let none = setup_with(100, Some(integration()));
        let off = setup_with(100, Some(integration()));
        runtime().block_on(async {
            let (unkept, _) = lost_shell(&none, None).await;
            let (kept, _) = lost_shell(&off, Some(LINE)).await;
            let unreporting = off.again(None);
            let refused = [
                none.shells
                    .restart(&unkept, &restarting("r", true), None)
                    .await,
                unreporting
                    .restart(&kept, &restarting("r", true), None)
                    .await,
            ];
            assert_eq!(
                refused,
                [
                    Err(ShellError::Conflict(format!(
                        "shell {unkept} is lost with no last command kept"
                    ))),
                    Err(ShellError::Conflict(
                        "shell integration is off, so a new shell can't report its prompt"
                            .to_owned()
                    )),
                ]
            );
            assert_eq!(
                (none.state_of(&unkept), off.state_of(&kept)),
                (Some(TerminalState::Lost), Some(TerminalState::Lost))
            );
        });
    }

    #[test]
    fn keeps_the_line_on_the_lost_shell_when_its_restart_fails_for_the_next_restart() {
        let h = setup_with(100, Some(integration()));
        runtime().block_on(async {
            let (lost, _) = lost_shell(&h, Some(LINE)).await;
            h.fake
                .set(|state| state.creates_refused = Some(crate::terminals::fake::refused()));
            let failed = h.shells.restart(&lost, &restarting("r", true), None).await;
            h.fake.set(|state| state.creates_refused = None);
            assert!(
                matches!(failed, Err(ShellError::OpenFailed(_))),
                "{failed:?}"
            );
            assert_eq!(
                (h.last_command(&lost), h.retypeable(&lost)),
                (Some(LINE.to_owned()), Some(true))
            );
        });
    }

    #[test]
    fn forgets_the_line_from_the_lost_shell_s_row_and_writes_it_nowhere_else() {
        let h = setup_with(100, Some(integration()));
        let said = Said::default();
        let _logging = said.logging();
        runtime().block_on(async {
            let (lost, _) = lost_shell(&h, Some(LINE)).await;
            let id = h.restarted(&lost, true).await;
            h.prompt(&id, None, None).await;
            settle().await;
            let snapshot = serde_json::to_string(&h.listed()).unwrap();
            let in_events: i64 = rusqlite::Connection::open(h.dir.path().join("bazhen.db"))
                .unwrap()
                .query_row(
                    "SELECT count(*) FROM events WHERE payload LIKE '%s3cret%'",
                    (),
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(h.pasted(), vec![typed(&id, false)]);
            assert_eq!(
                (h.last_command(&lost), h.last_command(&id), in_events),
                (None, None, 0)
            );
            assert!(!snapshot.contains("s3cret"), "{snapshot}");
            assert_eq!(said.times("s3cret"), 0);
            assert!(
                !crate::shells::reports::tests::on_disk(&h, "s3cret"),
                "the line is still on disk"
            );
        });
    }

    /// Lines held on a tracker of their own, the place each shell runs at.
    fn held() -> (PendingRetypes, Recorded) {
        let retypes = PendingRetypes::new(TaskTracker::new(), CancellationToken::new());
        let at = Recorded {
            terminal_id: TerminalId::parse("term_0190a1b2c3d47abc8def0123456789ad").unwrap(),
            locator: "{}".to_owned(),
        };
        (retypes, at)
    }

    const ID: &str = "term_0190a1b2c3d47abc8def0123456789ad";

    /// What was taken to be typed: its line and whether marked.
    fn taken(typing: Option<Typing>) -> Option<(String, bool)> {
        typing.map(|typing| (typing.line, typing.brackets))
    }

    #[test]
    fn types_a_line_whose_prompt_came_before_its_shell_s_start_returned_once_it_returns() {
        runtime().block_on(async {
            let (retypes, at) = held();
            retypes.hold(ID, "make".to_owned());
            let early = taken(retypes.prompted(ID, false));
            let late = taken(retypes.opened(ID, at));
            assert_eq!((early, late), (None, Some(("make".to_owned(), false))));
        });
    }

    #[test]
    fn marks_the_paste_as_its_shell_s_first_prompt_report_asked_not_a_later_one() {
        runtime().block_on(async {
            let (retypes, at) = held();
            retypes.hold(ID, "make".to_owned());
            let reports = [
                taken(retypes.prompted(ID, true)),
                taken(retypes.prompted(ID, false)),
            ];
            let opened = taken(retypes.opened(ID, at.clone()));
            let again = taken(retypes.opened(ID, at));
            assert_eq!(
                (reports, opened, again),
                ([None, None], Some(("make".to_owned(), true)), None)
            );
        });
    }

    #[test]
    fn drops_a_line_its_shell_won_t_take_before_the_shell_s_start_returns_and_types_nothing() {
        let said = Said::default();
        let _logging = said.logging();
        runtime().block_on(async {
            let (retypes, at) = held();
            retypes.hold(ID, "make".to_owned());
            retypes.declined(ID);
            let typed = [
                taken(retypes.opened(ID, at)),
                taken(retypes.prompted(ID, false)),
            ];
            assert_eq!(typed, [None, None]);
            assert_eq!(said.times(&not_retyped(ID, DECLINED)), 1);
        });
    }

    #[test]
    fn goes_by_its_shell_s_first_report_so_a_word_that_it_won_t_take_a_line_after_a_prompt_changes_nothing()
     {
        let said = Said::default();
        let _logging = said.logging();
        runtime().block_on(async {
            let (retypes, at) = held();
            retypes.hold(ID, "make".to_owned());
            retypes.prompted(ID, false);
            retypes.declined(ID);
            let typed = taken(retypes.opened(ID, at));
            assert_eq!(
                (typed, said.times("not retyped")),
                (Some(("make".to_owned(), false)), 0)
            );
        });
    }

    #[test]
    fn logs_nothing_for_a_shell_with_no_line_held_that_says_it_won_t_take_one() {
        let said = Said::default();
        let _logging = said.logging();
        runtime().block_on(async {
            let (retypes, _) = held();
            retypes.declined(ID);
            assert_eq!(said.times("not retyped"), 0);
        });
    }

    #[test]
    fn never_types_a_line_holding_a_key() {
        let said = Said::default();
        let _logging = said.logging();
        runtime().block_on(async {
            for line in ["make\n", "make\r", "make\u{1b}[D"] {
                let (retypes, at) = held();
                retypes.hold(ID, line.to_owned());
                let typed = [
                    taken(retypes.opened(ID, at)),
                    taken(retypes.prompted(ID, false)),
                ];
                assert_eq!(typed, [None, None], "{line:?}");
            }
            assert_eq!(
                said.times(&not_retyped(
                    ID,
                    "it is not a line that can be typed safely"
                )),
                3
            );
        });
    }

    #[test]
    fn types_nothing_for_a_shell_whose_line_was_dropped_as_one_that_failed_to_open() {
        runtime().block_on(async {
            let (retypes, at) = held();
            retypes.hold(ID, "make".to_owned());
            retypes.drop(ID);
            let typed = [
                taken(retypes.opened(ID, at)),
                taken(retypes.prompted(ID, false)),
            ];
            assert_eq!(typed, [None, None]);
        });
    }

    #[test]
    fn ends_its_wait_for_a_prompt_at_the_daemon_s_stop_saying_nothing() {
        let said = Said::default();
        let _logging = said.logging();
        runtime().block_on(async {
            let (tracker, stop) = (TaskTracker::new(), CancellationToken::new());
            let retypes = PendingRetypes::new(tracker.clone(), stop.clone());
            retypes.hold(ID, "make".to_owned());
            stop.cancel();
            tracker.close();
            let ended = tokio::time::timeout(Duration::from_secs(5), tracker.wait()).await;
            assert!(ended.is_ok(), "the wait for a prompt outlived the stop");
            assert_eq!(said.times("not retyped"), 0);
        });
    }
}
