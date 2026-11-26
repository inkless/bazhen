//! Who is at the other end of a loopback TCP connection, which carries no peer credentials: the
//! processes that hold the caller's socket. Linux's `/proc/net/tcp` and `tcp6` say which socket
//! is the caller's end, and each process's `/proc/<pid>/fd` which sockets it holds. Each holder is
//! then read as `of_pid` reads a Unix socket's peer.
//!
//! A holder of the socket is found only among this user's processes whose descriptors can be read.
//! One the scan can't read is kept as a candidate, by its pid and its start, not guessed at: with
//! no readable holder the caller is refused unless every candidate reads as the human, and with
//! one, an unreadable process can hold the socket only by inheriting it from a holder, which keeps
//! it on that holder's line, or by being handed it by one that cooperates. A process holding an
//! `io_uring` is a candidate too, since it may hold a socket in its ring with no descriptor left.

use std::collections::{BTreeMap, BTreeSet};
use std::io;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

use rustix::process::Pid;

use bazhen_holder::start_time;

use crate::{MAX_HOLDERS, Peer, Refused};

/// The kernel's `TCP_TIME_WAIT`: a closed connection's leftover, which no process holds.
pub const TIME_WAIT: u8 = 0x06;

/// One socket as a `/proc/net/tcp` or `tcp6` line lists it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Row {
    pub local: SocketAddr,
    pub remote: SocketAddr,
    pub state: u8,
    pub uid: u32,
    /// 0 for a socket no process holds any more.
    pub inode: u64,
}

impl Row {
    /// Whether a process may hold it.
    fn live(&self) -> bool {
        self.state != TIME_WAIT && self.inode != 0
    }
}

/// One line of `/proc/net/tcp` or `tcp6`, or `None` for the heading or anything else that isn't a
/// socket's line. Each address is the kernel's `%08X` of each 32-bit word of it as the host stores
/// it, so its bytes are each word's in native order, then `:` and the port in hex.
pub fn row(line: &str) -> Option<Row> {
    let mut fields = line.split_ascii_whitespace();
    let slot = fields.next()?;
    slot.strip_suffix(':')?.parse::<u32>().ok()?;
    let local = address(fields.next()?)?;
    let remote = address(fields.next()?)?;
    let state = hex_exact(fields.next()?, 2).and_then(|s| u8::try_from(s).ok())?;
    // tx_queue:rx_queue, tr:tm->when, retrnsmt
    let mut fields = fields.skip(3);
    let uid = decimal(fields.next()?)?;
    let _timeout = fields.next()?;
    let inode = decimal(fields.next()?)?;
    Some(Row {
        local,
        remote,
        state,
        uid,
        inode,
    })
}

fn decimal<T: std::str::FromStr>(text: &str) -> Option<T> {
    text.bytes()
        .all(|b| b.is_ascii_digit())
        .then(|| text.parse().ok())
        .flatten()
}

/// `text` as hex of exactly `digits` digits.
fn hex_exact(text: &str, digits: usize) -> Option<u32> {
    (text.len() == digits && text.bytes().all(|b| b.is_ascii_hexdigit()))
        .then(|| u32::from_str_radix(text, 16).ok())
        .flatten()
}

fn address(text: &str) -> Option<SocketAddr> {
    let (host, port) = text.split_once(':')?;
    let port = u16::try_from(hex_exact(port, 4)?).ok()?;
    let mut bytes = [0u8; 16];
    let words = host.len() / 8;
    if host.len() % 8 != 0 || !matches!(words, 1 | 4) {
        return None;
    }
    for (at, chunk) in bytes
        .as_chunks_mut::<4>()
        .0
        .iter_mut()
        .take(words)
        .enumerate()
    {
        let word = host.get(at * 8..at * 8 + 8)?;
        *chunk = hex_exact(word, 8)?.to_ne_bytes();
    }
    let ip = match (words, bytes) {
        (1, [a, b, c, d, ..]) => IpAddr::V4(Ipv4Addr::new(a, b, c, d)),
        _ => IpAddr::V6(Ipv6Addr::from(bytes)),
    };
    Some(SocketAddr::new(ip, port))
}

/// `address` with an IPv4-mapped IPv6 address as the IPv4 address it maps, as a dual-stack socket
/// connected to an IPv4 listener is listed in `tcp6`.
fn unmapped(address: SocketAddr) -> SocketAddr {
    match address.ip() {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map_or(address, |v4| {
            SocketAddr::new(IpAddr::V4(v4), address.port())
        }),
        IpAddr::V4(_) => address,
    }
}

/// What the tables say of the caller's end of a connection the daemon accepted from `client` on
/// `server`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum End {
    /// The one socket a process may hold: its owner and inode.
    Live { uid: u32, inode: u64 },
    /// None a process holds: the caller has closed it, or it isn't on this host's loopback.
    Gone,
    /// More than one: the tables were read while they changed, or don't say which.
    Ambiguous,
}

/// The caller's end among `rows`, from every table: each row whose local address is `client` and
/// whose remote is `server`, either written as IPv4 or as IPv4-mapped IPv6. A row in `TIME_WAIT`
/// or of inode 0 is a leftover no process holds, and doesn't count.
pub fn end_of(rows: impl IntoIterator<Item = Row>, client: SocketAddr, server: SocketAddr) -> End {
    let (client, server) = (unmapped(client), unmapped(server));
    let mut live = rows.into_iter().filter(|row| {
        row.live() && unmapped(row.local) == client && unmapped(row.remote) == server
    });
    match (live.next(), live.next()) {
        (None, _) => End::Gone,
        (Some(row), None) => End::Live {
            uid: row.uid,
            inode: row.inode,
        },
        (Some(_), Some(_)) => End::Ambiguous,
    }
}

/// The socket inode a descriptor's `/proc/<pid>/fd/<n>` link names, `socket:[<inode>]`, or `None`
/// for a descriptor of anything else.
pub fn socket_inode(link: &[u8]) -> Option<u64> {
    let inode = link.strip_prefix(b"socket:[")?.strip_suffix(b"]")?;
    decimal(std::str::from_utf8(inode).ok()?)
}

/// What the lookup reads of `/proc`, so a test can stand in for it.
pub trait ProcView {
    /// The text of `/proc/net/tcp`, then `tcp6`.
    ///
    /// # Errors
    ///
    /// When a table can't be read.
    fn tables(&self) -> io::Result<Vec<String>>;
    /// This user's processes.
    ///
    /// # Errors
    ///
    /// When `/proc` can't be listed.
    fn processes(&self) -> io::Result<Vec<Pid>>;
    /// Each of `pid`'s descriptors with what its link reads; `NotFound` for a process that has
    /// gone.
    ///
    /// # Errors
    ///
    /// When `pid`'s descriptors can't be listed.
    fn descriptors(&self, pid: Pid) -> io::Result<Vec<(u32, Vec<u8>)>>;
    /// What `pid`'s descriptor `fd` reads now.
    ///
    /// # Errors
    ///
    /// When it can't be read, or is closed.
    fn descriptor(&self, pid: Pid, fd: u32) -> io::Result<Vec<u8>>;
    /// `pid`'s `/proc/<pid>/stat` line, which the kernel shows even for a process whose
    /// descriptors it hides.
    ///
    /// # Errors
    ///
    /// When it can't be read; `NotFound` for a process that has gone.
    fn stat(&self, pid: Pid) -> io::Result<Vec<u8>>;
    /// The threads `/proc/<pid>/task` lists of `pid`.
    ///
    /// # Errors
    ///
    /// When they can't be listed.
    fn tasks(&self, pid: Pid) -> io::Result<Vec<Pid>>;
}

/// The inode of the caller's end of a connection the daemon accepted from `client` on `server`, as
/// `view`'s tables list it, owned by `uid`.
///
/// # Errors
///
/// `NoEnd`, `Ambiguous`, `Foreign` for a socket of another user, `Unreadable` for a table.
pub fn end(
    view: &(impl ProcView + ?Sized),
    client: SocketAddr,
    server: SocketAddr,
    uid: u32,
) -> Result<u64, Refused> {
    let tables = view.tables()?;
    let rows = tables
        .iter()
        .flat_map(|table| table.lines())
        .filter_map(row);
    match end_of(rows, client, server) {
        End::Live { uid: theirs, .. } if theirs != uid => Err(Refused::Foreign { uid: theirs }),
        End::Live { inode, .. } => Ok(inode),
        End::Gone => Err(Refused::NoEnd),
        End::Ambiguous => Err(Refused::Ambiguous),
    }
}

/// One process's descriptor of a socket.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Holder {
    pub pid: Pid,
    pub fd: u32,
}

/// A process that may hold a socket no descriptor of a readable process links to: one whose
/// descriptors can't be read, or one holding an `io_uring`. Its start, in clock ticks since boot as
/// its `stat` said when the scan read it, pins it: a process that took its pid since shows another.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Candidate {
    pub pid: Pid,
    pub started: u64,
}

/// What a descriptor of an `io_uring` links to.
pub const IO_URING: &[u8] = b"anon_inode:[io_uring]";

/// What one pass over this user's processes found: who holds each socket asked of it, the
/// candidates that may hold one unseen, and whether a process changed while it was read.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Scan {
    held: BTreeMap<u64, Vec<Holder>>,
    candidates: Vec<Candidate>,
    raced: bool,
}

/// What the scan makes of a process whose descriptors it couldn't read, or that holds an `io_uring`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Unseen {
    /// A candidate, pinned by its start.
    Candidate(Candidate),
    /// A zombie whose every thread has exited, which holds no descriptor at all.
    Exited,
    /// One that changed, or went, while it was read.
    Raced,
}

/// What `pid` is, as `view` reads it. A zombie is one that holds nothing only once its `stat` says
/// so with one thread, its `task` lists itself alone, and its `stat` says so again with the same
/// start: a zombie leader whose other threads run shares their descriptors. Any other reading of a
/// zombie, or of a process that goes, is a race.
fn unseen(view: &(impl ProcView + ?Sized), pid: Pid) -> Unseen {
    let Ok(first) = view.stat(pid) else {
        return Unseen::Raced;
    };
    let Some(started) = start_time::start_ticks(&first) else {
        return Unseen::Raced;
    };
    if !zombie(&first) {
        return Unseen::Candidate(Candidate { pid, started });
    }
    let alone = lone_zombie(&first) && view.tasks(pid).is_ok_and(|tasks| tasks == [pid]);
    let again = view
        .stat(pid)
        .is_ok_and(|again| lone_zombie(&again) && start_time::start_ticks(&again) == Some(started));
    if alone && again {
        Unseen::Exited
    } else {
        Unseen::Raced
    }
}

/// Whether a `/proc/<pid>/stat` line is a zombie's: state, field 3, `Z`.
fn zombie(stat: &[u8]) -> bool {
    start_time::stat_field(stat, 3) == Some(b"Z".as_slice())
}

/// Whether a `/proc/<pid>/stat` line is a zombie's with one thread: `num_threads`, field 20, which
/// `status` shows as `Threads:`.
fn lone_zombie(stat: &[u8]) -> bool {
    zombie(stat) && start_time::stat_field(stat, 20) == Some(b"1".as_slice())
}

/// One pass over `view`'s processes for each socket in `inodes`, as many requests as arrived
/// together ask: the cost is the pass, not the requests. A process that has gone holds nothing.
///
/// # Errors
///
/// When the processes can't be listed.
pub fn scan(view: &(impl ProcView + ?Sized), inodes: &BTreeSet<u64>) -> io::Result<Scan> {
    let mut found = Scan::default();
    for pid in view.processes()? {
        let ring = match view.descriptors(pid) {
            Ok(descriptors) => {
                let mut ring = false;
                for (fd, link) in descriptors {
                    ring |= link == IO_URING;
                    if let Some(inode) = socket_inode(&link).filter(|i| inodes.contains(i)) {
                        found
                            .held
                            .entry(inode)
                            .or_default()
                            .push(Holder { pid, fd });
                    }
                }
                ring
            }
            Err(e) if gone(&e) => false,
            Err(_) => true,
        };
        if ring {
            match unseen(view, pid) {
                Unseen::Candidate(candidate) => found.candidates.push(candidate),
                Unseen::Exited => {}
                Unseen::Raced => found.raced = true,
            }
        }
    }
    Ok(found)
}

/// The processes `scan` found that may hold a socket unseen, in the order it found them, each
/// pinned by its start.
///
/// # Errors
///
/// `Changed` when a process changed, or went, while the scan read it.
pub fn candidates(scan: &Scan) -> Result<&[Candidate], Refused> {
    if scan.raced {
        return Err(Refused::Changed(
            "a process that may hold the caller's socket changed while it was read",
        ));
    }
    Ok(&scan.candidates)
}

/// Whether reading a process failed because it has gone.
fn gone(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::NotFound
        || error.raw_os_error() == Some(rustix::io::Errno::SRCH.raw_os_error())
}

/// The processes `scan` found holding `inode`, one descriptor each.
///
/// # Errors
///
/// `NoReadableHolder` when none was found, `TooManyHolders` past `MAX_HOLDERS`.
pub fn holders(scan: &Scan, inode: u64) -> Result<Vec<Holder>, Refused> {
    let mut holders = scan.held.get(&inode).cloned().unwrap_or_default();
    holders.dedup_by_key(|holder| holder.pid);
    match holders.len() {
        0 => Err(Refused::NoReadableHolder {
            unreadable: scan.candidates.len(),
        }),
        n if n > MAX_HOLDERS => Err(Refused::TooManyHolders { holders: n }),
        _ => Ok(holders),
    }
}

/// Each of `holders` as `read` reads it (`of_pid`), each holding `inode` still once read.
///
/// # Errors
///
/// `read`'s refusal, or `HolderChanged` for a holder no longer holding the socket.
pub fn peers(
    view: &(impl ProcView + ?Sized),
    inode: u64,
    holders: &[Holder],
    read: impl Fn(Pid) -> Result<Peer, Refused>,
) -> Result<Vec<Peer>, Refused> {
    holders
        .iter()
        .map(|holder| {
            let peer = read(holder.pid)?;
            match view.descriptor(holder.pid, holder.fd) {
                Ok(link) if socket_inode(&link) == Some(inode) => Ok(peer),
                _ => Err(Refused::HolderChanged),
            }
        })
        .collect()
}

/// `/proc` itself.
#[cfg(target_os = "linux")]
#[derive(Debug, Clone, Copy, Default)]
pub struct Proc;

#[cfg(target_os = "linux")]
impl ProcView for Proc {
    fn tables(&self) -> io::Result<Vec<String>> {
        ["/proc/net/tcp", "/proc/net/tcp6"]
            .into_iter()
            .map(|table| match std::fs::read_to_string(table) {
                Err(e) if e.kind() == io::ErrorKind::NotFound && table.ends_with('6') => {
                    Ok(String::new())
                }
                read => read,
            })
            .collect()
    }

    fn processes(&self) -> io::Result<Vec<Pid>> {
        use std::os::unix::fs::MetadataExt as _;
        let uid = rustix::process::geteuid().as_raw();
        let mut pids = Vec::new();
        for entry in std::fs::read_dir("/proc")? {
            let entry = entry?;
            let Some(pid) = entry
                .file_name()
                .to_str()
                .and_then(|name| name.parse().ok())
                .and_then(Pid::from_raw)
            else {
                continue;
            };
            match entry.metadata() {
                Ok(meta) if meta.uid() == uid => pids.push(pid),
                Ok(_) => {}
                Err(e) if gone(&e) => {}
                Err(e) => return Err(e),
            }
        }
        Ok(pids)
    }

    fn descriptors(&self, pid: Pid) -> io::Result<Vec<(u32, Vec<u8>)>> {
        use std::os::unix::ffi::OsStrExt as _;
        let dir = format!("/proc/{}/fd", pid.as_raw_pid());
        let mut descriptors = Vec::new();
        for entry in std::fs::read_dir(&dir)? {
            let entry = entry?;
            let Some(fd) = entry.file_name().to_str().and_then(|n| n.parse().ok()) else {
                continue;
            };
            match std::fs::read_link(entry.path()) {
                Ok(link) => descriptors.push((fd, link.as_os_str().as_bytes().to_vec())),
                Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                Err(e) => return Err(e),
            }
        }
        Ok(descriptors)
    }

    fn descriptor(&self, pid: Pid, fd: u32) -> io::Result<Vec<u8>> {
        use std::os::unix::ffi::OsStrExt as _;
        let link = std::fs::read_link(format!("/proc/{}/fd/{fd}", pid.as_raw_pid()))?;
        Ok(link.as_os_str().as_bytes().to_vec())
    }

    fn stat(&self, pid: Pid) -> io::Result<Vec<u8>> {
        std::fs::read(format!("/proc/{}/stat", pid.as_raw_pid()))
    }

    fn tasks(&self, pid: Pid) -> io::Result<Vec<Pid>> {
        let mut tasks = Vec::new();
        for entry in std::fs::read_dir(format!("/proc/{}/task", pid.as_raw_pid()))? {
            if let Some(task) = entry?
                .file_name()
                .to_str()
                .and_then(|name| name.parse().ok())
                .and_then(Pid::from_raw)
            {
                tasks.push(task);
            }
        }
        Ok(tasks)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A v4 listener's accepted connection from a v4 client, as `tcp` listed both ends.
    const V4_CLIENT: &str = "  42: 0100007F:CE7A 0100007F:CF77 01 00000000:00000000 00:00000000 \
                             00000000  1000        0 418491568 1 0000000000000000 20 0 0 10 -1";
    const V4_SERVER: &str = "  43: 0100007F:CF77 0100007F:CE7A 01 00000000:00000000 00:00000000 \
                             00000000  1000        0 418491569 1 0000000000000000 20 0 0 10 -1";
    /// A dual-stack client connected to an IPv4 listener, as `tcp6` listed it.
    const MAPPED_CLIENT: &str = "   4: 0000000000000000FFFF00000100007F:CE7A \
                                 0000000000000000FFFF00000100007F:CF77 01 00000000:00000000 \
                                 00:00000000 00000000  1000        0 418491568 2 \
                                 0000000000000000 20 0 0 10 -1";
    /// A client of `::1`, as `tcp6` listed it.
    const V6_CLIENT: &str = "   5: 00000000000000000000000001000000:C75C \
                             00000000000000000000000001000000:BF75 01 00000000:00000000 \
                             00:00000000 00000000  1000        0 418498579 2 0000000000000000 \
                             20 0 0 10 -1";
    const HEADING: &str = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when \
                           retrnsmt   uid  timeout inode";

    fn at(text: &str) -> SocketAddr {
        text.parse().unwrap()
    }

    fn live(local: &str, remote: &str, inode: u64) -> Row {
        Row {
            local: at(local),
            remote: at(remote),
            state: 0x01,
            uid: 1000,
            inode,
        }
    }

    #[test]
    fn reads_a_sockets_ends_owner_and_inode_from_each_table() {
        assert_eq!(
            [row(V4_CLIENT), row(MAPPED_CLIENT), row(V6_CLIENT)],
            [
                Some(live("127.0.0.1:52858", "127.0.0.1:53111", 418_491_568)),
                Some(live(
                    "[::ffff:127.0.0.1]:52858",
                    "[::ffff:127.0.0.1]:53111",
                    418_491_568
                )),
                Some(live("[::1]:51036", "[::1]:49013", 418_498_579)),
            ]
        );
    }

    #[test]
    fn reads_no_socket_from_a_heading_or_a_cut_or_malformed_line() {
        let cut: String = V4_CLIENT.chars().take(60).collect();
        let lines = [
            HEADING.to_owned(),
            String::new(),
            cut,
            V4_CLIENT.replace("0100007F:CE7A", "100007F:CE7A"),
            V4_CLIENT.replace("0100007F:CE7A", "0100007F:CE7A0"),
            V4_CLIENT.replace("0100007F:CE7A", "0100007G:CE7A"),
            V4_CLIENT.replace("0100007F:CE7A", "0100007F0100007F:CE7A"),
            V4_CLIENT.replace("  42:", "  42"),
            V4_CLIENT.replace(" 01 ", " 001 "),
            V4_CLIENT.replace("418491568", "-418491568"),
            V4_CLIENT.replace("418491568", "+418491568"),
            V4_CLIENT.replace("  1000  ", "  -1  "),
        ];
        assert_eq!(lines.map(|line| row(&line)), [None; 12]);
    }

    #[test]
    fn finds_the_callers_end_written_as_ipv4_or_mapped_and_not_the_daemons() {
        let client = at("127.0.0.1:52858");
        let server = at("127.0.0.1:53111");
        let ends = [V4_SERVER, V4_CLIENT, MAPPED_CLIENT].map(|line| row(line).unwrap());
        assert_eq!(
            [
                end_of([ends[0], ends[1]], client, server),
                end_of([ends[0], ends[2]], client, server),
                end_of([ends[0]], client, server),
            ],
            [
                End::Live {
                    uid: 1000,
                    inode: 418_491_568
                },
                End::Live {
                    uid: 1000,
                    inode: 418_491_568
                },
                End::Gone,
            ]
        );
    }

    #[test]
    fn takes_a_leftover_for_no_end_and_two_live_ends_for_no_answer() {
        let client = at("127.0.0.1:52858");
        let server = at("127.0.0.1:53111");
        let end = live("127.0.0.1:52858", "127.0.0.1:53111", 7);
        let waiting = Row {
            state: TIME_WAIT,
            ..end
        };
        let orphan = Row { inode: 0, ..end };
        let mapped = live("[::ffff:127.0.0.1]:52858", "[::ffff:127.0.0.1]:53111", 8);
        assert_eq!(
            [
                end_of([waiting, orphan], client, server),
                end_of([waiting, end, orphan], client, server),
                end_of([end, mapped], client, server),
            ],
            [
                End::Gone,
                End::Live {
                    uid: 1000,
                    inode: 7
                },
                End::Ambiguous
            ]
        );
    }

    #[test]
    fn reads_a_socket_inode_from_a_socket_link_only() {
        let links: [&[u8]; 7] = [
            b"socket:[418491568]",
            b"socket:[]",
            b"socket:[12a]",
            b"socket:[-1]",
            b"pipe:[418491568]",
            b"/dev/null",
            b"socket:[1]x",
        ];
        assert_eq!(
            links.map(socket_inode),
            [Some(418_491_568), None, None, None, None, None, None]
        );
    }

    mod holders {
        use std::cell::{Cell, RefCell};
        use std::collections::{BTreeSet, HashMap};

        use super::super::*;
        use super::{V4_CLIENT, V4_SERVER, at};

        /// How a fake process's descriptors read.
        #[derive(Clone)]
        enum Fds {
            Read(Vec<(u32, Vec<u8>)>),
            Gone,
            Denied,
        }

        #[derive(Default)]
        struct Fake {
            tables: Vec<String>,
            processes: Vec<(i32, Fds)>,
            /// What a descriptor reads once its process's line has been read, if not what the
            /// scan saw.
            after: RefCell<HashMap<(i32, u32), Vec<u8>>>,
            passes: Cell<usize>,
            /// Each process's `stat` lines, one a read and the last again after, `None` for one
            /// gone; a live one started at tick 100 where none are given.
            stats: HashMap<i32, Vec<Option<Vec<u8>>>>,
            stat_reads: RefCell<HashMap<i32, usize>>,
            /// Each process's threads; itself alone where none are given.
            tasks: HashMap<i32, Vec<i32>>,
        }

        /// A `/proc/<pid>/stat` line, in `state` with `threads` threads, started at tick
        /// `started`.
        fn stat_line(raw: i32, state: char, threads: u32, started: u64) -> Vec<u8> {
            format!("{raw} (p) {state} 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 {threads} 0 {started} 0 0")
                .into_bytes()
        }

        impl ProcView for Fake {
            fn tables(&self) -> io::Result<Vec<String>> {
                Ok(self.tables.clone())
            }
            fn processes(&self) -> io::Result<Vec<Pid>> {
                self.passes.set(self.passes.get() + 1);
                Ok(self.processes.iter().map(|(p, _)| pid(*p)).collect())
            }
            fn descriptors(&self, pid: Pid) -> io::Result<Vec<(u32, Vec<u8>)>> {
                let (_, fds) = self
                    .processes
                    .iter()
                    .find(|(p, _)| *p == pid.as_raw_pid())
                    .unwrap();
                match fds {
                    Fds::Read(fds) => Ok(fds.clone()),
                    Fds::Gone => Err(io::Error::from(io::ErrorKind::NotFound)),
                    Fds::Denied => Err(io::Error::from(io::ErrorKind::PermissionDenied)),
                }
            }
            fn descriptor(&self, pid: Pid, fd: u32) -> io::Result<Vec<u8>> {
                let raw = pid.as_raw_pid();
                if let Some(link) = self.after.borrow().get(&(raw, fd)) {
                    return Ok(link.clone());
                }
                match self.descriptors(pid)?.into_iter().find(|(f, _)| *f == fd) {
                    Some((_, link)) => Ok(link),
                    None => Err(io::Error::from(io::ErrorKind::NotFound)),
                }
            }
            fn stat(&self, pid: Pid) -> io::Result<Vec<u8>> {
                let raw = pid.as_raw_pid();
                let Some(lines) = self.stats.get(&raw) else {
                    return Ok(stat_line(raw, 'S', 1, 100));
                };
                let mut reads = self.stat_reads.borrow_mut();
                let read = reads.entry(raw).or_default();
                let line = lines.get(*read).or(lines.last()).cloned().flatten();
                *read += 1;
                line.ok_or_else(|| io::Error::from(io::ErrorKind::NotFound))
            }
            fn tasks(&self, of: Pid) -> io::Result<Vec<Pid>> {
                let raw = of.as_raw_pid();
                Ok(self
                    .tasks
                    .get(&raw)
                    .map_or_else(|| vec![of], |tasks| tasks.iter().map(|t| pid(*t)).collect()))
            }
        }

        fn pid(raw: i32) -> Pid {
            Pid::from_raw(raw).unwrap()
        }

        fn socket(inode: u64) -> Vec<u8> {
            format!("socket:[{inode}]").into_bytes()
        }

        fn read(fds: &[(u32, Vec<u8>)]) -> Fds {
            Fds::Read(fds.to_vec())
        }

        fn inodes(of: &[u64]) -> BTreeSet<u64> {
            of.iter().copied().collect()
        }

        fn peer(raw: i32) -> Peer {
            Peer {
                pid: pid(raw),
                session: None,
                codex_server: None,
                environment_withheld: false,
                ancestors: vec![],
                names: vec![],
            }
        }

        fn table(lines: &[&str]) -> Vec<String> {
            vec![lines.join("\n"), String::new()]
        }

        const CLIENT: &str = "127.0.0.1:52858";
        const SERVER: &str = "127.0.0.1:53111";

        #[test]
        fn finds_the_inode_of_the_callers_end_and_refuses_one_it_cant_name() {
            let view = |lines: &[&str]| Fake {
                tables: table(lines),
                ..Fake::default()
            };
            let other = V4_CLIENT.replace("  1000  ", "  1001  ");
            let twice = V4_CLIENT.replace("418491568", "7");
            let ends = [
                end(&view(&[V4_SERVER, V4_CLIENT]), at(CLIENT), at(SERVER), 1000),
                end(&view(&[V4_SERVER]), at(CLIENT), at(SERVER), 1000),
                end(&view(&[V4_CLIENT, &twice]), at(CLIENT), at(SERVER), 1000),
                end(&view(&[&other]), at(CLIENT), at(SERVER), 1000),
            ];
            assert_eq!(
                ends.map(|e| e.map_err(|r| r.to_string())),
                [
                    Ok(418_491_568),
                    Err(Refused::NoEnd.to_string()),
                    Err(Refused::Ambiguous.to_string()),
                    Err(Refused::Foreign { uid: 1001 }.to_string()),
                ]
            );
        }

        /// Every process that could hold a socket no link shows is kept, pinned by the start its
        /// `stat` gave the scan: one whose descriptors can't be read, and one holding an `io_uring`.
        #[test]
        fn keeps_each_unreadable_process_and_each_io_uring_holder_as_a_candidate() {
            let view = Fake {
                processes: vec![
                    (10, Fds::Denied),
                    (11, read(&[(3, IO_URING.to_vec()), (4, socket(9))])),
                    (12, read(&[(3, b"anon_inode:[eventfd]".to_vec())])),
                    (13, Fds::Gone),
                ],
                stats: HashMap::from([(10, vec![Some(stat_line(10, 'S', 4, 500))])]),
                ..Fake::default()
            };
            let found = scan(&view, &inodes(&[7])).unwrap();
            assert_eq!(
                (
                    candidates(&found)
                        .map(<[_]>::to_vec)
                        .map_err(|r| r.to_string()),
                    holders(&found, 7).map_err(|r| r.to_string()),
                ),
                (
                    Ok(vec![
                        Candidate {
                            pid: pid(10),
                            started: 500
                        },
                        Candidate {
                            pid: pid(11),
                            started: 100
                        },
                    ]),
                    Err(Refused::NoReadableHolder { unreadable: 2 }.to_string()),
                )
            );
        }

        /// A zombie holds nothing once every thread of it has exited, which its `stat`, its
        /// `task` and its `stat` again must each say, the same start both times. A zombie read any
        /// other way, or an unreadable process that goes before its `stat` is read, is a race.
        #[test]
        fn leaves_out_a_zombie_only_once_its_every_thread_has_exited_and_else_calls_it_a_race() {
            let zombie = |threads| Some(stat_line(10, 'Z', threads, 500));
            let scanned = |stats: Vec<Option<Vec<u8>>>, tasks: Vec<i32>| {
                let view = Fake {
                    processes: vec![(10, Fds::Denied)],
                    stats: HashMap::from([(10, stats)]),
                    tasks: HashMap::from([(10, tasks)]),
                    ..Fake::default()
                };
                let found = scan(&view, &inodes(&[7])).unwrap();
                candidates(&found)
                    .map(<[_]>::to_vec)
                    .map_err(|r| r.to_string())
            };
            let raced = Err(Refused::Changed(
                "a process that may hold the caller's socket changed while it was read",
            )
            .to_string());
            assert_eq!(
                [
                    scanned(vec![zombie(1), zombie(1)], vec![10]),
                    scanned(vec![zombie(2), zombie(2)], vec![10]),
                    scanned(vec![zombie(1), zombie(1)], vec![10, 11]),
                    scanned(vec![zombie(1), Some(stat_line(10, 'Z', 1, 501))], vec![10]),
                    scanned(vec![zombie(1), None], vec![10]),
                    scanned(vec![None], vec![10]),
                ],
                [
                    Ok(vec![]),
                    raced.clone(),
                    raced.clone(),
                    raced.clone(),
                    raced.clone(),
                    raced,
                ]
            );
        }

        /// A candidate is read on this host's `/proc` pinned to its start: this test's own
        /// process, made non-dumpable as `sshd` is so that the kernel hides its environment, is
        /// read with that environment taken as withheld; and pinned to another start, as a
        /// process that took its pid would show, it is a race.
        #[cfg(target_os = "linux")]
        #[test]
        fn reads_a_candidate_pinned_to_its_start_and_calls_another_start_a_race() {
            use rustix::process::{DumpableBehavior, getpid, set_dumpable_behavior};
            /// This process non-dumpable while it lives, and dumpable again after, a panic
            /// included.
            struct NotDumpable;
            impl Drop for NotDumpable {
                fn drop(&mut self) {
                    set_dumpable_behavior(DumpableBehavior::Dumpable).unwrap();
                }
            }
            let me = getpid();
            let started = start_time::start_ticks(&Proc.stat(me).unwrap()).unwrap();
            set_dumpable_behavior(DumpableBehavior::NotDumpable).unwrap();
            let dumpable_again = NotDumpable;
            let hidden =
                std::fs::read(format!("/proc/{}/environ", me.as_raw_pid())).map_err(|e| e.kind());
            let read = crate::candidate_of(Candidate { pid: me, started });
            let moved = crate::candidate_of(Candidate {
                pid: me,
                started: started + 1,
            });
            drop(dumpable_again);
            assert_eq!(
                (
                    hidden,
                    read.map(|peer| (peer.pid, peer.environment_withheld))
                        .map_err(|r| r.to_string()),
                    moved.map(|peer| peer.pid).map_err(|r| r.to_string()),
                ),
                (
                    Err(io::ErrorKind::PermissionDenied),
                    Ok((me, true)),
                    Err(Refused::Changed(
                        "a process that may hold the caller's socket went while it was read"
                    )
                    .to_string()),
                )
            );
        }

        #[test]
        fn finds_each_holder_of_each_socket_asked_in_one_pass() {
            let view = Fake {
                processes: vec![
                    (10, read(&[(0, b"/dev/null".to_vec()), (3, socket(7))])),
                    (11, read(&[(4, socket(8)), (5, socket(9))])),
                    (12, read(&[(6, b"pipe:[7]".to_vec()), (7, socket(7))])),
                ],
                ..Fake::default()
            };
            let found = scan(&view, &inodes(&[7, 8])).unwrap();
            let seven = holders(&found, 7).map_err(|r| r.to_string());
            let eight = holders(&found, 8).map_err(|r| r.to_string());
            assert_eq!(
                (seven, eight, view.passes.get()),
                (
                    Ok(vec![
                        Holder {
                            pid: pid(10),
                            fd: 3
                        },
                        Holder {
                            pid: pid(12),
                            fd: 7
                        }
                    ]),
                    Ok(vec![Holder {
                        pid: pid(11),
                        fd: 4
                    }]),
                    1
                )
            );
        }

        #[test]
        fn counts_a_gone_process_as_holding_nothing_and_an_unreadable_one_as_unknown() {
            let view = |holder: Fds| Fake {
                processes: vec![(10, Fds::Gone), (11, Fds::Denied), (12, holder)],
                ..Fake::default()
            };
            let alone = scan(&view(Fds::Gone), &inodes(&[7])).unwrap();
            let beside = scan(&view(read(&[(3, socket(7))])), &inodes(&[7])).unwrap();
            assert_eq!(
                (
                    holders(&alone, 7).map_err(|r| r.to_string()),
                    holders(&beside, 7).map_err(|r| r.to_string()),
                ),
                (
                    Err(Refused::NoReadableHolder { unreadable: 1 }.to_string()),
                    Ok(vec![Holder {
                        pid: pid(12),
                        fd: 3
                    }]),
                )
            );
        }

        #[test]
        fn reads_a_process_holding_the_socket_twice_once_and_refuses_too_many_holders() {
            let many = |n: i32| Fake {
                processes: (1..=n)
                    .map(|p| (p, read(&[(3, socket(7)), (4, socket(7))])))
                    .collect(),
                ..Fake::default()
            };
            let most = scan(&many(16), &inodes(&[7])).unwrap();
            let past = scan(&many(17), &inodes(&[7])).unwrap();
            assert_eq!(
                (
                    holders(&most, 7)
                        .map(|h| h.len())
                        .map_err(|r| r.to_string()),
                    holders(&past, 7)
                        .map(|h| h.len())
                        .map_err(|r| r.to_string()),
                ),
                (
                    Ok(16),
                    Err(Refused::TooManyHolders { holders: 17 }.to_string())
                )
            );
        }

        #[test]
        fn refuses_a_holder_whose_socket_changed_hands_while_its_line_was_read() {
            let view = Fake {
                processes: vec![(10, read(&[(3, socket(7))])), (11, read(&[(4, socket(7))]))],
                ..Fake::default()
            };
            let found = holders(&scan(&view, &inodes(&[7])).unwrap(), 7).unwrap();
            let held = peers(&view, 7, &found, |p| Ok(peer(p.as_raw_pid())));
            view.after.borrow_mut().insert((11, 4), socket(8));
            let changed = peers(&view, 7, &found, |p| Ok(peer(p.as_raw_pid())));
            let refused = peers(&view, 7, &found, |_| Err(Refused::Endless));
            assert_eq!(
                [held, changed, refused].map(|p| p.map_err(|r| r.to_string())),
                [
                    Ok(vec![peer(10), peer(11)]),
                    Err(Refused::HolderChanged.to_string()),
                    Err(Refused::Endless.to_string()),
                ]
            );
        }

        #[cfg(target_os = "linux")]
        #[test]
        fn finds_this_process_as_the_holder_of_its_own_loopback_connection() {
            use std::net::{TcpListener, TcpStream};
            use std::time::{SystemTime, UNIX_EPOCH};

            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let server = listener.local_addr().unwrap();
            let caller = TcpStream::connect(server).unwrap();
            let (_accepted, client) = listener.accept().unwrap();
            let uid = rustix::process::geteuid().as_raw();
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_secs();
            let read = end(&Proc, client, server, uid).and_then(|inode| {
                let scanned = scan(&Proc, &inodes(&[inode]))?;
                let found = holders(&scanned, inode)?;
                peers(&Proc, inode, &found, |p| crate::of_pid(p, now))
            });
            assert_eq!(
                (
                    read.map(|peers| peers.iter().map(|p| p.pid).collect::<Vec<_>>())
                        .map_err(|r| r.to_string()),
                    caller.local_addr().unwrap()
                ),
                (Ok(vec![rustix::process::getpid()]), client)
            );
        }
    }

    mod properties {
        use std::fmt::Write as _;

        use proptest::prelude::*;

        use super::super::*;
        use super::V6_CLIENT;

        /// `address` as the kernel writes it: each 32-bit word's native bytes as `%08X`.
        fn written(address: SocketAddr) -> String {
            let bytes = match address.ip() {
                IpAddr::V4(v4) => v4.octets().to_vec(),
                IpAddr::V6(v6) => v6.octets().to_vec(),
            };
            let host = bytes
                .as_chunks::<4>()
                .0
                .iter()
                .fold(String::new(), |mut host, word| {
                    write!(host, "{:08X}", u32::from_ne_bytes(*word)).unwrap();
                    host
                });
            format!("{host}:{:04X}", address.port())
        }

        /// `row` as the kernel writes its line.
        fn line(slot: u32, row: Row) -> String {
            format!(
                "{slot:4}: {} {} {:02X} 00000000:00000000 00:00000000 00000000 {:5} {:8} {} 1 \
                 0000000000000000 20 0 0 10 -1",
                written(row.local),
                written(row.remote),
                row.state,
                row.uid,
                0,
                row.inode
            )
        }

        fn address() -> impl Strategy<Value = SocketAddr> {
            prop_oneof![
                (any::<[u8; 4]>(), any::<u16>())
                    .prop_map(|(ip, port)| SocketAddr::new(IpAddr::V4(ip.into()), port)),
                (any::<[u8; 16]>(), any::<u16>())
                    .prop_map(|(ip, port)| SocketAddr::new(IpAddr::V6(ip.into()), port)),
            ]
        }

        fn rows() -> impl Strategy<Value = Row> {
            (
                address(),
                address(),
                any::<u8>(),
                any::<u32>(),
                any::<u64>(),
            )
                .prop_map(|(local, remote, state, uid, inode)| Row {
                    local,
                    remote,
                    state,
                    uid,
                    inode,
                })
        }

        /// Where a connection's ends may be, written either way the tables write them, each with
        /// which end it is: the caller (0), the daemon (1), or some other socket (2).
        const POOL: [(&str, usize); 6] = [
            ("127.0.0.1:40000", 0),
            ("[::ffff:127.0.0.1]:40000", 0),
            ("127.0.0.1:7900", 1),
            ("[::ffff:127.0.0.1]:7900", 1),
            ("[::1]:40000", 2),
            ("127.0.0.2:7900", 2),
        ];

        fn pooled() -> impl Strategy<Value = (SocketAddr, usize)> {
            (0..POOL.len()).prop_map(|at| (POOL[at].0.parse().unwrap(), POOL[at].1))
        }

        /// A row over the pool, with the end each address is, in states and inodes that include a
        /// leftover's.
        fn pooled_row() -> impl Strategy<Value = (Row, usize, usize)> {
            (
                pooled(),
                pooled(),
                prop_oneof![Just(0x01u8), Just(TIME_WAIT), Just(0x08u8)],
                0u64..3,
            )
                .prop_map(|((local, l), (remote, r), state, inode)| {
                    let row = Row {
                        local,
                        remote,
                        state,
                        uid: 1000,
                        inode,
                    };
                    (row, l, r)
                })
        }

        proptest! {
            #[test]
            fn reads_back_every_line_the_kernel_writes(slot in any::<u32>(), written in rows()) {
                prop_assert_eq!(row(&line(slot, written)), Some(written));
            }

            #[test]
            fn reads_a_line_with_anything_spliced_in_without_panicking(
                written in rows(),
                at in any::<prop::sample::Index>(),
                cut in 0usize..12,
                text in "[0-9A-F:é€ +-]{0,6}",
            ) {
                let line = line(0, written);
                let at = at.index(line.len());
                let end = (at + cut).min(line.len());
                let (head, tail) = (line.get(..at).unwrap(), line.get(end..).unwrap());
                let spliced = format!("{head}{text}{tail}");
                let _ = row(&spliced);
            }

            #[test]
            fn reads_an_address_of_the_right_length_in_bytes_but_not_digits_without_panicking(
                digits in "[0-9A-F]{32}",
                at in 0usize..32,
                wide in prop_oneof![Just("é"), Just("€")],
            ) {
                let end = (at + wide.len()).min(digits.len());
                let (head, tail) = (digits.get(..at).unwrap(), digits.get(end..).unwrap());
                let local = format!("{head}{wide}{tail}:C75C");
                let line = V6_CLIENT.replacen("00000000000000000000000001000000:C75C", &local, 1);
                prop_assert_eq!(row(&line), None);
            }

            #[test]
            fn finds_an_end_only_where_one_live_row_joins_caller_to_daemon(
                rows in proptest::collection::vec(pooled_row(), 0..6),
                (client, _) in pooled().prop_filter("the caller", |(_, end)| *end == 0),
                (server, _) in pooled().prop_filter("the daemon", |(_, end)| *end == 1),
            ) {
                let ends: Vec<Row> = rows
                    .iter()
                    .filter(|(r, l, rr)| *l == 0 && *rr == 1 && r.state != 0x06 && r.inode != 0)
                    .map(|(r, ..)| *r)
                    .collect();
                let expected = match ends.as_slice() {
                    [] => End::Gone,
                    [one] => End::Live { uid: one.uid, inode: one.inode },
                    _ => End::Ambiguous,
                };
                let rows = rows.into_iter().map(|(r, ..)| r);
                prop_assert_eq!(end_of(rows, client, server), expected);
            }
        }
    }
}
