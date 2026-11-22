//! What a shell's integration reports over the daemon's socket (`shells/reports.ts`): the lines
//! it runs, kept for a restart to type the last one back, and its first prompt. Each report proves
//! the shell with the token the daemon gave it at its start, of which only a hash is kept. A line
//! is kept in the shell's row alone: no event records it, and no log names it.

use bazhen_protocol::shells::{ShellDecline, ShellPrompt, ShellReport};

use super::{ShellError, Shells};
use crate::devices::{hash_token, token_of};
use crate::pairing::{random_bytes, same};

/// How far ahead of the daemon's clock a report's time counts: a shell's clock running fast, or
/// a forged time, can't keep every later report out.
const AHEAD_MICROS: u64 = 60_000_000;

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
}
