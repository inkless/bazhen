//! The runtime against real holders, the `bazhen-holder` this workspace builds: each test starts
//! one, signals or closes its child, or kills it, so each runs only in the sandbox.

use std::collections::{BTreeMap, HashSet};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use bazhen_holder_proto::body::{ExitStatus, Generation, HistoryLines, Signal, Size};
use bazhen_host_guard::scope::{Containment, TerminalCaps, in_terminal_scope, probe_containment};
use bazhen_protocol::ids::TerminalId;
use tokio::sync::broadcast;

use crate::client::{ClientOptions, EVENTS_QUEUED, connect};
use crate::fake_holder::fake_hello;
use crate::host::{Host as _, System};
use crate::locator::{HolderLocator, HolderRef, os_pid};
use crate::runtime::{
    ForegroundProcess, HELLO, HolderRuntime, Needs, ProcessLaunch, REQUEST, RuntimeError,
    RuntimeOptions, TerminalSpec,
};
use crate::sockets::HolderRoot;
use crate::stream::{StreamEnd, StreamEvent, StreamEvents};
use crate::tags::TerminalTags;
use crate::test_support::{TempDir, block_on, me};
use crate::watch::RuntimeEvent;

/// How long a test's own connection waits for a holder's `hello`: a holder busy with its child's
/// output, on a loaded host, can take past the product's `HELLO` to answer one.
const CONNECT_FOR: Duration = Duration::from_secs(30);

/// The holder built into the target directory this test binary is somewhere under, as
/// `cargo nextest run --workspace` builds it: the real one, so its name and start are what
/// `vouch` reads on every OS, with no copy of another program renamed. Searched for above the
/// binary, since where cargo puts a test binary under the target directory varies.
fn holder_binary() -> PathBuf {
    let exe = std::env::current_exe().unwrap();
    exe.ancestors()
        .skip(1)
        .map(|dir| dir.join("bazhen-holder"))
        .find(|holder| holder.is_file())
        .unwrap_or_else(|| {
            panic!(
                "no bazhen-holder above {}: run the workspace's tests, which build it",
                exe.display()
            )
        })
}

/// Every holder a test made, ended when the test ends, whether or not it passed, so a failed
/// assertion leaves no holder, nor its `sleep`, running. Each left is closed through its own
/// protocol, if it answers at its socket as the holder made; one that doesn't and still runs is
/// killed through `bazhen_test_signal`, once its pid and start are vouched for with the process
/// pinned. Made before the test's `block_on`, so it drops outside it, on a runtime of its own.
#[derive(Debug, Default)]
struct Holders(Mutex<Vec<HolderRef>>);

impl Holders {
    /// `made`, kept to be ended should the test not close it.
    fn keep(&self, made: HolderRef) -> HolderRef {
        self.0.lock().unwrap().push(made.clone());
        made
    }

    /// The runtime's close of `terminal`, which once it has closed leaves nothing for the drop.
    async fn close(
        &self,
        runtime: &HolderRuntime,
        terminal: &HolderRef,
    ) -> Result<(), RuntimeError> {
        runtime.close(terminal).await?;
        self.0
            .lock()
            .unwrap()
            .retain(|kept| kept.terminal_id != terminal.terminal_id);
        Ok(())
    }
}

impl Drop for Holders {
    fn drop(&mut self) {
        let left = std::mem::take(
            &mut *self
                .0
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
        );
        let unended: Vec<String> = left.iter().filter_map(|t| end(t).err()).collect();
        // Already unwinding, a second panic would abort the run and hide the first.
        assert!(
            unended.is_empty() || std::thread::panicking(),
            "couldn't end the holders a test left: {unended:?}"
        );
    }
}

/// Ends the holder `terminal` names, if it still runs.
fn end(terminal: &HolderRef) -> Result<(), String> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| e.to_string())?;
    if runtime.block_on(closed_by_protocol(terminal)) {
        return Ok(());
    }
    let Some(holder) = terminal.holder() else {
        return Ok(());
    };
    let pid = i64::from(holder.pid.as_raw_pid());
    match bazhen_test_signal::signal_if(pid, bazhen_test_signal::Signal::KILL, || {
        System.runs(holder)
    }) {
        Ok(_) | Err(bazhen_test_signal::Refused::Failed(_, rustix::io::Errno::SRCH)) => Ok(()),
        Err(refused) => Err(format!("holder {pid}: {refused}")),
    }
}

/// Whether the holder `terminal` names answered at its socket and closed.
async fn closed_by_protocol(terminal: &HolderRef) -> bool {
    let options = ClientOptions {
        connect: HELLO,
        ..ClientOptions::default()
    };
    let Ok((client, events)) = connect(&terminal.locator.socket, &options).await else {
        return false;
    };
    drop(events);
    if !terminal.locator.is_holder_of(client.hello()) {
        return false;
    }
    let closed = tokio::time::timeout(REQUEST, client.close())
        .await
        .is_ok_and(|closed| closed.is_ok());
    let ended = tokio::time::timeout(REQUEST, client.ended()).await.is_ok();
    client.end();
    closed && ended
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

/// Kills `terminal`'s holder once it is pinned and checked to be still that holder, by its name
/// and start time: the runtime's reaper, not this test, reaps it, so its pid may be reused.
fn kill_holder(terminal: &HolderRef) {
    let holder = terminal.holder().unwrap();
    let sent = bazhen_test_signal::signal_if(
        holder.pid.as_raw_pid(),
        bazhen_test_signal::Signal::KILL,
        || System.runs(holder),
    );
    assert_eq!(sent, Ok(true));
}

#[test]
#[ignore = "signals processes; runs in moon run :test-real -- rust"]
fn creates_a_terminal_its_inventory_finds_and_closes_it_by_protocol() {
    bazhen_test_signal::require_sandbox().unwrap();
    let dir = TempDir::new();
    let runtime = runtime(&dir, None);
    let holders = Holders::default();
    block_on(async {
        let made = holders.keep(runtime.create(spec(&id(1), "/")).await.unwrap());
        assert!(System.runs(made.holder().unwrap()));
        let encoded = made.locator.encode().unwrap();
        assert_eq!(HolderLocator::decode(&encoded).unwrap(), made.locator);
        let found = runtime.inventory().await.unwrap();
        let listed: Vec<_> = found
            .iter()
            .map(|e| (&e.terminal, &e.tags, &e.exit))
            .collect();
        assert_eq!(listed, [(&made, &shell(), &None)]);
        holders.close(&runtime, &made).await.unwrap();
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
    let holders = Holders::default();
    block_on(async {
        let mut told = runtime.events();
        let made = holders.keep(runtime.create(spec(&id(1), "/")).await.unwrap());
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
        holders.close(&runtime, &next).await.unwrap();
        runtime.shutdown().await;
    });
}

#[test]
#[ignore = "signals processes; runs in moon run :test-real -- rust"]
fn tells_a_holder_killed_lost_and_counts_its_terminal_closed_removing_its_socket() {
    bazhen_test_signal::require_sandbox().unwrap();
    let dir = TempDir::new();
    let runtime = runtime(&dir, None);
    let holders = Holders::default();
    block_on(async {
        let mut told = runtime.events();
        let made = holders.keep(runtime.create(spec(&id(1), "/")).await.unwrap());
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
        holders.close(&runtime, &made).await.unwrap();
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
    let holders = Holders::default();
    block_on(async {
        let made = holders.keep(runtime.create(spec(&id(1), &cwd)).await.unwrap());
        let want = ForegroundProcess {
            command: "sleep".to_owned(),
            own: true,
            cwd: cfg!(target_os = "linux").then(|| dir.path().to_path_buf()),
        };
        // The holder's `sh -c "exec sleep 600"` is the shell until it has exec'd, which may be a
        // moment after the create answers.
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut read = runtime.foreground(&made).await.unwrap();
        while read.command != want.command && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(20)).await;
            read = runtime.foreground(&made).await.unwrap();
        }
        assert_eq!(read, want);
        let all = runtime
            .foregrounds(&HashSet::from([id(1), id(2)]))
            .await
            .unwrap();
        assert_eq!(all, [(made.clone(), want)]);
        holders.close(&runtime, &made).await.unwrap();
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
    let holders = Holders::default();
    block_on(async {
        let scoped = matches!(probe_containment(&caps).await, Ok(Containment::Scoped(_)));
        let made = holders.keep(runtime.create(spec(&id(1), "/")).await.unwrap());
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
        holders.close(&runtime, &made).await.unwrap();
        runtime.shutdown().await;
    });
}

/// A terminal running `program` through `sh -c`, as `spec` makes one.
fn running(terminal_id: &TerminalId, program: &str) -> TerminalSpec {
    let mut made = spec(terminal_id, "/");
    made.process.argv = ["/bin/sh", "-c", program].map(str::to_owned).to_vec();
    made
}

/// The bytes of every `Data` event `events` holds now, failing on any failure told.
fn delivered(events: &mut StreamEvents) -> Vec<u8> {
    let mut bytes = Vec::new();
    while let Some(event) = events.try_recv() {
        match event {
            StreamEvent::Data { bytes: more, .. } => bytes.extend(more),
            StreamEvent::Failed(failure) => panic!("told {failure:?}"),
            _ => {}
        }
    }
    bytes
}

/// How long a held snapshot is watched not answering, before its stream's events are taken.
const HELD_FOR: Duration = Duration::from_millis(500);

#[test]
#[ignore = "signals processes; runs in moon run :test-real -- rust"]
fn holds_a_streams_snapshot_until_it_has_delivered_the_output_before_it() {
    bazhen_test_signal::require_sandbox().unwrap();
    let dir = TempDir::new();
    let runtime = runtime(&dir, None);
    let holders = Holders::default();
    block_on(async {
        let made = holders.keep(runtime.create(running(&id(1), "exec cat")).await.unwrap());
        let mut attached = runtime.attach(&made, None).await.unwrap();
        // Untaken, these fill the stream's events and those queued behind them, so the stream
        // reads no further: the echo the holder sends next waits behind them all.
        for at in 0..2 * EVENTS_QUEUED {
            let cols = if at % 2 == 0 { 81 } else { 82 };
            let size = Size {
                cols: cols.try_into().unwrap(),
                rows: 24.try_into().unwrap(),
            };
            attached.stream.resize(size).await.unwrap();
        }
        attached.stream.write(b"hello\n");
        // Read on a connection of its own, the holder's offset says it has the echo.
        let options = ClientOptions {
            connect: CONNECT_FOR,
            ..ClientOptions::default()
        };
        let (client, _events) = connect(&made.locator.socket, &options).await.unwrap();
        let from = attached.offset.get();
        // Bounded: a holder that never reads it leaves the snapshot nothing behind, which the
        // assertion below tells.
        let deadline = Instant::now() + Duration::from_secs(10);
        while client.snapshot().await.unwrap().offset.get() == from && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        client.end();
        let (held, snapshot, mut taken) = {
            let mut waiting = std::pin::pin!(attached.stream.snapshot());
            let mut taken = Vec::new();
            let (held, snapshot) = match tokio::time::timeout(HELD_FOR, &mut waiting).await {
                Ok(snapshot) => (false, snapshot.unwrap()),
                // Taken a batch at a time between looks at the snapshot, so the stream can queue
                // more.
                Err(_) => loop {
                    if let Ok(snapshot) =
                        tokio::time::timeout(Duration::from_millis(5), &mut waiting).await
                    {
                        break (true, snapshot.unwrap());
                    }
                    while let Some(event) = attached.events.try_recv() {
                        taken.push(event);
                    }
                },
            };
            (held, snapshot, taken)
        };
        // What was queued as the snapshot came back, taken before the stream can queue more.
        while let Some(event) = attached.events.try_recv() {
            taken.push(event);
        }
        let mut output = Vec::new();
        let mut next = from;
        for event in taken {
            match event {
                StreamEvent::Data { at, bytes } => {
                    assert_eq!(at.offset.get(), next);
                    next += u64::try_from(bytes.len()).unwrap();
                    output.extend(bytes);
                }
                StreamEvent::Failed(failure) => panic!("told {failure:?}"),
                _ => {}
            }
        }
        let behind = usize::try_from(snapshot.offset.get() - from).unwrap();
        assert_eq!(
            (held, behind > 0, output.get(..behind).map(<[u8]>::len)),
            (true, true, Some(behind))
        );
        drop(attached);
        holders.close(&runtime, &made).await.unwrap();
        runtime.shutdown().await;
    });
}

#[test]
#[ignore = "signals processes; runs in moon run :test-real -- rust"]
fn confirms_a_resize_by_the_size_the_readers_holder_reports() {
    bazhen_test_signal::require_sandbox().unwrap();
    let dir = TempDir::new();
    let runtime = runtime(&dir, None);
    let holders = Holders::default();
    block_on(async {
        let made = holders.keep(runtime.create(running(&id(1), "exec cat")).await.unwrap());
        let mut attached = runtime.attach(&made, None).await.unwrap();
        let asked = Size {
            cols: 100.try_into().unwrap(),
            rows: 30.try_into().unwrap(),
        };
        attached.stream.resize(asked).await.unwrap();
        assert_eq!(attached.stream.size(), asked);
        let mut resized = Vec::new();
        while let Some(event) = attached.events.try_recv() {
            if let StreamEvent::Resized(size) = event {
                resized.push(size);
            }
        }
        assert_eq!(resized, [asked]);
        drop(attached);
        holders.close(&runtime, &made).await.unwrap();
        runtime.shutdown().await;
    });
}

#[test]
#[ignore = "signals processes; runs in moon run :test-real -- rust"]
fn closes_a_stream_its_holders_ring_has_run_past_as_behind() {
    bazhen_test_signal::require_sandbox().unwrap();
    let dir = TempDir::new();
    let runtime = runtime(&dir, None);
    let holders = Holders::default();
    block_on(async {
        // It floods only once told to, after the attach: a holder already flooding can take past
        // the product's bound to answer one on a loaded host.
        let made = holders.keep(
            runtime
                .create(running(&id(1), "read line; exec yes"))
                .await
                .unwrap(),
        );
        let mut attached = runtime.attach(&made, None).await.unwrap();
        attached.stream.write(b"\n");
        // The write goes out on this thread, so it runs until a connection of its own sees the
        // flood start; `from` is then past all the stream has read.
        let options = ClientOptions {
            connect: CONNECT_FOR,
            ..ClientOptions::default()
        };
        let (client, _events) = connect(&made.locator.socket, &options).await.unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        let from = loop {
            let offset = client.snapshot().await.unwrap().offset.get();
            if offset > attached.offset.get() || Instant::now() >= deadline {
                break offset;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        };
        client.end();
        // This thread blocked, the stream reads nothing until the holder has written past all
        // its ring holds, as a second connection's snapshots show.
        let socket = made.locator.socket.clone();
        let past = from + 4 * (1 << 20);
        let reached = std::thread::spawn(move || {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap()
                .block_on(async {
                    let connected = connect(&socket, &options).await;
                    assert_eq!(connected.as_ref().err().map(ToString::to_string), None);
                    let (client, _events) = connected.unwrap();
                    // Bounded: a flood that never starts is told by the assertion below, not a
                    // hang.
                    let deadline = Instant::now() + Duration::from_secs(60);
                    let reached = loop {
                        let offset = client.snapshot().await.unwrap().offset.get();
                        if offset > past || Instant::now() >= deadline {
                            break offset;
                        }
                        tokio::time::sleep(Duration::from_millis(20)).await;
                    };
                    client.end();
                    reached
                })
        })
        .join()
        .unwrap();
        assert_eq!((from > attached.offset.get(), reached > past), (true, true));
        let closed = loop {
            match attached.events.recv().await.unwrap() {
                StreamEvent::Closed(why) => break why,
                StreamEvent::Failed(failure) => panic!("told {failure:?}"),
                _ => {}
            }
        };
        assert_eq!(closed, StreamEnd::Behind);
        assert!(attached.events.recv().await.is_none());
        assert!(attached.stream.is_closed());
        holders.close(&runtime, &made).await.unwrap();
        runtime.shutdown().await;
    });
}

#[test]
#[ignore = "signals processes; runs in moon run :test-real -- rust"]
fn hands_the_writer_slot_to_the_next_stream_once_the_last_has_closed() {
    bazhen_test_signal::require_sandbox().unwrap();
    let dir = TempDir::new();
    let runtime = runtime(&dir, None);
    let holders = Holders::default();
    block_on(async {
        let made = holders.keep(runtime.create(running(&id(1), "exec cat")).await.unwrap());
        let first = runtime.attach(&made, None).await.unwrap();
        first.stream.write(b"first\n");
        first.stream.snapshot().await.unwrap();
        drop(first);
        let mut second = runtime.attach(&made, None).await.unwrap();
        second.stream.write(b"second\n");
        let mut output = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(10);
        while !String::from_utf8_lossy(&output).contains("second") {
            assert!(Instant::now() < deadline, "never echoed: {output:?}");
            second.stream.snapshot().await.unwrap();
            output.extend(delivered(&mut second.events));
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        drop(second);
        holders.close(&runtime, &made).await.unwrap();
        runtime.shutdown().await;
    });
}
