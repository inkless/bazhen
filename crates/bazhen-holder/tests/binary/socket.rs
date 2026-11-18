//! The holder's socket, through the built binary: where it binds, who it serves, and how it ends.

use std::io::{Read as _, Write as _};
use std::os::unix::fs::PermissionsExt as _;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::Path;
use std::time::Instant;

use bazhen_holder::start_time;
use bazhen_holder_proto::body::{
    ErrorBody, Generation, HelloReply, HelloRequest, Offset, SubscribeFrom, SubscribeRequest,
    VersionText, Versions,
};
use bazhen_holder_proto::{FrameDecoder, Reply, Request, RequestId, reply_decoder};
use rustix::process::{Pid, Signal};

use super::{DEADLINE, Home, Result, Start, Started, home, spawn, spec, sweep};

mod paste;
mod respawn;
mod verbs;

/// A `holder/1` client, as the daemon would be one.
struct Client {
    stream: UnixStream,
    decoder: FrameDecoder<Reply>,
    next_id: u32,
}

impl Client {
    fn connect(path: &Path) -> Result<Self> {
        let stream = UnixStream::connect(path)?;
        stream.set_read_timeout(Some(DEADLINE))?;
        Ok(Self {
            stream,
            decoder: reply_decoder(),
            next_id: 0,
        })
    }

    fn id(&mut self) -> RequestId {
        self.next_id += 1;
        RequestId(self.next_id)
    }

    fn send(&mut self, request: &Request) -> Result<()> {
        self.stream.write_all(&request.encode()?)?;
        Ok(())
    }

    /// The next frame, or `None` once the holder has hung up.
    fn next(&mut self) -> Result<Option<Reply>> {
        let mut chunk = vec![0u8; 1 << 16];
        loop {
            if let Some(reply) = self.decoder.next_frame()? {
                return Ok(Some(reply));
            }
            match self.stream.read(&mut chunk)? {
                0 => return Ok(None),
                n => self.decoder.push(chunk.get(..n).unwrap_or_default()),
            }
        }
    }

    fn reply(&mut self) -> Result<Reply> {
        self.next()?.ok_or_else(|| "the holder hung up".into())
    }

    fn hello_with(&mut self, protocol: Versions, writer: bool) -> Result<Reply> {
        let id = self.id();
        let body = HelloRequest {
            protocol,
            writer: Some(writer),
        };
        self.send(&Request::Hello { id, body })?;
        self.reply()
    }

    fn hello(&mut self, writer: bool) -> Result<HelloReply> {
        match self.hello_with(Versions::spoken(), writer)? {
            Reply::Hello { body, .. } => Ok(body),
            other => Err(format!("hello was answered {other:?}").into()),
        }
    }

    /// The error a request was answered with.
    fn refused(&mut self, request: &Request) -> Result<ErrorBody> {
        self.send(request)?;
        match self.reply()? {
            Reply::Error { id, body } if id == request.id() => Ok(body),
            other => Err(format!("{request:?} was answered {other:?}").into()),
        }
    }

    /// Whether the holder hangs up with nothing more to say.
    fn hangs_up(&mut self) -> Result<bool> {
        Ok(self.next()?.is_none())
    }
}

/// A holder serving `argv`, once it has said `ready`, and its socket's path.
fn serving(home: &Home, argv: &[&str]) -> Result<(Started, std::path::PathBuf)> {
    serving_with(home, argv, &Start::default())
}

/// A holder for a flood: macOS hands its output over in small reads, so moving tens of
/// megabytes costs the holder far more turns, and CPU-seconds, than the 2 a holder gets
/// otherwise, in a debug build.
const FLOOD: Start<'static> = Start {
    prelude: "",
    own_group: false,
    blocked_signals: false,
    stderr: false,
    cpu_seconds: Some(10),
};

/// How a holder that dropped a connection stands, and what it logged, for the test's failure.
fn why(holder: &mut Started, socket: &Path) -> String {
    let log = std::fs::read_to_string(socket.with_extension("log")).unwrap_or_default();
    format!("the holder {}; its log:\n{log}", holder.state())
}

fn serving_with(
    home: &Home,
    argv: &[&str],
    how: &Start<'_>,
) -> Result<(Started, std::path::PathBuf)> {
    let mut holder = spawn(&spec(home, argv, |_| {}), how)?;
    let line = holder.first_line()?;
    if line != "ready\n" {
        return Err(format!("the holder said {line:?}").into());
    }
    Ok((holder, home.join("t1.sock")))
}

/// Connects once `path` takes connections, before `DEADLINE`.
fn connect_by(path: &Path, deadline: Instant) -> Result<Client> {
    loop {
        match Client::connect(path) {
            Ok(client) => return Ok(client),
            Err(e) if Instant::now() >= deadline => return Err(e),
            // Something else binds it: there is nothing to wait on but the file.
            Err(_) => std::thread::sleep(std::time::Duration::from_millis(20)),
        }
    }
}

fn pid(raw: u64) -> Result<Pid> {
    Pid::from_raw(i32::try_from(raw)?).ok_or_else(|| "not a pid".into())
}

#[test]
#[ignore = "signals processes; runs in pnpm test:real rust"]
fn says_ready_once_its_socket_takes_connections_that_only_its_user_may_make() {
    bazhen_test_signal::require_sandbox().unwrap();
    sweep().unwrap();
    let home = home("bound").unwrap();
    let (_holder, socket) = serving(&home, &["sleep", "30"]).unwrap();
    let mode = std::fs::metadata(&socket).unwrap().permissions().mode();
    assert_eq!(mode & 0o777, 0o600);
    UnixStream::connect(&socket).unwrap();
}

#[test]
#[ignore = "signals processes; runs in pnpm test:real rust"]
fn refuses_a_directory_others_may_enter_with_exit_6_writing_nothing() {
    bazhen_test_signal::require_sandbox().unwrap();
    sweep().unwrap();
    let home = home("open-dir").unwrap();
    std::fs::set_permissions(&*home, std::fs::Permissions::from_mode(0o750)).unwrap();
    let how = Start {
        stderr: true,
        ..Start::default()
    };
    let mut holder = spawn(&spec(&home, &["sleep", "30"], |_| {}), &how).unwrap();
    let (code, stderr) = holder.exit().unwrap();
    assert_eq!(code, Some(6), "{stderr}");
    assert!(stderr.contains("private"), "{stderr}");
    assert_eq!(std::fs::read_dir(&*home).unwrap().count(), 0);
}

#[test]
#[ignore = "signals processes; runs in pnpm test:real rust"]
fn a_second_holder_for_a_terminal_exits_7_and_the_first_keeps_its_socket() {
    bazhen_test_signal::require_sandbox().unwrap();
    sweep().unwrap();
    let home = home("twice").unwrap();
    let (_first, socket) = serving(&home, &["sleep", "30"]).unwrap();
    let how = Start {
        stderr: true,
        ..Start::default()
    };
    let mut second = spawn(&spec(&home, &["sleep", "30"], |_| {}), &how).unwrap();
    let (code, stderr) = second.exit().unwrap();
    assert_eq!(code, Some(7), "{stderr}");
    UnixStream::connect(&socket).unwrap();
}

#[test]
#[ignore = "signals processes; runs in pnpm test:real rust"]
fn refuses_a_socket_path_that_is_relative_or_too_long_with_exit_2() {
    bazhen_test_signal::require_sandbox().unwrap();
    sweep().unwrap();
    let home = home("path").unwrap();
    let long = format!("/tmp/{}.sock", "a".repeat(100));
    for socket in ["t1.sock".to_owned(), long] {
        let bytes = spec(&home, &["sleep", "30"], |s| {
            s["socket"] = socket.clone().into();
        });
        let mut holder = spawn(&bytes, &Start::default()).unwrap();
        assert_eq!(holder.exit().unwrap().0, Some(2), "{socket}");
    }
}

#[test]
#[ignore = "signals processes; runs in pnpm test:real rust"]
fn replaces_a_dead_holders_socket() {
    bazhen_test_signal::require_sandbox().unwrap();
    sweep().unwrap();
    let home = home("stale").unwrap();
    drop(UnixListener::bind(home.join("t1.sock")).unwrap());
    let (_holder, socket) = serving(&home, &["sleep", "30"]).unwrap();
    UnixStream::connect(&socket).unwrap();
}

/// The holder binds under a umask of its own; the child must get the spawner's back.
#[test]
#[ignore = "signals processes; runs in pnpm test:real rust"]
fn the_child_gets_the_spawners_umask() {
    bazhen_test_signal::require_sandbox().unwrap();
    sweep().unwrap();
    let home = home("umask").unwrap();
    let report = home.join("umask");
    let script = format!("umask > {}; exec sleep 30", report.display());
    let how = Start {
        prelude: "umask 027 &&",
        ..Start::default()
    };
    let mut holder = spawn(&spec(&home, &["sh", "-c", &script], |_| {}), &how).unwrap();
    assert_eq!(holder.first_line().unwrap(), "ready\n");
    super::wait_for_file(&report, |t| t.ends_with('\n')).unwrap();
    assert_eq!(std::fs::read_to_string(&report).unwrap().trim(), "0027");
}

#[test]
#[ignore = "signals processes; runs in pnpm test:real rust"]
fn a_program_that_cant_start_leaves_no_socket_behind() {
    bazhen_test_signal::require_sandbox().unwrap();
    sweep().unwrap();
    let home = home("no-program").unwrap();
    let mut holder = spawn(
        &spec(&home, &["/nonexistent/program"], |_| {}),
        &Start::default(),
    )
    .unwrap();
    assert_eq!(holder.exit().unwrap().0, Some(1));
    assert!(!home.join("t1.sock").exists());
}

#[test]
#[ignore = "signals processes; runs in pnpm test:real rust"]
fn says_ready_only_once_its_socket_answers_with_who_it_is() {
    bazhen_test_signal::require_sandbox().unwrap();
    sweep().unwrap();
    let home = home("hello").unwrap();
    // exec keeps a process's start, so the holder's predates its child's by a second at least,
    // and a mix-up of the two shows.
    let how = Start {
        prelude: "sleep 1 &&",
        ..Start::default()
    };
    let mut holder = spawn(&spec(&home, &["sleep", "30"], |_| {}), &how).unwrap();
    assert_eq!(holder.first_line().unwrap(), "ready\n");
    let socket = home.join("t1.sock");
    let hello = Client::connect(&socket).unwrap().hello(true).unwrap();
    assert_eq!(hello.terminal_id.as_str(), "t1");
    assert_eq!(hello.holder_pid.get(), u64::from(holder.pid));
    let holder_start = start_time::of(holder.pid().unwrap()).unwrap();
    assert_eq!(hello.holder_start, holder_start);
    let child = pid(hello.child_pid.get()).unwrap();
    assert_eq!(rustix::process::getsid(Some(child)).unwrap(), child);
    assert_eq!(hello.child_start, start_time::of(child).unwrap());
    assert!(hello.child_start > hello.holder_start);
    assert_eq!(hello.exit, None);
    assert_eq!(hello.offset.get(), 0);
    assert_eq!((hello.size.cols.get(), hello.size.rows.get()), (80, 24));
    assert!(hello.writer);
    assert_eq!(hello.version.as_str(), "1.4");
}

#[test]
#[ignore = "signals processes; runs in pnpm test:real rust"]
fn hands_the_writer_slot_to_one_connection_at_a_time() {
    bazhen_test_signal::require_sandbox().unwrap();
    sweep().unwrap();
    let home = home("writer").unwrap();
    let (_holder, socket) = serving(&home, &["sleep", "30"]).unwrap();
    let mut first = Client::connect(&socket).unwrap();
    assert!(first.hello(true).unwrap().writer);
    assert!(
        !Client::connect(&socket)
            .unwrap()
            .hello(true)
            .unwrap()
            .writer
    );
    assert!(
        !Client::connect(&socket)
            .unwrap()
            .hello(false)
            .unwrap()
            .writer
    );
    drop(first);
    let deadline = Instant::now() + DEADLINE;
    while !Client::connect(&socket)
        .unwrap()
        .hello(true)
        .unwrap()
        .writer
    {
        assert!(Instant::now() < deadline, "the slot was never freed");
    }
}

#[test]
#[ignore = "signals processes; runs in pnpm test:real rust"]
fn takes_nothing_before_hello_and_no_second_hello() {
    bazhen_test_signal::require_sandbox().unwrap();
    sweep().unwrap();
    let home = home("order").unwrap();
    let (_holder, socket) = serving(&home, &["sleep", "30"]).unwrap();
    let mut early = Client::connect(&socket).unwrap();
    let close = Request::Close { id: RequestId(7) };
    assert_eq!(early.refused(&close).unwrap().code, "invalid");
    assert!(early.hangs_up().unwrap());
    let mut twice = Client::connect(&socket).unwrap();
    twice.hello(false).unwrap();
    let again = twice.hello_with(Versions::spoken(), false).unwrap();
    assert!(matches!(again, Reply::Error { body, .. } if body.code == "invalid"));
    assert!(twice.hangs_up().unwrap());
    Client::connect(&socket).unwrap().hello(false).unwrap();
}

#[test]
#[ignore = "signals processes; runs in pnpm test:real rust"]
fn tells_a_client_it_shares_no_major_with_the_versions_it_speaks() {
    bazhen_test_signal::require_sandbox().unwrap();
    sweep().unwrap();
    let home = home("major").unwrap();
    let (_holder, socket) = serving(&home, &["sleep", "30"]).unwrap();
    let mut client = Client::connect(&socket).unwrap();
    let theirs = Versions::new(vec![VersionText::new("99.0").unwrap()]).unwrap();
    match client.hello_with(theirs, false).unwrap() {
        Reply::Error { body, .. } => {
            assert_eq!(body.code, "no-shared-version");
            assert_eq!(body.protocol, Some(Versions::spoken()));
        }
        other => panic!("answered {other:?}"),
    }
    assert!(client.hangs_up().unwrap());
}

#[test]
#[ignore = "signals processes; runs in pnpm test:real rust"]
fn answers_a_request_it_does_not_know() {
    bazhen_test_signal::require_sandbox().unwrap();
    sweep().unwrap();
    let home = home("unknown").unwrap();
    let (_holder, socket) = serving(&home, &["sleep", "30"]).unwrap();
    let mut client = Client::connect(&socket).unwrap();
    client.hello(false).unwrap();
    // A request type in the requests' range that this build doesn't know: length 5, type 0x2a,
    // request id 6.
    let frame = [&5u32.to_be_bytes()[..], &[0x2a], &6u32.to_be_bytes()].concat();
    client.stream.write_all(&frame).unwrap();
    match client.reply().unwrap() {
        Reply::Error { body, .. } => {
            assert_eq!(
                (body.request.as_str(), body.code.as_str()),
                ("0x2a", "unknown-request")
            );
        }
        other => panic!("answered {other:?}"),
    }
    client.hello_with(Versions::spoken(), false).unwrap();
}

#[test]
#[ignore = "signals processes; runs in pnpm test:real rust"]
fn a_malformed_frame_ends_only_its_own_connection() {
    bazhen_test_signal::require_sandbox().unwrap();
    sweep().unwrap();
    let home = home("malformed").unwrap();
    let (_holder, socket) = serving(&home, &["sleep", "30"]).unwrap();
    let mut good = Client::connect(&socket).unwrap();
    good.hello(false).unwrap();
    let mut bad = Client::connect(&socket).unwrap();
    bad.hello(false).unwrap();
    bad.stream.write_all(&u32::MAX.to_be_bytes()).unwrap();
    assert!(bad.hangs_up().unwrap());
    let mut gone = Client::connect(&socket).unwrap();
    gone.send(&Request::Close { id: RequestId(1) }).unwrap();
    drop(gone);
    let answer = good.refused(&refused_request(9).unwrap()).unwrap();
    assert_eq!(answer.code, "stale-generation");
}

#[test]
#[ignore = "signals processes; runs in pnpm test:real rust"]
fn close_answers_ok_ends_the_child_removes_the_socket_and_exits_0() {
    bazhen_test_signal::require_sandbox().unwrap();
    sweep().unwrap();
    let home = home("close").unwrap();
    let (mut holder, socket) = serving(&home, &["sleep", "30"]).unwrap();
    let mut client = Client::connect(&socket).unwrap();
    let hello = client.hello(false).unwrap();
    let child = pid(hello.child_pid.get()).unwrap();
    client.send(&Request::Close { id: RequestId(3) }).unwrap();
    assert!(matches!(
        client.reply().unwrap(),
        Reply::Ok {
            id: RequestId(3),
            ..
        }
    ));
    assert!(matches!(client.reply().unwrap(), Reply::Exited(_)));
    assert!(client.hangs_up().unwrap());
    let (code, _) = holder.exit().unwrap();
    assert_eq!(code, Some(0));
    assert!(!socket.exists(), "the socket is still there");
    assert!(matches!(
        start_time::of(child),
        Err(start_time::StartTimeError::Absent(_))
    ));
    assert!(home.join("t1.lock").exists());
}

#[test]
#[ignore = "signals processes; runs in pnpm test:real rust"]
fn a_closing_holder_binds_no_socket_again_though_told_to() {
    bazhen_test_signal::require_sandbox().unwrap();
    sweep().unwrap();
    let home = home("closing-rebind").unwrap();
    // A child that ignores the hang-up keeps the close going until its kill, a grace later.
    let (mut holder, socket) = serving(&home, &["sh", "-c", "trap '' HUP; exec sleep 30"]).unwrap();
    let mut client = Client::connect(&socket).unwrap();
    client.hello(false).unwrap();
    client.send(&Request::Close { id: RequestId(3) }).unwrap();
    assert!(matches!(
        client.reply().unwrap(),
        Reply::Ok {
            id: RequestId(3),
            ..
        }
    ));
    bazhen_test_signal::signal(holder.pid, Signal::USR1).unwrap();
    holder.exit().unwrap();
    // Nothing removes a socket bound after the close began, so one would outlive the holder.
    assert!(
        !socket.exists(),
        "the socket was bound again while the holder closed"
    );
}

/// A child that leaves a job behind in a group of its own, which ignores `SIGHUP` and writes its
/// pid to the file named by `$0`, then exits.
const LEAVES_A_STRAGGLER: &str =
    r#"set -m; (trap '' HUP; exec sh -c 'echo $$ > "$1"; exec sleep 30' sh "$0") & exit 0"#;

/// The straggler's pid, once it has written it.
fn straggler(path: &Path) -> Result<Pid> {
    let text = super::wait_for_file(path, |text| text.ends_with('\n'))?;
    pid(text.trim().parse()?)
}

/// Whether `pid` has died: gone, or a zombie its new parent hasn't reaped yet.
fn gone(pid: Pid) -> bool {
    let raw = u32::try_from(pid.as_raw_nonzero().get()).unwrap_or_default();
    rustix::process::test_kill_process(pid).is_err()
        || super::ps("state=", raw).is_some_and(|state| state.starts_with('Z'))
}

/// Waits, for at most `DEADLINE`, until `pid` has died.
fn wait_gone(pid: Pid) -> Result<()> {
    let deadline = Instant::now() + DEADLINE;
    while !gone(pid) {
        if Instant::now() >= deadline {
            return Err(format!("{} still runs", pid.as_raw_nonzero()).into());
        }
        // Not ours to wait on: init reaps it once it dies. This checks every 20 ms.
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    Ok(())
}

/// A `hello` once the child's exit is published.
pub(super) fn exited_hello(socket: &Path) -> Result<HelloReply> {
    exited_in(socket, None)
}

/// How long a wait for an exit reads nothing before it gives up: far past any child the tests run,
/// even a flood on a loaded runner, so only a holder that has stopped reaches it.
const EXIT_WAIT: std::time::Duration = std::time::Duration::from_secs(60);

/// A `hello` once the exit of `generation`'s child, or of any, is published. It waits for the
/// `exited` the holder sends every connection past `hello`, rather than asking again: a
/// connection asking in a loop takes the holder's turns from the child's output. A new connection
/// may be answered before a respawn sent on another reaches the holder; the `respawned` and the
/// new generation's `exited` then follow.
pub(super) fn exited_in(socket: &Path, generation: Option<u64>) -> Result<HelloReply> {
    let wanted = |g: u64| generation.is_none_or(|wanted| wanted == g);
    let mut watcher = Client::connect(socket)?;
    watcher.stream.set_read_timeout(Some(EXIT_WAIT))?;
    let hello = watcher.hello(false)?;
    if hello.exit.is_some() && wanted(hello.generation.get()) {
        return Ok(hello);
    }
    loop {
        match watcher.next() {
            Ok(Some(Reply::Exited(exited))) if wanted(exited.generation.get()) => break,
            Ok(Some(_)) => {}
            Ok(None) => return Err("the child never exited: the holder hung up".into()),
            Err(e) => return Err(format!("the child never exited: {e}").into()),
        }
    }
    Client::connect(socket)?.hello(false)
}

/// Kills a straggler a test left, if it is still in the session the test's child led: a pid that
/// has left it may already be another process's.
fn kill_straggler(straggler: Pid, child: Pid) {
    if rustix::process::getsid(Some(straggler)).is_ok_and(|sid| sid == child) {
        let _ = bazhen_test_signal::signal(straggler.as_raw_pid(), Signal::KILL);
    }
}

#[test]
#[ignore = "signals processes; runs in pnpm test:real rust"]
fn a_close_ends_what_the_child_left_running_before_the_holder_exits() {
    bazhen_test_signal::require_sandbox().unwrap();
    sweep().unwrap();
    let home = home("straggler").unwrap();
    let file = home.join("straggler");
    let argv = ["sh", "-c", LEAVES_A_STRAGGLER, file.to_str().unwrap()];
    let (mut holder, socket) = serving(&home, &argv).unwrap();
    let left = straggler(&file).unwrap();
    let mut client = Client::connect(&socket).unwrap();
    let hello = client.hello(false).unwrap();
    let child = pid(hello.child_pid.get()).unwrap();
    exited_hello(&socket).unwrap();
    assert!(!gone(left));
    client.send(&Request::Close { id: RequestId(1) }).unwrap();
    let (code, _) = holder.exit().unwrap();
    let ended = gone(left);
    kill_straggler(left, child);
    assert_eq!(code, Some(0));
    assert!(
        ended,
        "the holder exited with its child's job still running"
    );
}

#[test]
#[ignore = "signals processes; runs in pnpm test:real rust"]
fn binds_its_socket_again_on_sigusr1_and_unprompted() {
    bazhen_test_signal::require_sandbox().unwrap();
    sweep().unwrap();
    let home = home("rebind").unwrap();
    let (holder, socket) = serving(&home, &["sleep", "30"]).unwrap();
    std::fs::remove_file(&socket).unwrap();
    bazhen_test_signal::signal(holder.pid, Signal::USR1).unwrap();
    let signalled = Instant::now();
    connect_by(&socket, signalled + DEADLINE)
        .unwrap()
        .hello(false)
        .unwrap();
    assert!(signalled.elapsed() < bazhen_holder::socket::RECHECK_EVERY);
    std::fs::remove_file(&socket).unwrap();
    let removed = Instant::now();
    let unprompted = removed + bazhen_holder::socket::RECHECK_EVERY + DEADLINE;
    connect_by(&socket, unprompted)
        .unwrap()
        .hello(false)
        .unwrap();
}

/// How long a holder woken by `SIGUSR1` is left before it is looked at: well past the 2
/// CPU-seconds a test's holder gets, so one that spins on a wake-up it never drained dies of
/// `SIGXCPU` first. The time is what this measures, so it is waited out.
const IDLE_FOR: std::time::Duration = std::time::Duration::from_secs(5);

#[test]
#[ignore = "signals processes; runs in pnpm test:real rust"]
fn a_holder_woken_by_sigusr1_goes_idle_again() {
    bazhen_test_signal::require_sandbox().unwrap();
    sweep().unwrap();
    let home = home("woken").unwrap();
    let (mut holder, socket) = serving(&home, &["sleep", "30"]).unwrap();
    bazhen_test_signal::signal(holder.pid, Signal::USR1).unwrap();
    std::thread::sleep(IDLE_FOR);
    assert_eq!(holder.state(), "still runs");
    Client::connect(&socket).unwrap().hello(false).unwrap();
}

#[test]
#[ignore = "signals processes; runs in pnpm test:real rust"]
fn a_storm_of_sigusr1_during_a_flood_loses_no_output() {
    bazhen_test_signal::require_sandbox().unwrap();
    sweep().unwrap();
    let home = home("storm").unwrap();
    let flood: u64 = 20 << 20;
    let count = format!("-c{flood}");
    let (mut holder, socket) = serving_with(&home, &["head", &count, "/dev/zero"], &FLOOD).unwrap();
    for _ in 0..500 {
        bazhen_test_signal::signal(holder.pid, Signal::USR1).unwrap();
    }
    let hello = match exited_hello(&socket) {
        Ok(hello) => hello,
        Err(error) => panic!("{error}; {}", why(&mut holder, &socket)),
    };
    assert_eq!(hello.offset.get(), flood);
}

#[test]
#[ignore = "signals processes; runs in pnpm test:real rust"]
fn makes_room_for_a_new_connection_when_every_one_is_in_use() {
    bazhen_test_signal::require_sandbox().unwrap();
    sweep().unwrap();
    let home = home("full").unwrap();
    let (_holder, socket) = serving(&home, &["sleep", "30"]).unwrap();
    let mut silent: Vec<Client> = (0..bazhen_holder::server::MAX_CONNECTIONS)
        .map(|_| Client::connect(&socket).unwrap())
        .collect();
    past_grace();
    Client::connect(&socket).unwrap().hello(false).unwrap();
    assert!(
        silent.remove(0).hangs_up().unwrap(),
        "the oldest wasn't replaced"
    );
}

/// A request the holder always refuses, `stale-generation`, and that changes nothing: a subscribe
/// from a generation the holder hasn't reached.
fn refused_request(id: u32) -> Result<Request> {
    let from = SubscribeFrom {
        generation: Generation::new(1 << 20)?,
        offset: Offset::new(0)?,
    };
    Ok(Request::Subscribe {
        id: RequestId(id),
        body: SubscribeRequest { from: Some(from) },
    })
}

/// `count` requests the holder refuses, in one write.
fn refused_requests(count: u32) -> Vec<u8> {
    (1..=count)
        .flat_map(|id| {
            refused_request(id)
                .and_then(|request| Ok(request.encode()?))
                .unwrap_or_default()
        })
        .collect()
}

/// Waits out the grace that keeps a new connection from being replaced: connections opened
/// before this may then be. Nothing to wait on but the time.
fn past_grace() {
    std::thread::sleep(bazhen_holder::server::NEW_GRACE * 2);
}

/// Enough requests that their answers fill the holder's raised send buffer and the queue's mark
/// five times over, so the holder stops reading them and their peer is stuck, on any OS.
fn flood_of_requests() -> Result<u32> {
    let answers = 5 * (bazhen_holder::socket::SEND_BUFFER + bazhen_holder::conn::QUEUE_MARK);
    // Each answer is about 100 bytes; counting 90 errs towards more of them.
    Ok(u32::try_from(answers / 90)?)
}

/// Writes `count` requests to the holder from a thread, a thousand at a time, which a holder
/// that stops reading leaves blocked.
fn write_behind(client: &Client, count: u32) -> Result<std::thread::JoinHandle<()>> {
    let mut stream = client.stream.try_clone()?;
    Ok(std::thread::spawn(move || {
        for _ in 0..count.div_ceil(1000) {
            if stream.write_all(&refused_requests(1000)).is_err() {
                return;
            }
        }
    }))
}

#[test]
#[ignore = "signals processes; runs in pnpm test:real rust"]
fn a_request_whose_body_fails_is_answered_invalid_and_its_connection_hung_up() {
    bazhen_test_signal::require_sandbox().unwrap();
    sweep().unwrap();
    let home = home("bad-body").unwrap();
    let (_holder, socket) = serving(&home, &["sleep", "30"]).unwrap();
    let mut client = Client::connect(&socket).unwrap();
    client.hello(false).unwrap();
    // A subscribe, type 0x40, id 4, whose body isn't JSON.
    let frame = [&6u32.to_be_bytes()[..], &[0x40], &4u32.to_be_bytes(), b"{"].concat();
    client.stream.write_all(&frame).unwrap();
    match client.reply().unwrap() {
        Reply::Error { id, body } => {
            assert_eq!((id, body.code.as_str()), (RequestId(4), "invalid"));
        }
        other => panic!("answered {other:?}"),
    }
    assert!(client.hangs_up().unwrap());
    Client::connect(&socket).unwrap().hello(false).unwrap();
}

/// Out of fds, an accept fails; the holder pauses accepting for a second and then serves on,
/// idle, rather than spinning: under `ulimit -t 2` a spinning holder dies within the window.
#[test]
#[ignore = "signals processes; runs in pnpm test:real rust"]
fn a_failed_accept_pauses_accepting_and_leaves_the_holder_idle() {
    bazhen_test_signal::require_sandbox().unwrap();
    sweep().unwrap();
    let home = home("emfile").unwrap();
    let how = Start {
        prelude: "ulimit -n 20 &&",
        ..Start::default()
    };
    let mut holder = spawn(&spec(&home, &["sleep", "30"], |_| {}), &how).unwrap();
    assert_eq!(holder.first_line().unwrap(), "ready\n");
    let socket = home.join("t1.sock");
    let crowd: Vec<UnixStream> = (0..15)
        .map(|_| UnixStream::connect(&socket).unwrap())
        .collect();
    // Kept open meanwhile, so the holder stays out of descriptors with connections waiting: one
    // that retried at once instead of pausing would spin.
    let window = Instant::now() + std::time::Duration::from_secs(4);
    while Instant::now() < window {
        // The holder is only being watched here; there is nothing to wait on.
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    drop(crowd);
    assert!(
        start_time::of(holder.pid().unwrap()).is_ok(),
        "the holder died, of SIGXCPU if it spun"
    );
    Client::connect(&socket).unwrap().hello(false).unwrap();
}

/// A writer that pipelines requests, reads nothing and goes is dropped by a failed write, not
/// by its read; its slot must still be freed.
#[test]
#[ignore = "signals processes; runs in pnpm test:real rust"]
fn frees_the_writer_slot_of_a_connection_dropped_by_a_failed_write() {
    bazhen_test_signal::require_sandbox().unwrap();
    sweep().unwrap();
    let home = home("writer-gone").unwrap();
    let (_holder, socket) = serving(&home, &["sleep", "30"]).unwrap();
    let mut writer = Client::connect(&socket).unwrap();
    assert!(writer.hello(true).unwrap().writer);
    // Kept open as the writer goes: a reader that may still send must not keep the slot.
    let mut reader = Client::connect(&socket).unwrap();
    assert!(!reader.hello(false).unwrap().writer);
    writer.stream.write_all(&refused_requests(4000)).unwrap();
    drop(writer);
    let deadline = Instant::now() + DEADLINE;
    while !Client::connect(&socket)
        .unwrap()
        .hello(true)
        .unwrap()
        .writer
    {
        assert!(Instant::now() < deadline, "the slot was never freed");
    }
}

/// Requests read past the mark wait for their peer to read, and are then all answered, in order.
#[test]
#[ignore = "signals processes; runs in pnpm test:real rust"]
fn answers_every_pipelined_request_in_order_past_the_mark() {
    bazhen_test_signal::require_sandbox().unwrap();
    sweep().unwrap();
    let home = home("waited").unwrap();
    let (_holder, socket) = serving(&home, &["sleep", "30"]).unwrap();
    let mut client = Client::connect(&socket).unwrap();
    client.hello(false).unwrap();
    let count = 4000;
    client.stream.write_all(&refused_requests(count)).unwrap();
    for id in 1..=count {
        match client.reply().unwrap() {
            Reply::Error { id: got, .. } => assert_eq!(got, RequestId(id)),
            other => panic!("answered {other:?}"),
        }
    }
}

/// A closed holder keeps the terminal's lock until it exits, so no second holder starts a child
/// for the terminal while the first one's may still run.
#[test]
#[ignore = "signals processes; runs in pnpm test:real rust"]
fn a_closing_holder_keeps_the_terminal_until_its_child_has_ended() {
    bazhen_test_signal::require_sandbox().unwrap();
    sweep().unwrap();
    let home = home("closing").unwrap();
    let argv = ["sh", "-c", "trap '' HUP; echo armed; exec sleep 30"];
    let (mut holder, socket) = serving(&home, &argv).unwrap();
    // The child's output says its trap is set; a close before that would end it at once.
    let deadline = Instant::now() + DEADLINE;
    let mut client = loop {
        let mut client = Client::connect(&socket).unwrap();
        if client.hello(false).unwrap().offset.get() > 0 {
            break client;
        }
        assert!(Instant::now() < deadline, "the child never armed its trap");
    };
    client.send(&Request::Close { id: RequestId(1) }).unwrap();
    assert!(matches!(client.reply().unwrap(), Reply::Ok { .. }));
    let mut second = spawn(&spec(&home, &["sleep", "30"], |_| {}), &Start::default()).unwrap();
    assert_eq!(second.exit().unwrap().0, Some(7));
    assert_eq!(holder.exit().unwrap().0, Some(0));
}

/// With every connection open and reading, a new one still gets in: it replaces the oldest that
/// doesn't hold the writer slot, so no one can lock the daemon out.
#[test]
#[ignore = "signals processes; runs in pnpm test:real rust"]
fn a_full_holder_of_healthy_connections_still_takes_a_new_one() {
    bazhen_test_signal::require_sandbox().unwrap();
    sweep().unwrap();
    let home = home("healthy").unwrap();
    let (_holder, socket) = serving(&home, &["sleep", "30"]).unwrap();
    let mut open: Vec<Client> = (0..bazhen_holder::server::MAX_CONNECTIONS)
        .map(|n| {
            let mut client = Client::connect(&socket).unwrap();
            client.hello(n == 0).unwrap();
            client
        })
        .collect();
    past_grace();
    Client::connect(&socket).unwrap().hello(false).unwrap();
    let mut writer = open.remove(0);
    assert!(
        open.remove(0).hangs_up().unwrap(),
        "the oldest non-writer stayed"
    );
    let answer = writer.refused(&refused_request(9).unwrap()).unwrap();
    assert_eq!(answer.code, "stale-generation");
}

/// A spawner that left `SIGCHLD` and `SIGUSR1` blocked mustn't leave the holder deaf to either.
/// The child leaves the terminal held open as it exits, so only `SIGCHLD` can tell the holder.
#[test]
#[ignore = "signals processes; runs in pnpm test:real rust"]
fn hears_its_signals_though_the_spawner_blocked_them() {
    bazhen_test_signal::require_sandbox().unwrap();
    sweep().unwrap();
    let home = home("blocked").unwrap();
    let how = Start {
        blocked_signals: true,
        ..Start::default()
    };
    // It exits once the holder is idle in its loop, not before `Holder::new` can reap it, and
    // leaves behind a process that survives its hang-up and keeps the terminal open (on Linux;
    // macOS revokes the terminal as its leader exits, which wakes the holder anyway).
    let argv = [
        "sh",
        "-c",
        "(trap '' HUP; exec sleep 3) & sleep 0.3; exit 0",
    ];
    let mut holder = spawn(&spec(&home, &argv, |_| {}), &how).unwrap();
    assert_eq!(holder.first_line().unwrap(), "ready\n");
    let socket = home.join("t1.sock");
    // Nothing connects meanwhile: a turn of the loop would reap the child whatever the signals.
    std::thread::sleep(std::time::Duration::from_secs(1));
    let hello = Client::connect(&socket).unwrap().hello(false).unwrap();
    assert!(
        hello.exit.is_some(),
        "the exit waited for something to wake the holder"
    );
    std::fs::remove_file(&socket).unwrap();
    bazhen_test_signal::signal(holder.pid, Signal::USR1).unwrap();
    let signalled = Instant::now();
    connect_by(&socket, signalled + DEADLINE).unwrap();
    let quick = bazhen_holder::socket::RECHECK_EVERY / 2;
    assert!(
        signalled.elapsed() < quick,
        "the rebind waited for its timer"
    );
}

/// A newcomer to a full holder is safe for a moment, read or not, so the next one can't replace
/// it, whichever turns the two arrive in.
#[test]
#[ignore = "signals processes; runs in pnpm test:real rust"]
fn a_newcomer_is_safe_from_the_next_while_it_is_new() {
    bazhen_test_signal::require_sandbox().unwrap();
    sweep().unwrap();
    let home = home("newcomer").unwrap();
    let (_holder, socket) = serving(&home, &["sleep", "30"]).unwrap();
    let _open: Vec<Client> = (0..bazhen_holder::server::MAX_CONNECTIONS)
        .map(|n| {
            let mut client = Client::connect(&socket).unwrap();
            client.hello(n == 0).unwrap();
            client
        })
        .collect();
    past_grace();
    let mut first = Client::connect(&socket).unwrap();
    // The holder accepts `first` in a turn of its own before `second` arrives.
    std::thread::sleep(std::time::Duration::from_millis(100));
    let mut second = Client::connect(&socket).unwrap();
    assert!(
        first.hello(false).is_ok(),
        "the first newcomer was replaced"
    );
    assert!(second.hello(false).is_ok());
}

/// A peer that has left its buffer full for over a second is the one a newcomer replaces, ahead
/// of the oldest connection.
#[test]
#[ignore = "signals processes; runs in pnpm test:real rust"]
fn a_newcomer_replaces_the_peer_that_stopped_reading_first() {
    bazhen_test_signal::require_sandbox().unwrap();
    sweep().unwrap();
    let home = home("stuck").unwrap();
    let (_holder, socket) = serving(&home, &["sleep", "30"]).unwrap();
    let mut open: Vec<Client> = (0..bazhen_holder::server::MAX_CONNECTIONS)
        .map(|n| {
            let mut client = Client::connect(&socket).unwrap();
            client.hello(n == 0).unwrap();
            client
        })
        .collect();
    let mut stuck = open.remove(5);
    let writing = write_behind(&stuck, flood_of_requests().unwrap()).unwrap();
    // Being stuck is what the holder measures; there is nothing to wait on but the time.
    std::thread::sleep(bazhen_holder::server::STUCK_TO_EVICT * 3 / 2);
    assert!(
        !writing.is_finished(),
        "the holder read every request: its peer wasn't stuck"
    );
    Client::connect(&socket).unwrap().hello(false).unwrap();
    let mut oldest = open.remove(1);
    let answer = oldest.refused(&refused_request(9).unwrap()).unwrap();
    assert_eq!(answer.code, "stale-generation");
    // Dropped, it ends in a reset or an end of stream, with its writer let go; kept, its reads
    // would only time out.
    loop {
        match stuck.next() {
            Ok(Some(reply)) => assert!(matches!(reply, Reply::Error { .. }), "sent {reply:?}"),
            Ok(None) => break,
            Err(error) => match error.downcast::<std::io::Error>() {
                Ok(io) if io.kind() == std::io::ErrorKind::ConnectionReset => break,
                Ok(io) => panic!("the stuck connection wasn't dropped: {io}"),
                Err(other) => panic!("the stuck connection sent something else: {other}"),
            },
        }
    }
    writing.join().unwrap();
}

/// A connection that never reads what it is owed holds up a close for a second at most.
#[test]
#[ignore = "signals processes; runs in pnpm test:real rust"]
fn a_close_waits_for_a_reader_that_never_reads_for_a_second_at_most() {
    bazhen_test_signal::require_sandbox().unwrap();
    sweep().unwrap();
    let home = home("flush").unwrap();
    let (mut holder, socket) = serving(&home, &["sleep", "30"]).unwrap();
    let mut stuck = Client::connect(&socket).unwrap();
    stuck.hello(false).unwrap();
    let writing = write_behind(&stuck, flood_of_requests().unwrap()).unwrap();
    // The holder stops reading the requests once their answers fill the buffer and the queue,
    // which leaves the writer blocked: proof the peer is stuck. Nothing to wait on but the time.
    std::thread::sleep(std::time::Duration::from_millis(500));
    assert!(
        !writing.is_finished(),
        "the holder read every request: its peer wasn't stuck"
    );
    let mut closer = Client::connect(&socket).unwrap();
    closer.hello(false).unwrap();
    closer.send(&Request::Close { id: RequestId(1) }).unwrap();
    let asked = Instant::now();
    assert_eq!(holder.exit().unwrap().0, Some(0));
    assert!(
        asked.elapsed() < std::time::Duration::from_secs(3),
        "the close waited {:?}",
        asked.elapsed()
    );
    drop(stuck);
    writing.join().unwrap();
}

impl Client {
    fn subscribe(&mut self, from: Option<(u64, u64)>) -> Result<Reply> {
        let id = self.id();
        let from = match from {
            Some((generation, offset)) => Some(bazhen_holder_proto::body::SubscribeFrom {
                generation: bazhen_holder_proto::body::Generation::new(generation)?,
                offset: bazhen_holder_proto::body::Offset::new(offset)?,
            }),
            None => None,
        };
        let body = bazhen_holder_proto::body::SubscribeRequest { from };
        self.send(&Request::Subscribe { id, body })?;
        self.reply()
    }

    /// The output and gaps sent until `exited`, which must come, keeping the output only if
    /// `keep`: a flood's is counted, and checked to be all zeros, instead.
    fn stream_to_exit_keeping(&mut self, keep: bool) -> Result<Stream> {
        self.stream_on_to_exit(
            Stream {
                zeros: true,
                ..Stream::default()
            },
            keep,
        )
    }

    /// As `stream_to_exit_keeping`, keeping the output, on from the output in `seen`, already
    /// read from offset 0.
    fn stream_to_exit_after(&mut self, seen: Vec<u8>) -> Result<Stream> {
        let end = seen.len() as u64;
        let stream = Stream {
            bytes: seen,
            end,
            zeros: true,
            ..Stream::default()
        };
        self.stream_on_to_exit(stream, true)
    }

    fn stream_on_to_exit(&mut self, mut stream: Stream, keep: bool) -> Result<Stream> {
        loop {
            match self.reply()? {
                Reply::Data { offset, bytes } => {
                    if offset.get() != stream.end {
                        return Err(
                            format!("data at {}, after {}", offset.get(), stream.end).into()
                        );
                    }
                    stream.end += bytes.len() as u64;
                    stream.received += bytes.len() as u64;
                    stream.zeros &= bytes.iter().all(|&b| b == 0);
                    if keep {
                        stream.bytes.extend_from_slice(&bytes);
                    }
                }
                Reply::Gap(gap) => {
                    if gap.from.get() != stream.end {
                        return Err(
                            format!("a gap from {}, after {}", gap.from.get(), stream.end).into(),
                        );
                    }
                    stream.gaps.push((gap.from.get(), gap.to.get()));
                    stream.end = gap.to.get();
                }
                Reply::Exited(_) => return Ok(stream),
                other => return Err(format!("sent {other:?}").into()),
            }
        }
    }
}

/// What a subscriber was sent: its output, the gaps in it, and the offset it reached.
#[derive(Debug, Default)]
struct Stream {
    bytes: Vec<u8>,
    received: u64,
    zeros: bool,
    gaps: Vec<(u64, u64)>,
    end: u64,
}

fn is_ok(reply: &Reply) -> bool {
    matches!(reply, Reply::Ok { body, .. } if body.request == "subscribe")
}

#[test]
#[ignore = "signals processes; runs in pnpm test:real rust"]
fn streams_every_byte_of_the_childs_output_in_order_then_its_exit() {
    bazhen_test_signal::require_sandbox().unwrap();
    sweep().unwrap();
    let home = home("seq").unwrap();
    // With `-onlcr` the terminal passes each newline on as it is: a BSD one whose output queue
    // fills between the carriage return it adds and the newline writes the carriage return again.
    // It waits to be told, once its terminal no longer echoes, so it can't exit, and its
    // `exited` go out, before the subscription.
    let script = "stty -onlcr -echo && echo R && read _ && seq 1 20000";
    let (_holder, socket) = serving(&home, &["sh", "-c", script]).unwrap();
    let mut client = Client::connect(&socket).unwrap();
    let seen = client.writer_after("R\n").unwrap();
    client.input(b"\n").unwrap();
    let stream = client.stream_to_exit_after(seen).unwrap();
    let expected: Vec<String> = (1..=20000).map(|n| n.to_string()).collect();
    let expected = "R\n".to_owned() + &expected.join("\n") + "\n";
    assert_eq!(stream.gaps, []);
    assert_eq!(String::from_utf8(stream.bytes).unwrap(), expected);
}

#[test]
#[ignore = "signals processes; runs in pnpm test:real rust"]
fn a_subscription_from_output_the_ring_dropped_gets_a_gap_then_the_rest() {
    bazhen_test_signal::require_sandbox().unwrap();
    sweep().unwrap();
    let home = home("dropped").unwrap();
    let flood: u64 = 3_000_000;
    let count = format!("-c{flood}");
    let (mut holder, socket) = serving(&home, &["head", &count, "/dev/zero"]).unwrap();
    if let Err(error) = exited_hello(&socket) {
        panic!("{error}; {}", why(&mut holder, &socket));
    }
    let mut client = Client::connect(&socket).unwrap();
    client.hello(false).unwrap();
    assert!(is_ok(&client.subscribe(Some((0, 0))).unwrap()));
    let held = bazhen_holder::ring::RING_BYTES as u64;
    match client.reply().unwrap() {
        Reply::Gap(gap) => assert_eq!((gap.from.get(), gap.to.get()), (0, flood - held)),
        other => panic!("sent {other:?}"),
    }
    let mut received = 0;
    while received < held {
        let Reply::Data { bytes, .. } = client.reply().unwrap() else {
            panic!("not output");
        };
        received += bytes.len() as u64;
    }
    assert_eq!(received, held);
}

#[test]
#[ignore = "signals processes; runs in pnpm test:real rust"]
fn refuses_a_subscription_from_another_generation_or_past_its_output() {
    bazhen_test_signal::require_sandbox().unwrap();
    sweep().unwrap();
    let home = home("refused").unwrap();
    let (_holder, socket) = serving(&home, &["sleep", "30"]).unwrap();
    let mut client = Client::connect(&socket).unwrap();
    let end = client.hello(false).unwrap().offset.get();
    for (from, code) in [((1, 0), "stale-generation"), ((0, end + 1), "out-of-range")] {
        match client.subscribe(Some(from)).unwrap() {
            Reply::Error { body, .. } => assert_eq!(body.code, code),
            other => panic!("answered {other:?}"),
        }
    }
    assert!(is_ok(&client.subscribe(Some((0, end))).unwrap()));
}

/// A subscriber to a flood is sent all of it, in order, with any output the ring dropped before it
/// was read standing as a gap: nothing is lost unaccounted for, whatever the rates. This runs on
/// macOS too, where a socket's buffer starts at 8 KiB.
#[test]
#[ignore = "signals processes; runs in pnpm test:real rust"]
fn a_subscriber_to_a_flood_is_sent_all_of_it_in_order_or_told_of_a_gap() {
    bazhen_test_signal::require_sandbox().unwrap();
    sweep().unwrap();
    let home = home("keepup").unwrap();
    let flood: u64 = 50_000_000;
    let script = format!("sleep 1; head -c {flood} /dev/zero");
    let (mut holder, socket) = serving_with(&home, &["sh", "-c", &script], &FLOOD).unwrap();
    let mut client = Client::connect(&socket).unwrap();
    client.hello(false).unwrap();
    assert!(is_ok(&client.subscribe(Some((0, 0))).unwrap()));
    let stream = match client.stream_to_exit_keeping(false) {
        Ok(stream) => stream,
        Err(error) => panic!("{error}; {}", why(&mut holder, &socket)),
    };
    assert_eq!(stream.end, flood);
    let dropped: u64 = stream.gaps.iter().map(|(from, to)| to - from).sum();
    assert_eq!(stream.received + dropped, flood);
    // After the last gap, everything the ring held must have come.
    let held = bazhen_holder::ring::RING_BYTES as u64;
    assert!(
        stream.received >= flood.min(held),
        "{} received",
        stream.received
    );
    assert!(stream.zeros);
}

/// The holder never stops reading the child for a subscriber that has stopped reading: another
/// connection sees the flood end, and the stalled one, once it reads again, gets a gap.
#[test]
#[ignore = "signals processes; runs in pnpm test:real rust"]
fn a_subscriber_that_stops_reading_holds_up_neither_the_child_nor_anyone_else() {
    bazhen_test_signal::require_sandbox().unwrap();
    sweep().unwrap();
    let home = home("stalled").unwrap();
    let flood: u64 = 8_000_000;
    let script = format!("sleep 0.5; head -c {flood} /dev/zero");
    let (mut holder, socket) = serving_with(&home, &["sh", "-c", &script], &FLOOD).unwrap();
    let mut stalled = Client::connect(&socket).unwrap();
    stalled.hello(false).unwrap();
    assert!(is_ok(&stalled.subscribe(Some((0, 0))).unwrap()));
    let hello = match exited_hello(&socket) {
        Ok(hello) => hello,
        Err(error) => panic!(
            "the child was held up: {error}; {}",
            why(&mut holder, &socket)
        ),
    };
    assert_eq!(hello.offset.get(), flood);
    let stream = match stalled.stream_to_exit_keeping(false) {
        Ok(stream) => stream,
        Err(error) => panic!("{error}; {}", why(&mut holder, &socket)),
    };
    assert!(
        !stream.gaps.is_empty(),
        "no gap for a subscriber the ring lapped"
    );
    assert_eq!(stream.end, flood);
}
