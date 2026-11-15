//! `respawn` through the built binary: a new child of a higher generation on a fresh PTY, and what
//! every connection is told of it, in order.

use std::collections::BTreeMap;
use std::path::Path;

use bazhen_holder_proto::body::{
    Argv, Env, ErrorBody, ExitStatus, Generation, NonEmpty, ProcessSpec,
};
use bazhen_holder_proto::{Reply, Request};

use super::{
    Client, FLOOD, LEAVES_A_STRAGGLER, exited_hello, exited_in, gone, is_ok, kill_straggler, pid,
    serving, serving_with, straggler, wait_gone,
};
use crate::{Result, home, start_time, sweep};

impl Client {
    fn respawn(&mut self, generation: u64, argv: &[&str]) -> Result<Request> {
        let mut env = BTreeMap::new();
        env.insert("PATH".to_owned(), std::env::var("PATH")?);
        let body = ProcessSpec {
            argv: Argv::new(argv.iter().map(|&a| a.to_owned()).collect())?,
            cwd: NonEmpty::new("/")?,
            env: Env::new(env)?,
            generation: Generation::new(generation)?,
            theme: None,
        };
        Ok(Request::Respawn {
            id: self.id(),
            body,
        })
    }

    /// The refusal of a respawn of `generation` running `argv`.
    fn respawn_refused(&mut self, generation: u64, argv: &[&str]) -> Result<ErrorBody> {
        let request = self.respawn(generation, argv)?;
        self.refused(&request)
    }
}

/// One generation's stream as a subscriber was sent it: its output, the gaps in it, and how it
/// ended.
#[derive(Debug, Default)]
struct Seen {
    bytes: Vec<u8>,
    gaps: Vec<(u64, u64)>,
    exited: Option<ExitStatus>,
}

/// What a subscriber is sent until `generations` children have exited, split at each
/// `respawned`. Every data frame and gap must run on from where the last one in its generation
/// ended, from 0 in each: one that spanned a respawn would break the run.
fn generations(client: &mut Client, generations: usize) -> Result<Vec<Seen>> {
    let mut seen = vec![Seen::default()];
    let mut end = 0;
    loop {
        let current = seen.last_mut().ok_or("no generation")?;
        match client.reply()? {
            Reply::Data { offset, bytes } => {
                if offset.get() != end {
                    return Err(format!("data at {}, after {end}", offset.get()).into());
                }
                end += bytes.len() as u64;
                current.bytes.extend_from_slice(&bytes);
            }
            Reply::Gap(gap) => {
                if gap.from.get() != end {
                    return Err(format!("a gap from {}, after {end}", gap.from.get()).into());
                }
                end = gap.to.get();
                current.gaps.push((gap.from.get(), end));
            }
            Reply::Exited(exited) => {
                current.exited = Some(exited.status);
                if seen.len() == generations {
                    return Ok(seen);
                }
            }
            Reply::Respawned(_) => {
                if current.exited.is_none() {
                    return Err("respawned before the old child's exit".into());
                }
                seen.push(Seen::default());
                end = 0;
            }
            Reply::Ok { .. } => {}
            other => return Err(format!("sent {other:?}").into()),
        }
    }
}

#[test]
#[ignore = "signals processes; runs in pnpm test:real rust"]
fn refuses_to_respawn_a_child_that_still_runs_and_leaves_it_running() {
    bazhen_test_signal::require_sandbox().unwrap();
    sweep().unwrap();
    let home = home("rsrunning").unwrap();
    let (_holder, socket) = serving(&home, &["sleep", "30"]).unwrap();
    let mut client = Client::connect(&socket).unwrap();
    let before = client.hello(false).unwrap();
    let refused = client.respawn_refused(1, &["true"]).unwrap();
    assert_eq!(refused.code, "running");
    let after = Client::connect(&socket).unwrap().hello(false).unwrap();
    assert_eq!(
        (after.generation, after.child_pid, after.exit),
        (before.generation, before.child_pid, None)
    );
}

#[test]
#[ignore = "signals processes; runs in pnpm test:real rust"]
fn refuses_a_stale_generation_a_nul_and_a_program_that_cant_start_leaving_the_terminal_as_it_was() {
    bazhen_test_signal::require_sandbox().unwrap();
    sweep().unwrap();
    let home = home("rsrefused").unwrap();
    let (_holder, socket) = serving(&home, &["true"]).unwrap();
    let before = exited_hello(&socket).unwrap();
    let mut client = Client::connect(&socket).unwrap();
    client.hello(false).unwrap();
    let stale = client.respawn_refused(0, &["true"]).unwrap();
    assert_eq!(stale.code, "stale-generation");
    let nul = client.respawn_refused(1, &["sh", "-c", "true\0"]).unwrap();
    assert_eq!(nul.code, "invalid");
    let missing = client.respawn_refused(1, &["/no/such/program"]).unwrap();
    assert_eq!(missing.code, "failed");
    let after = Client::connect(&socket).unwrap().hello(false).unwrap();
    assert_eq!(
        (after.generation, after.child_pid, after.exit, after.offset),
        (
            before.generation,
            before.child_pid,
            before.exit,
            before.offset
        )
    );
}

#[test]
#[ignore = "signals processes; runs in pnpm test:real rust"]
fn refuses_to_respawn_once_a_close_is_asked_for() {
    bazhen_test_signal::require_sandbox().unwrap();
    sweep().unwrap();
    let home = home("rsclosing").unwrap();
    let (_holder, socket) = serving(&home, &["true"]).unwrap();
    exited_hello(&socket).unwrap();
    let mut client = Client::connect(&socket).unwrap();
    client.hello(false).unwrap();
    let close = Request::Close { id: client.id() };
    let respawn = client.respawn(1, &["sleep", "30"]).unwrap();
    let mut both = close.encode().unwrap();
    both.extend(respawn.encode().unwrap());
    std::io::Write::write_all(&mut client.stream, &both).unwrap();
    assert!(matches!(client.reply().unwrap(), Reply::Ok { id, .. } if id == close.id()));
    match client.reply().unwrap() {
        Reply::Error { id, body } if id == respawn.id() => assert_eq!(body.code, "failed"),
        other => panic!("the respawn was answered {other:?}"),
    }
}

/// Every connection past `hello` is told, in order: the old child's output, its exit, the
/// respawn, then the new child's output from 0. The asker's `ok` comes after `respawned`; the
/// holder, its socket and the terminal stay; an old generation's offset is stale.
#[test]
#[ignore = "signals processes; runs in pnpm test:real rust"]
fn a_respawn_tells_every_connection_in_order_and_the_new_child_counts_from_zero() {
    bazhen_test_signal::require_sandbox().unwrap();
    sweep().unwrap();
    let home = home("rsorder").unwrap();
    let (mut holder, socket) = serving(&home, &["sh", "-c", "read _; printf old"]).unwrap();
    let mut watcher = Client::connect(&socket).unwrap();
    let first = watcher.hello(true).unwrap();
    assert!(first.writer);
    assert!(is_ok(&watcher.subscribe(Some((0, 0))).unwrap()));
    let newline = |client: &mut Client| Request::Input {
        id: client.id(),
        bytes: b"\n".to_vec(),
    };
    let input = newline(&mut watcher);
    watcher.send(&input).unwrap();
    exited_hello(&socket).unwrap();
    let mut asker = Client::connect(&socket).unwrap();
    asker.hello(false).unwrap();
    let respawn = asker
        .respawn(1, &["sh", "-c", "read _; printf new"])
        .unwrap();
    asker.send(&respawn).unwrap();
    let Reply::Respawned(respawned) = asker.reply().unwrap() else {
        panic!("the asker wasn't told of the respawn first");
    };
    assert!(matches!(asker.reply().unwrap(), Reply::Ok { id, .. } if id == respawn.id()));
    assert_eq!(respawned.generation.get(), 1);
    let child = u32::try_from(respawned.child_pid.get()).unwrap();
    assert_eq!(respawned.child_start.get(), start_time(child).unwrap());
    let stale = Request::Subscribe {
        id: asker.id(),
        body: bazhen_holder_proto::body::SubscribeRequest {
            from: Some(bazhen_holder_proto::body::SubscribeFrom {
                generation: Generation::new(0).unwrap(),
                offset: bazhen_holder_proto::body::Offset::new(0).unwrap(),
            }),
        },
    };
    assert_eq!(asker.refused(&stale).unwrap().code, "stale-generation");
    let hello = Client::connect(&socket).unwrap().hello(false).unwrap();
    assert_eq!(
        (
            hello.generation.get(),
            hello.child_pid,
            hello.exit,
            hello.offset.get()
        ),
        (1, respawned.child_pid, None, 0)
    );
    assert_eq!(
        (hello.holder_pid, hello.holder_start),
        (first.holder_pid, first.holder_start)
    );
    let input = newline(&mut watcher);
    watcher.send(&input).unwrap();
    let seen = generations(&mut watcher, 2).unwrap();
    assert_eq!(String::from_utf8_lossy(&seen[0].bytes), "\r\nold");
    assert_eq!(String::from_utf8_lossy(&seen[1].bytes), "\r\nnew");
    assert!(socket.exists());
    let close = Request::Close { id: asker.id() };
    asker.send(&close).unwrap();
    while !matches!(asker.reply().unwrap(), Reply::Ok { id, .. } if id == close.id()) {}
    assert_eq!(holder.exit().unwrap().0, Some(0));
}

/// A subscriber that stopped reading through two floods, with a respawn between them, is told of
/// each gap in its own generation: none runs across the respawn.
#[test]
#[ignore = "signals processes; runs in pnpm test:real rust"]
fn a_subscriber_lapped_across_a_respawn_gets_a_gap_in_each_generation() {
    bazhen_test_signal::require_sandbox().unwrap();
    sweep().unwrap();
    let home = home("rslapped").unwrap();
    let flood = "head -c 3000000 /dev/zero";
    let (_holder, socket) = serving_with(&home, &["sh", "-c", flood], &FLOOD).unwrap();
    let mut stalled = Client::connect(&socket).unwrap();
    stalled.hello(false).unwrap();
    assert!(is_ok(&stalled.subscribe(Some((0, 0))).unwrap()));
    exited_hello(&socket).unwrap();
    let mut asker = Client::connect(&socket).unwrap();
    asker.hello(false).unwrap();
    let respawn = asker.respawn(1, &["sh", "-c", flood]).unwrap();
    asker.send(&respawn).unwrap();
    assert!(matches!(asker.reply().unwrap(), Reply::Respawned(_)));
    assert!(matches!(asker.reply().unwrap(), Reply::Ok { .. }));
    exited_hello(&socket).unwrap();
    let seen = generations(&mut stalled, 2).unwrap();
    for (generation, stream) in seen.iter().enumerate() {
        let dropped: u64 = stream.gaps.iter().map(|(from, to)| to - from).sum();
        assert_eq!(
            stream.bytes.len() as u64 + dropped,
            3_000_000,
            "{generation}"
        );
    }
    assert!(!seen[1].gaps.is_empty(), "the new generation wasn't lapped");
}

/// The PTY fds a process holds, by what they name: masters (`/dev/ptmx`, or `/dev/pts/ptmx` where
/// devpts is mounted on its own, as in a container) and slaves (`/dev/pts/N`). Linux only, where
/// `/proc` says; `None` elsewhere, so macOS has no leak check here.
fn ptys_held(pid: rustix::process::Pid) -> Option<(usize, usize)> {
    let fds = std::fs::read_dir(format!("/proc/{}/fd", pid.as_raw_nonzero())).ok()?;
    let targets: Vec<_> = fds
        .filter_map(|fd| std::fs::read_link(fd.ok()?.path()).ok())
        .collect();
    let is_master =
        |t: &&std::path::PathBuf| *t == Path::new("/dev/ptmx") || *t == Path::new("/dev/pts/ptmx");
    let masters = targets.iter().filter(is_master).count();
    let slaves = targets
        .iter()
        .filter(|t| t.starts_with("/dev/pts/") && !is_master(t))
        .count();
    Some((masters, slaves))
}

/// The new child is on a fresh terminal: a mode the old program left set is gone. Each respawn
/// closes the old PTY, so after several the holder still holds one master and no slave.
#[test]
#[ignore = "signals processes; runs in pnpm test:real rust"]
fn the_new_child_gets_a_fresh_terminal_and_the_old_one_is_closed() {
    bazhen_test_signal::require_sandbox().unwrap();
    sweep().unwrap();
    let home = home("rsfresh").unwrap();
    let (holder, socket) = serving(&home, &["sh", "-c", "read _; stty raw"]).unwrap();
    let mut client = Client::connect(&socket).unwrap();
    assert!(client.hello(true).unwrap().writer);
    assert!(is_ok(&client.subscribe(Some((0, 0))).unwrap()));
    let input = Request::Input {
        id: client.id(),
        bytes: b"\n".to_vec(),
    };
    client.send(&input).unwrap();
    exited_hello(&socket).unwrap();
    let modes = "stty -a | tr ' ;' '\\n\\n' | grep -x -e icanon -e -icanon";
    for (generation, argv) in [
        (1, ["sh", "-c", modes]),
        (2, ["sh", "-c", "true"]),
        (3, ["sh", "-c", "true"]),
    ] {
        let respawn = client.respawn(generation, &argv).unwrap();
        client.send(&respawn).unwrap();
        exited_in(&socket, Some(generation)).unwrap();
    }
    let seen = generations(&mut client, 4).unwrap();
    assert_eq!(String::from_utf8_lossy(&seen[1].bytes), "icanon\r\n");
    if let Some(held) = ptys_held(holder.pid().unwrap()) {
        assert_eq!(held, (1, 0), "PTYs left open across respawns");
    }
}

/// The old generation's straggler, started before its child exited, and the respawn, answered.
fn respawned_past_a_straggler(
    home: &crate::Home,
) -> Result<(
    crate::Started,
    Client,
    rustix::process::Pid,
    rustix::process::Pid,
    std::path::PathBuf,
)> {
    let file = home.join("straggler");
    let path = file.to_str().ok_or("a path that isn't UTF-8")?;
    let (holder, socket) = serving(home, &["sh", "-c", LEAVES_A_STRAGGLER, path])?;
    let left = straggler(&file)?;
    let old = pid(exited_hello(&socket)?.child_pid.get())?;
    if gone(left) {
        return Err("the straggler died with its child".into());
    }
    let mut client = Client::connect(&socket)?;
    client.hello(false)?;
    let respawn = client.respawn(1, &["sleep", "30"])?;
    client.send(&respawn)?;
    if !matches!(client.reply()?, Reply::Respawned(_)) {
        return Err("the respawn wasn't told".into());
    }
    if !matches!(client.reply()?, Reply::Ok { id, .. } if id == respawn.id()) {
        return Err("the respawn wasn't answered ok".into());
    }
    Ok((holder, client, left, old, socket))
}

#[test]
#[ignore = "signals processes; runs in pnpm test:real rust"]
fn a_respawn_ends_what_the_old_generation_left_running() {
    bazhen_test_signal::require_sandbox().unwrap();
    sweep().unwrap();
    let home = home("rsstraggler").unwrap();
    let (_holder, _client, left, old, socket) = respawned_past_a_straggler(&home).unwrap();
    let ended = wait_gone(left);
    kill_straggler(left, old);
    ended.unwrap();
    let now = Client::connect(&socket).unwrap().hello(false).unwrap();
    assert_eq!((now.generation.get(), now.exit), (1, None));
}

#[test]
#[ignore = "signals processes; runs in pnpm test:real rust"]
fn a_close_right_after_a_respawn_ends_the_old_generation_before_the_holder_exits() {
    bazhen_test_signal::require_sandbox().unwrap();
    sweep().unwrap();
    let home = home("rsclosestraggler").unwrap();
    let (mut holder, mut client, left, old, _) = respawned_past_a_straggler(&home).unwrap();
    let close = Request::Close { id: client.id() };
    client.send(&close).unwrap();
    let (code, _) = holder.exit().unwrap();
    let ended = gone(left);
    kill_straggler(left, old);
    assert_eq!(code, Some(0));
    assert!(
        ended,
        "the holder exited with the old generation's job still running"
    );
}
