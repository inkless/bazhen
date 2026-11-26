//! What a shell's integration reports over the daemon's socket (`shells/reports.ts`): the lines
//! it runs, kept for a restart to type the last one back, and its first prompt. Each report proves
//! the shell with the token the daemon gave it at its start, of which only a hash is kept. A line
//! is kept in the shell's row alone: no event records it, and no log names it.

use std::future::Future;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::pin::Pin;
use std::sync::{Arc, OnceLock};
use std::task::Poll;

use bazhen_protocol::shells::{ShellDecline, ShellPrompt, ShellReport};
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

use super::{ShellError, Shells};
use crate::devices::{hash_token, token_of};
use crate::pairing::{random_bytes, same};

/// How far ahead of the daemon's clock a report's time counts: a shell's clock running fast, or
/// a forged time, can't keep every later report out.
const AHEAD_MICROS: u64 = 60_000_000;

/// How many reports wait for the keeper at most. The shells' report routes are served on the
/// socket alone, which serves no more connections at once than this, each one request at a time,
/// so it is every report that can be waiting while its hook waits too. A hook that hangs up frees its
/// connection for another while its report still waits, so more can come behind a slow store:
/// those wait for room, and no more work than this is held. Nothing caps the rate on a
/// connection, so this is the bound.
const WAITING_AT_MOST: usize = crate::accept::SOCKET_MAX;

/// What a shell's integration reported, as its log names it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ReportKind {
    /// A line it starts running.
    Line,
    /// Its first prompt.
    Prompt,
    /// That it won't take a line typed back.
    Decline,
}

impl ReportKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Line => "report",
            Self::Prompt => "prompt",
            Self::Decline => "decline",
        }
    }
}

/// A report taken whole, to be handled by the keeper.
struct Job {
    terminal_id: String,
    kind: ReportKind,
    /// Handles it and sends the answer; says whether anyone was still waiting for it.
    run: Pin<Box<dyn Future<Output = bool> + Send>>,
}

impl Job {
    /// Runs it to its end, or to a panic, which is caught here: the job is dropped with its
    /// answer unsent, so its route answers that it ended early.
    async fn run_to_end(self) {
        let mut run = self.run;
        let answered = std::future::poll_fn(|cx| {
            catch_unwind(AssertUnwindSafe(|| run.as_mut().poll(cx)))
                .map_or(Poll::Ready(None), |polled| polled.map(Some))
        })
        .await;
        drop(run);
        let (id, kind) = (self.terminal_id, self.kind.as_str());
        match answered {
            Some(true) => {}
            Some(false) => {
                tracing::warn!("shell {id}: finished a {kind} its hook stopped waiting for");
            }
            None => tracing::warn!("shell {id}: a {kind} panicked as it was handled"),
        }
    }
}

/// Handles every shell's reports, one at a time in the order the routes took them whole, on a
/// task of the daemon's own, so a hook that hangs up, as its detached copy does after its
/// deadline whatever the daemon does, can't cancel one midway, as the TypeScript daemon's
/// handler runs on after its client has gone.
///
/// One keeper for every shell is deliberate. It puts every shell's reports behind one another,
/// each behind one store job at a time, which costs nothing, since the store's writer runs one job
/// at a time anyway. And it is what keeps a shell's report and its prompt or decline in the order
/// they reached the daemon: a task for each shell, or each report, would let them pass each other.
///
/// The keeper never ends because of a job. One that panics is caught where it runs: its route is
/// answered that it ended early, the panic is said, and the keeper goes on with the reports behind
/// it. That matters only where a panic unwinds, as in the tests: a release build aborts on any
/// panic (`panic = "abort"`), and the daemon with it.
#[derive(Debug, Default)]
pub(crate) struct Keeper {
    /// Where the keeper takes reports from. It starts with the first report, not in
    /// `Shells::new`, which is sync, and which test harnesses call outside a runtime; the daemon
    /// makes its shells once, inside its runtime (`serve::shells`).
    jobs: OnceLock<mpsc::Sender<Job>>,
}

impl Keeper {
    /// Where reports are sent, the keeper started on `tracker` at the first.
    fn jobs(&self, tracker: &TaskTracker, stop: &CancellationToken) -> &mpsc::Sender<Job> {
        self.jobs.get_or_init(|| {
            let (jobs, taken) = mpsc::channel(WAITING_AT_MOST);
            tracker.spawn(keep(taken, stop.clone()));
            jobs
        })
    }
}

/// Handles each report `jobs` takes, in turn, until `stop`. Until the keeper sees the stop and
/// closes `jobs`, a route's send still succeeds, and that report is handled too; one sent after
/// the close is refused, its route answered 503. Once closed, it handles every report already
/// taken, then ends. A keeper first started after the stop closes at once, and handles what it
/// was sent. The daemon's drain waits on its tasks, this one among them, for no longer than its
/// bound (`serve::drain`); past that the runtime ends, and with it whatever is left.
async fn keep(mut jobs: mpsc::Receiver<Job>, stop: CancellationToken) {
    while let Some(Some(job)) = stop.run_until_cancelled(jobs.recv()).await {
        job.run_to_end().await;
    }
    jobs.close();
    while let Some(job) = jobs.recv().await {
        job.run_to_end().await;
    }
}

/// What became of a report.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ReportOutcome {
    /// Its line is the one kept now.
    Kept,
    /// The shell is ended, or a report after it has been kept: it changed nothing.
    Stale,
    /// It isn't the shell's own: no such shell, or not its token.
    Refused,
}

/// A new shell's token, which its integration reports with, and what the store keeps of it.
pub(crate) struct ShellToken {
    pub(crate) token: String,
    pub(crate) hash: String,
}

/// The token proves the shell, so it is never shown.
impl std::fmt::Debug for ShellToken {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ShellToken")
            .field("hash", &self.hash)
            .finish_non_exhaustive()
    }
}

/// A token for a new shell: 32 random bytes, as unpadded base64url.
pub(crate) fn new_shell_token() -> Result<ShellToken, ShellError> {
    let random = random_bytes::<32>()
        .map_err(|err| ShellError::Internal(format!("no shell token can be made: {err}")))?;
    let token = token_of(random);
    let hash = hash_token(&token);
    Ok(ShellToken { token, hash })
}

/// Now, in microseconds since the epoch, as a report's `at` is.
fn now_micros() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_micros()).unwrap_or(u64::MAX))
}

impl Shells {
    /// Runs `work`, a `kind` of report from the shell `terminal_id` names, on the keeper, to its
    /// end whether or not its caller waits for the answer. A report the caller gives up on before
    /// the keeper has it was never taken, so nothing of it is kept. `work` checks the report's
    /// token itself: that is a read of the store, as slow as a write can be, so handing on only a
    /// report already checked would leave a hook's hang-up the same time to cancel it in.
    ///
    /// # Errors
    ///
    /// `work`'s; [`ShellError::Unavailable`] when the keeper has closed at the daemon's stop; and
    /// [`ShellError::Internal`] when the report's handling panicked.
    pub(crate) async fn kept<T, F>(
        self: &Arc<Self>,
        kind: ReportKind,
        terminal_id: &str,
        work: impl FnOnce(Arc<Self>) -> F,
    ) -> Result<T, ShellError>
    where
        F: Future<Output = Result<T, ShellError>> + Send + 'static,
        T: Send + 'static,
    {
        let (answer, answered) = oneshot::channel();
        let done = work(Arc::clone(self));
        let job = Job {
            terminal_id: terminal_id.to_owned(),
            kind,
            run: Box::pin(async move { answer.send(done.await).is_ok() }),
        };
        self.keeper
            .jobs(&self.deps.tracker, &self.deps.stop)
            .send(job)
            .await
            .map_err(|_| {
                ShellError::Unavailable(format!(
                    "shell {terminal_id}'s {} wasn't taken: bazhen is stopping",
                    kind.as_str()
                ))
            })?;
        answered.await.map_err(|_| {
            ShellError::Internal(format!(
                "shell {terminal_id}'s {} ended early",
                kind.as_str()
            ))
        })?
    }

    /// Keeps the line a shell reported running, unless the report isn't the shell's own or a
    /// later one has been kept.
    ///
    /// # Errors
    ///
    /// When the store can't be reached.
    pub(crate) async fn report(
        &self,
        terminal_id: &str,
        report: ShellReport,
    ) -> Result<ReportOutcome, ShellError> {
        self.report_at(terminal_id, report, now_micros()).await
    }

    /// As [`Shells::report`], with the daemon's clock reading `now`.
    async fn report_at(
        &self,
        terminal_id: &str,
        report: ShellReport,
        now: u64,
    ) -> Result<ReportOutcome, ShellError> {
        if !self.owns(terminal_id, &report.token).await? {
            return Ok(ReportOutcome::Refused);
        }
        let at = report.at.min(now.saturating_add(AHEAD_MICROS));
        let (id, command) = (terminal_id.to_owned(), report.command);
        let kept = self
            .write(move |w| Ok(w.note_shell_command(&id, at, command.as_deref())?))
            .await?;
        Ok(if kept {
            ReportOutcome::Kept
        } else {
            ReportOutcome::Stale
        })
    }

    /// The shell's integration reported its first prompt: a line its restart is to type back is
    /// typed now. Answers whether the report was the shell's own.
    ///
    /// # Errors
    ///
    /// When the store can't be reached.
    pub(crate) async fn prompt(
        &self,
        terminal_id: &str,
        prompt: &ShellPrompt,
    ) -> Result<bool, ShellError> {
        if !self.owns(terminal_id, &prompt.token).await? {
            return Ok(false);
        }
        if let Some(typing) = self
            .retypes
            .prompted(terminal_id, prompt.brackets == Some(true))
        {
            self.type_back(typing);
        }
        Ok(true)
    }

    /// The shell's integration said it won't take a line typed back: a line held for it is
    /// dropped. Answers whether the report was the shell's own.
    ///
    /// # Errors
    ///
    /// When the store can't be reached.
    pub(crate) async fn decline(
        &self,
        terminal_id: &str,
        decline: &ShellDecline,
    ) -> Result<bool, ShellError> {
        if !self.owns(terminal_id, &decline.token).await? {
            return Ok(false);
        }
        self.retypes.declined(terminal_id);
        Ok(true)
    }

    /// Whether `token` is the one the shell `terminal_id` names was started with, compared in
    /// constant time by its hash.
    async fn owns(&self, terminal_id: &str, token: &str) -> Result<bool, ShellError> {
        let id = terminal_id.to_owned();
        let kept = self
            .deps
            .store
            .run(move |store| store.reads().shell_token_hash(&id))
            .await??;
        Ok(kept.is_some_and(|kept| same(&kept, &hash_token(token))))
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use bazhen_protocol::shells::TuiTheme;
    use bazhen_store::TerminalChange;

    use super::*;
    use crate::shells::tests::{Harness, integration, setup_with};
    use crate::testing::runtime;

    fn line(token: Option<&str>, at: u64, command: Option<&str>) -> ShellReport {
        ShellReport {
            token: token.unwrap_or_default().to_owned(),
            at,
            command: command.map(str::to_owned),
        }
    }

    impl Harness {
        pub(crate) fn last_command(&self, id: &str) -> Option<String> {
            let reader = self.store.reader().unwrap();
            reader.reads().last_shell_command(id).unwrap()
        }
    }

    /// Whether `text` is anywhere in the database's files, its journal's too.
    pub(crate) fn on_disk(h: &Harness, text: &str) -> bool {
        std::fs::read_dir(h.dir.path()).unwrap().any(|entry| {
            let path = entry.unwrap().path();
            let name = path.file_name().unwrap().to_string_lossy().into_owned();
            name.starts_with("bazhen.db")
                && std::fs::read(&path)
                    .unwrap()
                    .windows(text.len())
                    .any(|window| window == text.as_bytes())
        })
    }

    #[test]
    fn keeps_the_line_a_shell_reports_with_its_own_token_and_stores_no_token_itself() {
        let h = setup_with(100, Some(integration()));
        runtime().block_on(async {
            let id = h.open("o").await.unwrap();
            let env = h.fake.spec_of(&id).env;
            let token = h.token_of(&id).unwrap();
            let outcome = h
                .shells
                .report(&id, line(Some(&token), 1, Some("moon run :dev")))
                .await;
            assert_eq!(
                (outcome, h.last_command(&id)),
                (Ok(ReportOutcome::Kept), Some("moon run :dev".to_owned()))
            );
            assert_eq!(
                (
                    env.get("BAZHEN_HOOK").map(String::as_str),
                    env.get("BAZHEN_SHELL_INTEGRATION").map(String::as_str),
                    token.len(),
                ),
                (
                    Some("/state/hook/bazhen-hook"),
                    Some("/state/shell-integration"),
                    43
                )
            );
            assert!(!on_disk(&h, &token), "the token itself is kept");
            assert!(on_disk(&h, &hash_token(&token)), "its hash is kept");
        });
    }

    #[test]
    fn gives_every_shell_a_token_of_its_own_and_refuses_one_shell_s_token_for_another() {
        let h = setup_with(100, Some(integration()));
        runtime().block_on(async {
            let a = h.open("a").await.unwrap();
            let b = h.open("b").await.unwrap();
            let (ta, tb) = (h.token_of(&a).unwrap(), h.token_of(&b).unwrap());
            let mut outcomes = Vec::new();
            for (at, token) in [(1, tb.clone()), (2, String::new()), (3, format!("{ta}x"))] {
                let report = line(Some(&token), at, Some("rm -rf ~"));
                outcomes.push(h.shells.report(&a, report).await.unwrap());
            }
            assert_ne!(ta, tb);
            assert_eq!(
                (outcomes, h.last_command(&a)),
                (vec![ReportOutcome::Refused; 3], None)
            );
        });
    }

    #[test]
    fn refuses_every_report_for_a_shell_opened_with_the_integration_off_which_has_no_token() {
        let h = setup_with(100, None);
        runtime().block_on(async {
            let id = h.open("o").await.unwrap();
            let env = h.fake.spec_of(&id).env;
            let outcome = h
                .shells
                .report(&id, line(Some("guess"), 1, Some("make")))
                .await;
            let named: Vec<&String> = env
                .keys()
                .filter(|key| key.starts_with("BAZHEN_SHELL") || *key == "BAZHEN_HOOK")
                .collect();
            assert_eq!(
                (outcome, named, h.shells.reports()),
                (Ok(ReportOutcome::Refused), Vec::<&String>::new(), false)
            );
        });
    }

    #[test]
    fn takes_no_report_once_a_shell_is_lost_its_token_gone_with_it() {
        let h = setup_with(100, Some(integration()));
        runtime().block_on(async {
            let id = h.open("o").await.unwrap();
            let token = h.token_of(&id).unwrap();
            let report = |at, command| line(Some(&token), at, Some(command));
            h.shells
                .report(&id, report(1, "cargo watch"))
                .await
                .unwrap();
            h.mark(&id, TerminalChange::Lost).await;
            let outcome = h.shells.report(&id, report(2, "ls")).await;
            assert_eq!(
                (outcome, h.last_command(&id)),
                (Ok(ReportOutcome::Refused), Some("cargo watch".to_owned()))
            );
        });
    }

    #[test]
    fn calls_a_report_older_than_the_kept_line_stale_and_keeps_the_newer() {
        let h = setup_with(100, Some(integration()));
        runtime().block_on(async {
            let id = h.open("o").await.unwrap();
            let token = h.token_of(&id).unwrap();
            let newer = h
                .shells
                .report(&id, line(Some(&token), 20, Some("moon run :dev")))
                .await;
            let older = h
                .shells
                .report(&id, line(Some(&token), 10, Some("ls")))
                .await;
            assert_eq!(
                (newer, older, h.last_command(&id)),
                (
                    Ok(ReportOutcome::Kept),
                    Ok(ReportOutcome::Stale),
                    Some("moon run :dev".to_owned())
                )
            );
        });
    }

    #[test]
    fn counts_a_report_from_far_ahead_as_a_minute_ahead_at_most_so_later_lines_still_count() {
        let h = setup_with(100, Some(integration()));
        runtime().block_on(async {
            let id = h.open("o").await.unwrap();
            let token = h.token_of(&id).unwrap();
            let now = 1_000_000_000;
            let far = line(Some(&token), (1 << 53) - 1, Some("far"));
            let far = h.shells.report_at(&id, far, now).await;
            let later = now + 61_000_000;
            let next = line(Some(&token), later, Some("moon run :dev"));
            let next = h.shells.report_at(&id, next, later).await;
            assert_eq!(
                (far, next, h.last_command(&id)),
                (
                    Ok(ReportOutcome::Kept),
                    Ok(ReportOutcome::Kept),
                    Some("moon run :dev".to_owned())
                )
            );
        });
    }

    #[test]
    fn forgets_every_kept_line_and_token_when_the_integration_is_turned_off() {
        let h = setup_with(100, Some(integration()));
        runtime().block_on(async {
            let id = h.open("o").await.unwrap();
            let token = h.token_of(&id).unwrap();
            h.shells
                .report(&id, line(Some(&token), 1, Some("moon run :dev")))
                .await
                .unwrap();
            h.store
                .run(|store| store.write(|w: &bazhen_store::Writer<'_>| w.forget_shell_commands()))
                .await
                .unwrap()
                .unwrap();
            let outcome = h
                .shells
                .report(&id, line(Some(&token), 2, Some("make")))
                .await;
            assert_eq!(
                (outcome, h.last_command(&id)),
                (Ok(ReportOutcome::Refused), None)
            );
        });
    }

    #[test]
    fn takes_a_prompt_or_a_decline_only_with_the_shell_s_own_token() {
        let h = setup_with(100, Some(integration()));
        runtime().block_on(async {
            let id = h.open("o").await.unwrap();
            let lost = h.lost(TuiTheme::Dark).await;
            let token = h.token_of(&id).unwrap();
            let prompt = |token: &str| ShellPrompt {
                token: token.to_owned(),
                brackets: None,
            };
            let decline = |token: &str| ShellDecline {
                token: token.to_owned(),
            };
            let mut answers = Vec::new();
            for (shell, token) in [(&id, token.as_str()), (&id, "forged"), (&lost, "")] {
                answers.push((
                    h.shells.prompt(shell, &prompt(token)).await.unwrap(),
                    h.shells.decline(shell, &decline(token)).await.unwrap(),
                ));
            }
            assert_eq!(answers, [(true, true), (false, false), (false, false)]);
        });
    }

    /// Whether `future` is still waiting after one poll.
    pub(crate) async fn waits<F: Future + Unpin>(future: &mut F) -> bool {
        tokio::select! {
            biased;
            _ = future => false,
            () = std::future::ready(()) => true,
        }
    }

    #[test]
    fn keeps_a_report_sent_after_one_whose_handling_panicked() {
        let h = setup_with(100, Some(integration()));
        let said = crate::shells::tests::Said::default();
        let _logging = said.logging();
        runtime().block_on(async {
            let id = h.open("o").await.unwrap();
            let token = h.token_of(&id).unwrap();
            let (release, gate) = std::sync::mpsc::channel::<()>();
            let mut held = Box::pin(h.store.run(move |_| gate.recv().is_ok()));
            assert!(waits(&mut held).await);
            let store = h.store.clone();
            let mut panicking = Box::pin(h.shells.kept(ReportKind::Line, &id, |_| async move {
                store.run(|_| ()).await.unwrap();
                panic!("a report's handling panicked")
            }));
            assert!(waits(&mut panicking).await);
            // The keeper takes the panicking report, which waits behind the hold.
            tokio::task::yield_now().await;
            let (on, report) = (id.clone(), line(Some(&token), 1, Some("make")));
            let mut next = Box::pin(h.shells.kept(
                ReportKind::Line,
                &id,
                move |shells| async move { shells.report(&on, report).await },
            ));
            assert!(
                waits(&mut next).await,
                "the next report is queued behind it"
            );
            release.send(()).unwrap();
            assert!(held.await.unwrap());
            let panicked: Result<ReportOutcome, ShellError> = panicking.await;
            assert_eq!(
                (panicked, next.await, h.last_command(&id)),
                (
                    Err(ShellError::Internal(format!(
                        "shell {id}'s report ended early"
                    ))),
                    Ok(ReportOutcome::Kept),
                    Some("make".to_owned())
                )
            );
            assert_eq!(
                said.times(&format!("shell {id}: a report panicked as it was handled")),
                1,
                "{}",
                said.text()
            );
        });
    }
}
