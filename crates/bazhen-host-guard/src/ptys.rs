//! How many PTYs the machine has in use, and the most it allows, as `ptys.ts` in
//! packages/host-guard reads them. A PTY leak starves every terminal on the machine, Bazhen's and
//! the user's own, so the daemon keeps some free.

use std::io;
use std::path::Path;
use std::time::Duration;

use tokio::process::Command;

use crate::group::{Ended, run_kept};

/// How long macOS is given to say its maximum.
const SYSCTL_TIMEOUT: Duration = Duration::from_secs(5);

/// The machine's PTYs. `exact` is false where `used` counts device nodes rather than PTYs:
/// macOS's `/dev/ttys*` nodes can outlive the PTY that made them, so the count is only an upper
/// bound.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostPtys {
    Counted {
        used: u64,
        max: u64,
        exact: bool,
        /// The setting that raises `max`.
        limit: &'static str,
    },
    /// Why they can't be counted.
    Unread { reason: String },
}

/// What the reader touches, so a test can stand in for the machine.
pub trait PtySource: Send + Sync + std::fmt::Debug {
    /// The file at `path`, as text.
    ///
    /// # Errors
    ///
    /// When it can't be read.
    fn read_file(&self, path: &Path) -> io::Result<String>;

    /// The names in the directory at `path`.
    ///
    /// # Errors
    ///
    /// When it can't be listed.
    fn read_dir(&self, path: &Path) -> io::Result<Vec<String>>;
}

/// The machine itself.
#[derive(Debug, Clone, Copy)]
pub struct Machine;

impl PtySource for Machine {
    fn read_file(&self, path: &Path) -> io::Result<String> {
        std::fs::read_to_string(path)
    }

    fn read_dir(&self, path: &Path) -> io::Result<Vec<String>> {
        std::fs::read_dir(path)?
            .map(|entry| entry.map(|e| e.file_name().to_string_lossy().into_owned()))
            .collect()
    }
}

/// The platform a reader counts on, and on macOS the maximum it read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Platform {
    Linux,
    /// macOS, with `kern.tty.ptmx_max` as it was read, or why it couldn't be.
    Macos {
        ptmx_max: Result<String, String>,
    },
    Other(String),
}

/// A count as `Number` takes it: a whole number, not negative, around white space.
fn count(raw: &str, what: &str) -> Result<u64, String> {
    let raw = raw.trim();
    raw.parse::<u64>()
        .ok()
        .filter(|n| *n < (1 << 53))
        .ok_or_else(|| format!("{what} is \"{raw}\""))
}

/// A reader of the machine's PTYs, called as often as needed. On Linux each call reads the
/// kernel's own counters. On macOS the maximum is read once, as the reader is made, since it costs
/// a process, and a failure to read it is kept as well. A machine whose figures can't be read
/// answers why, never a guess.
#[derive(Debug)]
pub struct PtyReader {
    source: Box<dyn PtySource>,
    platform: Platform,
}

impl PtyReader {
    pub fn new(source: Box<dyn PtySource>, platform: Platform) -> Self {
        Self { source, platform }
    }

    /// The reader of this machine, on the platform it runs.
    pub async fn machine() -> Self {
        let platform = match std::env::consts::OS {
            "linux" => Platform::Linux,
            "macos" => Platform::Macos {
                ptmx_max: ptmx_max().await,
            },
            other => Platform::Other(other.to_owned()),
        };
        Self::new(Box::new(Machine), platform)
    }

    pub fn read(&self) -> HostPtys {
        let read = match &self.platform {
            Platform::Linux => self.linux(),
            Platform::Macos { ptmx_max } => self.macos(ptmx_max),
            // Named as Node names it, as the TypeScript daemon says it.
            Platform::Other(os) => Err(format!("PTYs aren't counted on {os}")),
        };
        read.unwrap_or_else(|reason| HostPtys::Unread { reason })
    }

    fn linux(&self) -> Result<HostPtys, String> {
        let sysctl = |name: &str| {
            let path = format!("/proc/sys/kernel/pty/{name}");
            let raw = self
                .source
                .read_file(Path::new(&path))
                .map_err(|e| format!("{path} can't be read: {e}"))?;
            count(&raw, &format!("kernel.pty.{name}"))
        };
        // The kernel keeps `reserve` of `max` for its first devpts mount. Which mount this process
        // sees can't be told from here, so it takes the smaller limit, as any other mount, a
        // container's, has.
        let (all, reserve) = (sysctl("max")?, sysctl("reserve")?);
        if reserve >= all {
            // On the first mount every PTY is still there, so this says nothing about the limit.
            return Err(format!(
                "kernel.pty.reserve ({reserve}) is all of kernel.pty.max ({all})"
            ));
        }
        Ok(HostPtys::Counted {
            used: sysctl("nr")?,
            max: all - reserve,
            exact: true,
            limit: "kernel.pty.max",
        })
    }

    fn macos(&self, ptmx_max: &Result<String, String>) -> Result<HostPtys, String> {
        let max = count(
            ptmx_max.as_ref().map_err(Clone::clone)?,
            "kern.tty.ptmx_max",
        )?;
        if max == 0 {
            return Err("kern.tty.ptmx_max is 0".to_owned());
        }
        Ok(HostPtys::Counted {
            used: self.nodes()?,
            max,
            exact: false,
            limit: "kern.tty.ptmx_max",
        })
    }

    /// `/dev/ttys*` nodes, macOS's only cheap count of PTYs in use. It includes the 16 legacy BSD
    /// names, and nodes can outlive their PTY: an upper bound, never an exact count.
    fn nodes(&self) -> Result<u64, String> {
        let names = self
            .source
            .read_dir(Path::new("/dev"))
            .map_err(|e| format!("/dev can't be listed: {e}"))?;
        let nodes = names.iter().filter(|name| name.starts_with("ttys")).count();
        u64::try_from(nodes).map_err(|e| e.to_string())
    }
}

/// `kern.tty.ptmx_max`, as `sysctl` says it, within its time.
async fn ptmx_max() -> Result<String, String> {
    let mut command = Command::new("/usr/sbin/sysctl");
    command.args(["-n", "kern.tty.ptmx_max"]);
    let ran = run_kept(command, SYSCTL_TIMEOUT)
        .await
        .map_err(|e| format!("sysctl can't be run: {e}"))?;
    match ran.ended {
        Ended::Exited(status) if status.success() => {
            Ok(String::from_utf8_lossy(&ran.stdout).into_owned())
        }
        Ended::Exited(status) => Err(format!("sysctl -n kern.tty.ptmx_max failed: {status}")),
        Ended::TimedOut => Err("sysctl -n kern.tty.ptmx_max timed out".to_owned()),
        Ended::Unstarted(e) | Ended::Unwaited(e) => {
            Err(format!("sysctl -n kern.tty.ptmx_max can't be run: {e}"))
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::sync::Mutex;

    use super::*;

    /// A machine of files and a /dev listing, which counts its reads.
    #[derive(Debug, Default)]
    struct Fake {
        files: Mutex<BTreeMap<String, String>>,
        dev: Option<Vec<String>>,
        reads: Mutex<u32>,
    }

    impl Fake {
        fn linux(max: &str, reserve: &str, nr: &str) -> Self {
            let fake = Self::default();
            for (name, value) in [("max", max), ("reserve", reserve), ("nr", nr)] {
                fake.set(name, value);
            }
            fake
        }

        fn set(&self, name: &str, value: &str) {
            self.files
                .lock()
                .unwrap()
                .insert(format!("/proc/sys/kernel/pty/{name}"), value.to_owned());
        }
    }

    impl PtySource for std::sync::Arc<Fake> {
        fn read_file(&self, path: &Path) -> io::Result<String> {
            *self.reads.lock().unwrap() += 1;
            self.files
                .lock()
                .unwrap()
                .get(path.to_str().unwrap())
                .cloned()
                .ok_or_else(|| io::Error::from(io::ErrorKind::NotFound))
        }

        fn read_dir(&self, _: &Path) -> io::Result<Vec<String>> {
            self.dev
                .clone()
                .ok_or_else(|| io::Error::from(io::ErrorKind::PermissionDenied))
        }
    }

    fn reader(fake: Fake, platform: Platform) -> (PtyReader, std::sync::Arc<Fake>) {
        let fake = std::sync::Arc::new(fake);
        (
            PtyReader::new(Box::new(std::sync::Arc::clone(&fake)), platform),
            fake,
        )
    }

    fn unread(reason: &str) -> HostPtys {
        HostPtys::Unread {
            reason: reason.to_owned(),
        }
    }

    #[test]
    fn reads_linux_s_kernel_counters_as_an_exact_count_the_limit_less_the_first_mount_s_reserve() {
        let (ptys, _) = reader(Fake::linux("4096\n", "1024\n", "12\n"), Platform::Linux);
        assert_eq!(
            ptys.read(),
            HostPtys::Counted {
                used: 12,
                max: 3072,
                exact: true,
                limit: "kernel.pty.max"
            }
        );
    }

    #[test]
    fn reads_linux_s_counters_again_on_every_call() {
        let (ptys, fake) = reader(Fake::linux("4096", "1024", "12"), Platform::Linux);
        ptys.read();
        fake.set("nr", "13");
        assert!(matches!(ptys.read(), HostPtys::Counted { used: 13, .. }));
        assert_eq!(*fake.reads.lock().unwrap(), 6);
    }

    #[test]
    fn answers_why_when_a_linux_counter_is_missing_or_not_a_count() {
        let (garbled, _) = reader(Fake::linux("4096", "1024", "lots"), Platform::Linux);
        assert_eq!(garbled.read(), unread("kernel.pty.nr is \"lots\""));
        let (negative, _) = reader(Fake::linux("4096", "-1", "1"), Platform::Linux);
        assert_eq!(negative.read(), unread("kernel.pty.reserve is \"-1\""));
        let (missing, _) = reader(Fake::default(), Platform::Linux);
        assert!(
            matches!(missing.read(), HostPtys::Unread { reason } if reason.starts_with("/proc/sys/kernel/pty/max can't be read")),
        );
    }

    #[test]
    fn can_t_say_the_limit_when_the_first_mount_s_reserve_is_all_of_the_ptys() {
        let (ptys, _) = reader(Fake::linux("1024", "1024", "3"), Platform::Linux);
        assert_eq!(
            ptys.read(),
            unread("kernel.pty.reserve (1024) is all of kernel.pty.max (1024)")
        );
    }

    #[test]
    fn counts_macos_s_dev_ttys_nodes_as_an_upper_bound_not_an_exact_count() {
        let fake = Fake {
            dev: Some(
                ["ttys000", "ttys001", "tty", "ttyp0", "null"]
                    .map(str::to_owned)
                    .to_vec(),
            ),
            ..Fake::default()
        };
        let (ptys, _) = reader(
            fake,
            Platform::Macos {
                ptmx_max: Ok("511\n".to_owned()),
            },
        );
        assert_eq!(
            ptys.read(),
            HostPtys::Counted {
                used: 2,
                max: 511,
                exact: false,
                limit: "kern.tty.ptmx_max"
            }
        );
    }

    #[test]
    fn keeps_a_failure_to_read_macos_s_maximum_and_never_counts_without_one() {
        let fake = Fake {
            dev: Some(vec!["ttys000".to_owned()]),
            ..Fake::default()
        };
        let (ptys, _) = reader(
            fake,
            Platform::Macos {
                ptmx_max: Err("sysctl -n kern.tty.ptmx_max timed out".to_owned()),
            },
        );
        assert_eq!(ptys.read(), unread("sysctl -n kern.tty.ptmx_max timed out"));
        assert_eq!(ptys.read(), unread("sysctl -n kern.tty.ptmx_max timed out"));
    }

    #[test]
    fn can_t_say_the_limit_of_a_macos_that_allows_no_ptys() {
        let (ptys, _) = reader(
            Fake::default(),
            Platform::Macos {
                ptmx_max: Ok("0".to_owned()),
            },
        );
        assert_eq!(ptys.read(), unread("kern.tty.ptmx_max is 0"));
    }

    #[test]
    fn counts_nothing_on_a_platform_it_can_t_read() {
        let (ptys, _) = reader(Fake::default(), Platform::Other("freebsd".to_owned()));
        assert_eq!(ptys.read(), unread("PTYs aren't counted on freebsd"));
    }
}
