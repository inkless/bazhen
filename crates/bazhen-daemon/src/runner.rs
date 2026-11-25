//! The terminals the daemon runs, set up as `main.ts` sets them up before it serves: the
//! environment captured, the holder installed and its old builds pruned, a start refused when
//! the default runtime can't run, and the runtime over the holders, with the budget its new
//! terminals open under.

use std::path::Path;
use std::sync::Arc;

use bazhen_host_guard::ptys::PtyReader;
use bazhen_host_guard::scope;
use bazhen_runtime_holder::{HolderRoot, HolderRuntime, RuntimeOptions};

use crate::budget::Budget;
use crate::doctor::{self, Settled};
use crate::env::{self, Env};
use crate::harnesses::{self, World};
use crate::holder::{self, Holder, default_runtime_refusal, holder_source, runtime_env};
use crate::hook_link;
use crate::serve::{Refused, Startup};
use crate::terminals::Terminals;

/// The shell `SHELL` names, as a new terminal tab would run it; a relative or missing one is
/// `/bin/sh`.
pub(crate) fn login_shell(env: &Env) -> String {
    env.get(std::ffi::OsStr::new("SHELL"))
        .and_then(|shell| shell.to_str())
        .filter(|shell| shell.starts_with('/'))
        .unwrap_or("/bin/sh")
        .to_owned()
}

/// What the daemon's shells run on, and what doctor says of it.
#[derive(Debug)]
pub(crate) struct Runner {
    pub(crate) terminals: Arc<dyn Terminals>,
    pub(crate) budget: Arc<Budget>,
    pub(crate) doctor: Settled,
    /// The shell a new terminal tab would run.
    pub(crate) shell: String,
    /// The holder runtime its terminals' views stream from; none for a fake's.
    pub(crate) streams: Option<Arc<HolderRuntime>>,
    /// What hooks are given to run, or none when no hook client is built.
    pub(crate) hook: Option<String>,
    /// The harnesses agents run in, over that hook client, or over where its link would be.
    pub(crate) harnesses: bazhen_harness::Harnesses,
}

/// The holder runtime, with the build installed for its new terminals, or why the daemon can't
/// start with the runtime configured.
pub(crate) async fn holders(startup: &Startup) -> Result<Runner, Refused> {
    let settings = &startup.settings;
    let config = &settings.config;
    let exe = std::env::current_exe()
        .map_err(|err| Refused::Said(format!("bazhen can't find itself: {err}")))?;
    // Captured once: shells get what a new terminal tab would, minus Bazhen's and the launching
    // session's internals.
    let source: Vec<_> = std::env::vars_os().collect();
    let captured = env::capture(&source, &config.env_rules, jiff::Timestamp::now());
    let state = Path::new(&settings.paths.state);
    let install = holder::install(holder_source(&exe), state, startup.uid);
    if let Some(refused) =
        default_runtime_refusal(config.default_runtime, &install, &settings.config_file.path)
    {
        return Err(Refused::Said(format!("bazhen: {refused}")));
    }
    let root = HolderRoot::of(Path::new(&settings.paths.run), startup.uid);
    root.make_private(startup.uid)
        .map_err(|err| Refused::Said(err.to_string()))?;
    let mut options = RuntimeOptions::new(root);
    options.binary = install.installed().map(|i| i.binary.clone());
    options.unavailable = install.reason().map(str::to_owned);
    options.install_dir = Some(state.join("holder"));
    options.env = runtime_env(&captured.env);
    options.caps = Some(scope::TerminalCaps {
        terminal: config.terminal_caps.terminal.clone(),
        total: config.terminal_caps.total.clone(),
        swap: config.terminal_caps.swap.clone(),
    });
    let runtime = HolderRuntime::new(options);
    let ptys = PtyReader::machine().await;
    let budget = Budget::new(
        config.max_open_terminals,
        Arc::new(ptys),
        Box::new(|message| tracing::warn!("bazhen: {message}")),
    );
    // With none built, a link an earlier start made is left as it is.
    let hook = hook_link::built_beside(&exe)
        .map(|built| hook_link::install_hook_client(&built, &state.join("hook"), startup.uid));
    let doctor = Settled::of(doctor::Settings {
        exe: &exe,
        config: settings,
        install,
        capture: &captured,
        hook: hook.as_ref(),
    });
    let holder = Holder::new(runtime, config.history_lines);
    let hook = hook.map(|hook| hook.path.to_string_lossy().into_owned());
    // Served without a client too, so agents an earlier start launched are still described;
    // no launch gives a hook to run until one is built.
    let harnesses = harnesses::served(World {
        hook: hook.clone().unwrap_or_else(|| {
            hook_link::link_in(&state.join("hook"))
                .to_string_lossy()
                .into_owned()
        }),
        user_env: captured.env.clone(),
        home: startup.home.clone(),
        socket: startup.paths.socket.clone(),
    });
    Ok(Runner {
        streams: Some(holder.runtime()),
        terminals: Arc::new(holder),
        budget: Arc::new(budget),
        doctor,
        shell: login_shell(&captured.env),
        hook,
        harnesses,
    })
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;

    use super::*;

    #[test]
    fn runs_the_shell_shell_names_and_sh_for_one_that_isnt_a_full_path() {
        let with = |shell: Option<&str>| -> Env {
            shell
                .map(|s| (OsString::from("SHELL"), OsString::from(s)))
                .into_iter()
                .collect()
        };
        assert_eq!(
            [
                login_shell(&with(Some("/usr/bin/fish"))),
                login_shell(&with(Some("zsh"))),
                login_shell(&with(None)),
            ],
            ["/usr/bin/fish", "/bin/sh", "/bin/sh"]
        );
    }
}
