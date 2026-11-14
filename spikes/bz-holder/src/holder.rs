use std::collections::BTreeMap;
use std::fs::File;
use std::io::{self, ErrorKind, Read as _, Write as _};
use std::os::fd::AsFd;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::process::{Child, Command};
use std::time::{Duration, Instant};

use rustix::event::{PollFd, PollFlags, Timespec, poll};
use rustix::process::{Pid, Signal, WaitOptions, kill_process_group, waitpid};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::engine::Engine;
use crate::frame::{self, Decoded, kind};
use crate::pty::{Pty, Size};
use crate::ring::{Read, Ring};

const READ_CHUNK: usize = 64 * 1024;
const MAX_READ_PER_TURN: usize = 1 << 20;
const MAX_INPUT_QUEUE: usize = 1 << 20;
const CLOSE_GRACE: Duration = Duration::from_secs(2);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Spec {
    pub(crate) id: String,
    pub(crate) argv: Vec<String>,
    #[serde(default)]
    pub(crate) cwd: Option<PathBuf>,
    #[serde(default)]
    pub(crate) env: BTreeMap<String, String>,
    pub(crate) cols: u16,
    pub(crate) rows: u16,
    #[serde(default = "default_history")]
    pub(crate) history_lines: usize,
    #[serde(default = "default_ring")]
    pub(crate) ring_bytes: usize,
    pub(crate) socket: PathBuf,
}

fn default_history() -> usize {
    10_000
}

fn default_ring() -> usize {
    8 << 20
}

#[derive(Debug, Clone, Copy, Serialize)]
struct Exit {
    code: Option<i32>,
    signal: Option<i32>,
}

#[derive(Debug)]
struct Client {
    stream: UnixStream,
    inbound: Vec<u8>,
    outbound: Vec<u8>,
    sent: usize,
    subscribed: Option<u64>,
    told_exit: bool,
    dead: bool,
}

impl Client {
    fn wants_write(&self, ring_end: u64) -> bool {
        self.sent < self.outbound.len() || self.subscribed.is_some_and(|at| at < ring_end)
    }
}

#[derive(Debug)]
pub(crate) struct Holder {
    spec: Spec,
    size: Size,
    pty: Pty,
    master: File,
    master_open: bool,
    child: Child,
    child_pid: Option<Pid>,
    exit: Option<Exit>,
    ring: Ring,
    engine: Engine,
    listener: UnixListener,
    signals: UnixStream,
    clients: Vec<Client>,
    to_master: Vec<u8>,
    closing: Option<Instant>,
    killed: bool,
}

impl Holder {
    pub(crate) fn start(spec: Spec, listener: UnixListener) -> io::Result<Self> {
        let size = Size::clamped(spec.cols, spec.rows);
        let pty = Pty::open(size)?;
        let (program, args) = spec
            .argv
            .split_first()
            .ok_or_else(|| io::Error::new(ErrorKind::InvalidInput, "argv is empty"))?;
        let mut command = Command::new(program);
        command
            .args(args)
            .env("TERM", "xterm-256color")
            .envs(&spec.env);
        if let Some(cwd) = &spec.cwd {
            command.current_dir(cwd);
        }
        let (signals, sender) = UnixStream::pair()?;
        signals.set_nonblocking(true)?;
        signal_hook::low_level::pipe::register(signal_hook::consts::SIGCHLD, sender)?;
        let child = pty.spawn(&mut command)?;
        let child_pid = Pid::from_child(&child);
        let master = File::from(pty.master.try_clone()?);
        listener.set_nonblocking(true)?;
        Ok(Self {
            engine: Engine::new(size, spec.history_lines),
            ring: Ring::new(spec.ring_bytes),
            spec,
            size,
            pty,
            master,
            master_open: true,
            child,
            child_pid: Some(child_pid),
            exit: None,
            listener,
            signals,
            clients: Vec::new(),
            to_master: Vec::new(),
            closing: None,
            killed: false,
        })
    }

    pub(crate) fn run(mut self) -> io::Result<()> {
        loop {
            if self.closing.is_some() && self.close_step() {
                let _ = std::fs::remove_file(&self.spec.socket);
                return Ok(());
            }
            let revents = self.wait()?;
            let mut events = revents.into_iter();
            let mut next = || events.next().unwrap_or_else(PollFlags::empty);
            if !next().is_empty() {
                self.reap();
            }
            if !next().is_empty() {
                self.accept();
            }
            let master = next();
            if master.intersects(PollFlags::IN | PollFlags::HUP | PollFlags::ERR) {
                self.read_master();
            }
            self.write_master();
            for index in 0..self.clients.len() {
                let flags = next();
                if flags.intersects(PollFlags::IN | PollFlags::HUP | PollFlags::ERR) {
                    self.read_client(index);
                }
            }
            self.pump();
            self.write_master();
            self.clients.retain(|c| !c.dead);
        }
    }

    /// Blocks until something is ready. Returns one entry per fd, in the order `run` reads them.
    fn wait(&self) -> io::Result<Vec<PollFlags>> {
        let ring_end = self.ring.end();
        let mut master_flags = PollFlags::empty();
        if self.master_open {
            master_flags |= PollFlags::IN;
            if !self.to_master.is_empty() {
                master_flags |= PollFlags::OUT;
            }
        }
        let mut fds: Vec<PollFd<'_>> = vec![
            PollFd::new(&self.signals, PollFlags::IN),
            PollFd::new(&self.listener, PollFlags::IN),
            PollFd::from_borrowed_fd(
                if self.master_open {
                    self.master.as_fd()
                } else {
                    self.signals.as_fd()
                },
                master_flags,
            ),
        ];
        for client in &self.clients {
            let mut flags = PollFlags::IN;
            if client.wants_write(ring_end) {
                flags |= PollFlags::OUT;
            }
            fds.push(PollFd::new(&client.stream, flags));
        }
        let timeout = Timespec {
            tv_sec: 0,
            tv_nsec: 200_000_000,
        };
        match poll(&mut fds, Some(&timeout)) {
            Ok(_) => {}
            Err(rustix::io::Errno::INTR) => return Ok(vec![PollFlags::IN]),
            Err(e) => return Err(e.into()),
        }
        let mut out: Vec<PollFlags> = fds.iter().map(PollFd::revents).collect();
        if let Some(writable) = out.get_mut(2)
            && !self.master_open
        {
            *writable = PollFlags::empty();
        }
        // Client writes are driven by pump, whatever poll says.
        for flags in out.iter_mut().skip(3) {
            flags.remove(PollFlags::OUT);
        }
        Ok(out)
    }

    fn reap(&mut self) {
        let mut drain = [0u8; 64];
        while matches!((&self.signals).read(&mut drain), Ok(n) if n > 0) {}
        let Some(pid) = self.child_pid else { return };
        if let Ok(Some((_, status))) = waitpid(Some(pid), WaitOptions::NOHANG) {
            self.child_pid = None;
            let exit = Exit {
                code: status.exit_status(),
                signal: status.terminating_signal(),
            };
            self.exit = Some(exit);
            let _ = self.child.try_wait();
            log(&format!("child exited: {exit:?}"));
        }
    }

    fn accept(&mut self) {
        loop {
            match self.listener.accept() {
                Ok((stream, _)) => {
                    if stream.set_nonblocking(true).is_err() {
                        continue;
                    }
                    self.clients.push(Client {
                        stream,
                        inbound: Vec::new(),
                        outbound: Vec::new(),
                        sent: 0,
                        subscribed: None,
                        told_exit: false,
                        dead: false,
                    });
                }
                Err(e) if e.kind() == ErrorKind::WouldBlock => return,
                Err(e) if e.kind() == ErrorKind::Interrupted => {}
                Err(e) => {
                    log(&format!("accept: {e}"));
                    return;
                }
            }
        }
    }

    fn read_master(&mut self) {
        let mut buf = vec![0u8; READ_CHUNK];
        let mut total = 0;
        while total < MAX_READ_PER_TURN {
            match (&self.master).read(&mut buf) {
                Ok(0) => {
                    self.master_open = false;
                    break;
                }
                Ok(n) => {
                    let bytes = buf.get(..n).unwrap_or_default();
                    total += n;
                    self.ring.push(bytes);
                    if !self.engine.advance(bytes) {
                        log("engine panicked and was reset");
                    }
                    let replies = self.engine.take_replies();
                    self.to_master.extend_from_slice(&replies);
                }
                Err(e) if e.kind() == ErrorKind::WouldBlock => break,
                Err(e) if e.kind() == ErrorKind::Interrupted => {}
                Err(_) => {
                    // EIO once every slave is closed (Linux), or 0 (macOS): the output is over,
                    // the holder is not.
                    self.master_open = false;
                    break;
                }
            }
        }
    }

    fn write_master(&mut self) {
        while self.master_open && !self.to_master.is_empty() {
            match (&self.master).write(&self.to_master) {
                Ok(n) => {
                    self.to_master.drain(..n);
                }
                Err(e) if e.kind() == ErrorKind::Interrupted => {}
                Err(_) => break,
            }
        }
    }

    fn read_client(&mut self, index: usize) {
        let mut buf = [0u8; 16 * 1024];
        let Some(client) = self.clients.get_mut(index) else {
            return;
        };
        loop {
            match client.stream.read(&mut buf) {
                Ok(0) => {
                    client.dead = true;
                    break;
                }
                Ok(n) => client
                    .inbound
                    .extend_from_slice(buf.get(..n).unwrap_or_default()),
                Err(e) if e.kind() == ErrorKind::WouldBlock => break,
                Err(e) if e.kind() == ErrorKind::Interrupted => {}
                Err(_) => {
                    client.dead = true;
                    break;
                }
            }
        }
        let inbound = std::mem::take(&mut client.inbound);
        let mut at = 0;
        loop {
            match frame::decode(inbound.get(at..).unwrap_or_default(), frame::MAX_INBOUND) {
                Decoded::Frame {
                    kind,
                    payload,
                    consumed,
                } => {
                    at += consumed;
                    self.handle(index, kind, payload);
                }
                Decoded::Incomplete => break,
                Decoded::Invalid(why) => {
                    log(&format!("client sent a malformed frame: {why}"));
                    if let Some(client) = self.clients.get_mut(index) {
                        client.dead = true;
                    }
                    return;
                }
            }
        }
        if let Some(client) = self.clients.get_mut(index) {
            client.inbound = inbound.get(at..).unwrap_or_default().to_vec();
        }
    }

    fn handle(&mut self, index: usize, frame_kind: u8, payload: &[u8]) {
        let mut reply = Vec::new();
        match frame_kind {
            kind::HELLO => {
                let hello = json!({
                    "protocol": "bz-spike/0",
                    "terminalId": self.spec.id,
                    "holderPid": std::process::id(),
                    "childPid": self.child.id(),
                    "exit": self.exit,
                    "cols": self.size.cols,
                    "rows": self.size.rows,
                    "offset": self.ring.end(),
                    "ringStart": self.ring.start(),
                    "title": self.engine.title(),
                    "alternate": self.engine.alternate(),
                });
                frame::encode(&mut reply, kind::R_HELLO, &[hello.to_string().as_bytes()]);
            }
            kind::SNAPSHOT => {
                let vt = self.engine.snapshot();
                frame::encode_at(&mut reply, kind::R_SNAPSHOT, self.ring.end(), &vt);
            }
            // With no offset, from the ring's end now: sent with a snapshot in one write, that is
            // the snapshot's offset, so the two meet exactly.
            kind::SUBSCRIBE => match frame::decode_u64(payload)
                .or_else(|| payload.is_empty().then(|| self.ring.end()))
            {
                Some(from) if from <= self.ring.end() => {
                    if let Some(client) = self.clients.get_mut(index) {
                        client.subscribed = Some(from);
                    }
                }
                _ => error(
                    &mut reply,
                    "subscribe needs an offset no later than the ring's end",
                ),
            },
            kind::INPUT => {
                if self.to_master.len() + payload.len() > MAX_INPUT_QUEUE {
                    error(&mut reply, "input queue full: the program is not reading");
                } else {
                    self.to_master.extend_from_slice(payload);
                }
            }
            kind::RESIZE => match serde_json::from_slice::<serde_json::Value>(payload) {
                Ok(v) => {
                    let get = |k: &str| v.get(k).and_then(serde_json::Value::as_u64);
                    let to_u16 =
                        |n: Option<u64>| n.and_then(|n| u16::try_from(n).ok()).unwrap_or(0);
                    let size = Size::clamped(to_u16(get("cols")), to_u16(get("rows")));
                    if size != self.size {
                        self.size = size;
                        self.engine.resize(size);
                        if let Err(e) = self.pty.resize(size) {
                            log(&format!("resize: {e}"));
                        }
                    }
                }
                Err(_) => error(&mut reply, "resize needs {cols, rows}"),
            },
            kind::STATS => {
                let stats = json!({
                    "rss": rss_bytes(),
                    "engineBytes": self.engine.engine_bytes(),
                    "ringBytes": self.ring.len(),
                    "historyLines": self.engine.history_lines(),
                    "offset": self.ring.end(),
                    "engineResets": self.engine.resets(),
                    "clients": self.clients.len(),
                });
                frame::encode(&mut reply, kind::R_STATS, &[stats.to_string().as_bytes()]);
            }
            kind::CLOSE => {
                if self.closing.is_none() {
                    self.closing = Some(Instant::now());
                    if let Some(pid) = self.child_pid {
                        let _ = kill_process_group(pid, Signal::HUP);
                    }
                }
            }
            _ => error(&mut reply, "unknown frame kind"),
        }
        if let Some(client) = self.clients.get_mut(index) {
            client.outbound.extend_from_slice(&reply);
        }
    }

    /// Moves bytes toward every client: queued replies first, then each subscriber's next slice
    /// of the ring. A subscriber that can't keep up falls behind in the ring, never in memory;
    /// once the ring drops what it hasn't read, it is sent a gap.
    fn pump(&mut self) {
        let exit = self.exit;
        for client in &mut self.clients {
            if client.dead {
                continue;
            }
            loop {
                if client.sent < client.outbound.len() {
                    let pending = client.outbound.get(client.sent..).unwrap_or_default();
                    match client.stream.write(pending) {
                        Ok(n) => client.sent += n,
                        Err(e) if e.kind() == ErrorKind::WouldBlock => break,
                        Err(e) if e.kind() == ErrorKind::Interrupted => continue,
                        Err(_) => {
                            client.dead = true;
                            break;
                        }
                    }
                    continue;
                }
                client.outbound.clear();
                client.sent = 0;
                let Some(at) = client.subscribed else { break };
                match self.ring.read(at, READ_CHUNK) {
                    Read::Bytes(bytes) => {
                        frame::encode_at(&mut client.outbound, kind::R_DATA, at, &bytes);
                        client.subscribed = Some(at + bytes.len() as u64);
                    }
                    Read::Gap { to } => {
                        frame::encode(
                            &mut client.outbound,
                            kind::R_GAP,
                            &[&at.to_be_bytes(), &to.to_be_bytes()],
                        );
                        client.subscribed = Some(to);
                    }
                    Read::UpToDate | Read::Ahead => {
                        if let Some(exit) = exit.filter(|_| !client.told_exit && !self.master_open)
                        {
                            client.told_exit = true;
                            let body = serde_json::to_string(&exit).unwrap_or_default();
                            frame::encode(&mut client.outbound, kind::R_EXITED, &[body.as_bytes()]);
                            continue;
                        }
                        break;
                    }
                }
            }
        }
    }

    /// Returns true once the child is gone and the holder may exit.
    fn close_step(&mut self) -> bool {
        self.reap();
        if self.child_pid.is_none() {
            return true;
        }
        let started = self.closing.unwrap_or_else(Instant::now);
        if !self.killed && started.elapsed() > CLOSE_GRACE {
            if let Some(pid) = self.child_pid {
                let _ = kill_process_group(pid, Signal::KILL);
            }
            self.killed = true;
        }
        false
    }
}

fn error(out: &mut Vec<u8>, message: &str) {
    let body = json!({ "error": message }).to_string();
    frame::encode(out, kind::R_ERROR, &[body.as_bytes()]);
}

pub(crate) fn log(message: &str) {
    let _ = writeln!(io::stderr(), "{message}");
}

fn rss_bytes() -> Option<u64> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    let line = status.lines().find(|l| l.starts_with("VmRSS:"))?;
    let kb: u64 = line.split_whitespace().nth(1)?.parse().ok()?;
    Some(kb * 1024)
}
