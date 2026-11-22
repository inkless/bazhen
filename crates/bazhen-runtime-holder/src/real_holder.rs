//! The runtime against real holders, the `bazhen-holder` this workspace builds: each test starts
//! one, signals or closes its child, or kills it, so each runs only in the sandbox.

use std::collections::{BTreeMap, HashSet};
use std::path::PathBuf;

use bazhen_holder_proto::body::{ExitStatus, Generation, HistoryLines, Signal};
use bazhen_host_guard::scope::{Containment, TerminalCaps, in_terminal_scope, probe_containment};
use bazhen_protocol::ids::TerminalId;
use tokio::sync::broadcast;

use crate::fake_holder::fake_hello;
use crate::host::{Host as _, System};
use crate::locator::{HolderLocator, HolderRef, os_pid};
use crate::runtime::{
    ForegroundProcess, HolderRuntime, Needs, ProcessLaunch, RuntimeError, RuntimeOptions,
    TerminalSpec,
};
use crate::sockets::HolderRoot;
use crate::tags::TerminalTags;
use crate::test_support::{TempDir, block_on, me};
use crate::watch::RuntimeEvent;

/// The holder built beside this test binary, as `cargo nextest run --workspace` builds it: the
/// real one, so its name and start are what `vouch` reads on every OS, with no copy of another
/// program renamed.
fn holder_binary() -> PathBuf {
    let exe = std::env::current_exe().unwrap();
    let holder = exe
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("bazhen-holder");
    assert!(
        holder.is_file(),
        "{} isn't built: run the workspace's tests, which build it",
        holder.display()
    );
    holder
}

fn runtime(dir: &TempDir, caps: Option<TerminalCaps>) -> HolderRuntime {
    let root = HolderRoot::of(&dir.path().join("run"), me());
    root.make_private(me()).unwrap();
    let mut options = RuntimeOptions::new(root);
    options.binary = Some(holder_binary());
    options.caps = caps;
    HolderRuntime::new(options)
}

fn id(n: u8) -> TerminalId {
    TerminalId::mint(1, [n; 16])
}

fn shell() -> TerminalTags {
    TerminalTags::Shell {
        linked_agent_id: None,
    }
}

/// `sleep` in place of the shell that starts it, so it leads the terminal's foreground.
fn sleeping(generation: u64, cwd: &str) -> ProcessLaunch {
    ProcessLaunch {
        argv: ["/bin/sh", "-c", "exec sleep 600"]
            .map(str::to_owned)
            .to_vec(),
        cwd: cwd.to_owned(),
        env: BTreeMap::new(),
        generation: Generation::new(generation).unwrap(),
        theme: None,
    }
}

fn spec(terminal_id: &TerminalId, cwd: &str) -> TerminalSpec {
    TerminalSpec {
        terminal_id: terminal_id.clone(),
        tags: shell(),
        size: fake_hello().size,
        history_lines: HistoryLines::new(500).unwrap(),
        process: sleeping(0, cwd),
    }
}

/// The first event told that `wanted` takes, past the titles and anything else.
async fn until(
    told: &mut broadcast::Receiver<RuntimeEvent>,
    wanted: impl Fn(&RuntimeEvent) -> bool,
) -> RuntimeEvent {
    loop {
        let event = told.recv().await.unwrap();
        if wanted(&event) {
            return event;
        }
    }
}

/// Waits for `terminal`'s holder to be gone: it is this process's child, which the kernel shows
/// as it was until the runtime's reaper has reaped it.
async fn reaped(runtime: &HolderRuntime, terminal: &HolderRef) {
    for _ in 0..100 {
        if runtime.gone(terminal).await {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    panic!("terminal {} never went", terminal.terminal_id);
}

fn kill_holder(terminal: &HolderRef) {
    let pid = i64::try_from(terminal.locator.holder_pid.get()).unwrap();
    bazhen_test_signal::signal(pid, bazhen_test_signal::Signal::KILL).unwrap();
}

#[test]
#[ignore = "signals processes; runs in moon run :test-real -- rust"]
fn creates_a_terminal_its_inventory_finds_and_closes_it_by_protocol() {
    bazhen_test_signal::require_sandbox().unwrap();
    let dir = TempDir::new();
    let runtime = runtime(&dir, None);
    block_on(async {
        let made = runtime.create(spec(&id(1), "/")).await.unwrap();
        assert!(System.runs(made.holder().unwrap()));
        let encoded = made.locator.encode().unwrap();
        assert_eq!(HolderLocator::decode(&encoded).unwrap(), made.locator);
        let found = runtime.inventory().await.unwrap();
        let listed: Vec<_> = found
            .iter()
            .map(|e| (&e.terminal, &e.tags, &e.exit))
            .collect();
        assert_eq!(listed, [(&made, &shell(), &None)]);
        runtime.close(&made).await.unwrap();
        reaped(&runtime, &made).await;
        assert!(!made.locator.socket.exists());
        assert_eq!(runtime.inventory().await.unwrap(), []);
        runtime.shutdown().await;
    });
}

#[test]
#[ignore = "signals processes; runs in moon run :test-real -- rust"]
fn tells_an_exit_and_a_respawn_as_the_holder_pushes_them() {
    bazhen_test_signal::require_sandbox().unwrap();
    let dir = TempDir::new();
    let runtime = runtime(&dir, None);
    block_on(async {
        let mut told = runtime.events();
        let made = runtime.create(spec(&id(1), "/")).await.unwrap();
        runtime.signal(&made, Signal::Sigterm).await.unwrap();
        let exit = until(&mut told, |e| matches!(e, RuntimeEvent::Exited { .. })).await;
        let terminated = ExitStatus::Signalled {
            signal: "SIGTERM".to_owned(),
        };
        assert_eq!(
            exit,
            RuntimeEvent::Exited {
                terminal_id: id(1),
                generation: Generation::new(0).unwrap(),
                status: terminated,
            }
        );
        let again = runtime.signal(&made, Signal::Sigterm).await;
        assert!(
            matches!(
                again,
                Err(RuntimeError::ProcessState {
                    needs: Needs::Running,
                    ..
                })
            ),
            "{again:?}"
        );
        let next = runtime.respawn(&made, &sleeping(1, "/")).await.unwrap();
        assert_eq!(next.locator.generation, Some(Generation::new(1).unwrap()));
        assert_ne!(next.locator.child_pid, made.locator.child_pid);
        let respawned = until(&mut told, |e| matches!(e, RuntimeEvent::Respawned { .. })).await;
        assert_eq!(
            respawned,
            RuntimeEvent::Respawned {
                terminal: next.clone()
            }
        );
        runtime.close(&next).await.unwrap();
        runtime.shutdown().await;
    });
}

#[test]
#[ignore = "signals processes; runs in moon run :test-real -- rust"]
fn tells_a_holder_killed_lost_and_counts_its_terminal_closed_removing_its_socket() {
    bazhen_test_signal::require_sandbox().unwrap();
    let dir = TempDir::new();
    let runtime = runtime(&dir, None);
    block_on(async {
        let mut told = runtime.events();
        let made = runtime.create(spec(&id(1), "/")).await.unwrap();
        kill_holder(&made);
        let lost = until(&mut told, |e| matches!(e, RuntimeEvent::Lost { .. })).await;
        assert_eq!(
            lost,
            RuntimeEvent::Lost {
                terminal: made.clone()
            }
        );
        // Killed, it left its socket behind.
        assert!(made.locator.socket.exists());
        reaped(&runtime, &made).await;
        runtime.close(&made).await.unwrap();
        assert!(!made.locator.socket.exists());
        runtime.shutdown().await;
    });
}

#[test]
#[ignore = "signals processes; runs in moon run :test-real -- rust"]
fn reads_what_holds_a_terminals_foreground_with_its_directory() {
    bazhen_test_signal::require_sandbox().unwrap();
    let dir = TempDir::new();
    let runtime = runtime(&dir, None);
    let cwd = dir.path().to_str().unwrap().to_owned();
    block_on(async {
        let made = runtime.create(spec(&id(1), &cwd)).await.unwrap();
        let want = ForegroundProcess {
            command: "sleep".to_owned(),
            own: true,
            cwd: cfg!(target_os = "linux").then(|| dir.path().to_path_buf()),
        };
        assert_eq!(runtime.foreground(&made).await.unwrap(), want);
        let all = runtime
            .foregrounds(&HashSet::from([id(1), id(2)]))
            .await
            .unwrap();
        assert_eq!(all, [(made.clone(), want)]);
        runtime.close(&made).await.unwrap();
        runtime.shutdown().await;
    });
}

#[test]
#[ignore = "signals processes; runs in moon run :test-real -- rust"]
fn lists_each_holder_for_doctor_with_its_pid_memory_and_scope() {
    bazhen_test_signal::require_sandbox().unwrap();
    let dir = TempDir::new();
    let caps = TerminalCaps {
        terminal: "512M".to_owned(),
        total: "2G".to_owned(),
        swap: "0".to_owned(),
    };
    let runtime = runtime(&dir, Some(caps.clone()));
    block_on(async {
        let scoped = matches!(probe_containment(&caps).await, Ok(Containment::Scoped(_)));
        let made = runtime.create(spec(&id(1), "/")).await.unwrap();
        let builds = runtime.builds().await.unwrap();
        let [build] = builds.as_slice() else {
            panic!("listed {builds:?}");
        };
        let pid = os_pid(made.locator.holder_pid).unwrap();
        assert_eq!(
            (
                &build.terminal_id,
                build.holder_pid,
                &build.socket,
                build.build.as_deref()
            ),
            (
                &id(1),
                Some(made.locator.holder_pid),
                &made.locator.socket,
                None
            )
        );
        assert!(build.stats.is_some());
        assert_eq!(build.contained, in_terminal_scope(pid));
        if cfg!(target_os = "linux") {
            assert_eq!(build.contained, Some(scoped));
        }
        runtime.close(&made).await.unwrap();
        runtime.shutdown().await;
    });
}
