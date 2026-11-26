//! The daemon's bounded run of a harness's own CLI ([`RunPort`]), such as the command that starts
//! its server: the program and arguments the harness names, in the environment captured for
//! agents, so it finds the harness the agents run. It runs with no stdin, in a process group of
//! its own that is killed once the run outlives its timeout, and keeps the first
//! [`bazhen_host_guard::OUTPUT_MAX`] bytes of each of its stdout and stderr; nothing runs through a shell.

use std::time::Duration;

use bazhen_harness::{BoxFuture, Output, RunError, RunPort};
use bazhen_host_guard::{Ended, run_kept};
use tokio::process::Command;

use crate::env::Env;

/// Runs a harness's commands in `env`, and in it alone.
#[derive(Debug)]
pub(crate) struct Commands {
    env: Env,
}

impl Commands {
    pub(crate) fn new(env: Env) -> Self {
        Self { env }
    }
}

fn refused(message: String) -> RunError {
    RunError { message }
}

impl RunPort for Commands {
    fn run<'a>(
        &'a self,
        argv: &'a [String],
        timeout: Duration,
    ) -> BoxFuture<'a, Result<Output, RunError>> {
        Box::pin(async move {
            let Some((program, rest)) = argv.split_first() else {
                return Err(refused("no command was named".to_owned()));
            };
            let mut command = Command::new(program);
            command.args(rest).env_clear().envs(&self.env);
            let ran = run_kept(command, timeout).await.map_err(|err| {
                refused(format!(
                    "{program} ran past its {}s, and its group couldn't be ended: {err}",
                    timeout.as_secs()
                ))
            })?;
            let (stdout, stderr) = ran.text();
            match ran.ended {
                Ended::Exited(status) => Ok(Output {
                    code: status.code(),
                    stdout,
                    stderr,
                }),
                Ended::TimedOut => Err(refused(format!(
                    "{program} didn't end within {}s",
                    timeout.as_secs()
                ))),
                Ended::Unstarted(err) => Err(refused(format!("{program} couldn't start: {err}"))),
                Ended::Unwaited(err) => {
                    Err(refused(format!("{program} couldn't be waited for: {err}")))
                }
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;

    use super::*;
    use crate::testing::runtime;

    const LONG: Duration = Duration::from_secs(30);

    fn commands(env: &[(&str, &str)]) -> Commands {
        Commands::new(
            env.iter()
                .map(|(k, v)| (OsString::from(k), OsString::from(v)))
                .collect(),
        )
    }

    fn argv(words: &[&str]) -> Vec<String> {
        words.iter().map(|w| (*w).to_owned()).collect()
    }

    #[test]
    fn says_what_a_command_printed_and_its_exit_in_the_environment_it_was_given_alone() {
        let run = commands(&[("PATH", "/usr/bin:/bin"), ("GIVEN", "yes")]);
        let script = r#"printf 'out %s %s' "$GIVEN" "${HOME-unset}"; printf err >&2; exit 3"#;
        let ran = runtime().block_on(run.run(&argv(&["sh", "-c", script]), LONG));
        assert_eq!(
            ran,
            Ok(Output {
                code: Some(3),
                stdout: "out yes unset".to_owned(),
                stderr: "err".to_owned(),
            })
        );
    }

    #[test]
    fn refuses_a_command_it_cant_start_or_none_named() {
        let run = commands(&[]);
        let rt = runtime();
        let missing = rt.block_on(run.run(&argv(&["/nonexistent/codex", "--version"]), LONG));
        assert!(
            missing.as_ref().is_err_and(|err| err
                .message
                .starts_with("/nonexistent/codex couldn't start: ")),
            "{missing:?}"
        );
        assert_eq!(
            rt.block_on(run.run(&[], LONG)),
            Err(refused("no command was named".to_owned()))
        );
    }

    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn ends_a_command_that_outlives_its_timeout_and_says_so() {
        bazhen_test_signal::require_sandbox().unwrap();
        let run = commands(&[("PATH", "/usr/bin:/bin")]);
        let ran = runtime().block_on(run.run(&argv(&["sleep", "30"]), Duration::from_millis(200)));
        assert_eq!(ran, Err(refused("sleep didn't end within 0s".to_owned())));
    }
}
