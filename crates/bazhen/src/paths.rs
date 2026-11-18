//! Which daemon's socket a verb reaches. Inside anything Bazhen started, that is the one
//! `BAZHEN_SOCKET` names: the daemon that started it, the only one its agent id and token mean
//! anything to, wherever its home is. Elsewhere it is where the daemon itself puts its socket
//! (apps/daemon/src/config/paths.ts): one XDG layout on macOS and Linux, each place from a flag,
//! then the environment, then the default.

use crate::sha256::{hex, sha256};

/// `sun_path` holds 104 bytes, including the terminating NUL.
const MAX_SOCKET_PATH: usize = 103;
const SOCKET_NAME: &str = "bazhen.sock";

/// What the socket's place is resolved from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Inputs {
    /// Over every other input when it isn't empty.
    pub(crate) bazhen_socket: Option<String>,
    /// `--home`, over `BAZHEN_HOME`.
    pub(crate) home_flag: Option<String>,
    pub(crate) bazhen_home: Option<String>,
    pub(crate) xdg_runtime_dir: Option<String>,
    /// The temporary directory, as Node's `os.tmpdir()` finds it.
    pub(crate) tmp: String,
    pub(crate) uid: u32,
    pub(crate) macos: bool,
}

/// A home that isn't an absolute path, which names no instance.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RelativeHome(pub(crate) String);

impl std::fmt::Display for RelativeHome {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "BAZHEN_HOME must be an absolute path, not {}", self.0)
    }
}

/// The socket a verb reaches.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Socket {
    pub(crate) path: String,
    /// The `--home` given, when `BAZHEN_SOCKET` names another socket than that home's.
    pub(crate) overridden_home: Option<String>,
}

/// The socket a verb reaches. A home that isn't absolute is refused even when `BAZHEN_SOCKET`
/// wins: the command line is wrong either way.
pub(crate) fn socket(i: &Inputs) -> Result<Socket, RelativeHome> {
    let homes = home_socket(i)?;
    let Some(given) = i.bazhen_socket.as_deref().filter(|s| !s.is_empty()) else {
        return Ok(Socket {
            path: homes,
            overridden_home: None,
        });
    };
    let same = given.starts_with('/') && normalize(given) == homes;
    Ok(Socket {
        path: given.to_owned(),
        overridden_home: i.home_flag.clone().filter(|_| !same),
    })
}

/// The socket of the home `--home` or `BAZHEN_HOME` names, else of the default one.
fn home_socket(i: &Inputs) -> Result<String, RelativeHome> {
    let home = i.home_flag.as_ref().or(i.bazhen_home.as_ref());
    let run = match home {
        Some(home) if !home.starts_with('/') => return Err(RelativeHome(home.clone())),
        Some(home) => normalize(&format!("{home}/run")),
        None => default_run(i),
    };
    let run = if format!("{run}/{SOCKET_NAME}").len() > MAX_SOCKET_PATH {
        format!("/tmp/bazhen-{}-{}", i.uid, short_hash(&run))
    } else {
        run
    };
    Ok(format!("{run}/{SOCKET_NAME}"))
}

fn default_run(i: &Inputs) -> String {
    if i.macos {
        return normalize(&format!("{}/bazhen", i.tmp));
    }
    match i.xdg_runtime_dir.as_deref() {
        Some(runtime) if runtime.starts_with('/') => normalize(&format!("{runtime}/bazhen")),
        _ => format!("/tmp/bazhen-{}", i.uid),
    }
}

/// The first 8 hex digits of `value`'s SHA-256.
fn short_hash(value: &str) -> String {
    hex(sha256(value.as_bytes()).get(..4).unwrap_or_default())
}

/// An absolute path as Node's `path.resolve` leaves it: no `.`, `..`, repeated or trailing `/`.
pub(crate) fn normalize(path: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            part => parts.push(part),
        }
    }
    format!("/{}", parts.join("/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inputs() -> Inputs {
        Inputs {
            bazhen_socket: None,
            home_flag: None,
            bazhen_home: None,
            xdg_runtime_dir: Some("/run/user/1000".into()),
            tmp: "/var/folders/x/T".into(),
            uid: 1000,
            macos: false,
        }
    }

    fn path(i: &Inputs) -> Result<String, RelativeHome> {
        socket(i).map(|s| s.path)
    }

    #[test]
    fn a_home_holds_its_socket_in_run_normalised_and_the_flag_wins() {
        let home = Inputs {
            bazhen_home: Some("/a/./b/../h/".into()),
            ..inputs()
        };
        let flag = Inputs {
            home_flag: Some("/f".into()),
            ..home.clone()
        };
        assert_eq!(path(&home), Ok("/a/h/run/bazhen.sock".into()));
        assert_eq!(path(&flag), Ok("/f/run/bazhen.sock".into()));
    }

    #[test]
    fn refuses_a_home_that_isnt_absolute() {
        let home = Inputs {
            home_flag: Some("rel".into()),
            ..inputs()
        };
        assert_eq!(path(&home), Err(RelativeHome("rel".into())));
    }

    #[test]
    fn with_no_home_it_is_the_runtime_dirs_or_the_users_under_tmp_or_macos_tmp() {
        let relative = Inputs {
            xdg_runtime_dir: Some("run".into()),
            ..inputs()
        };
        let mac = Inputs {
            macos: true,
            ..inputs()
        };
        assert_eq!(
            path(&inputs()),
            Ok("/run/user/1000/bazhen/bazhen.sock".into())
        );
        assert_eq!(path(&relative), Ok("/tmp/bazhen-1000/bazhen.sock".into()));
        assert_eq!(path(&mac), Ok("/var/folders/x/T/bazhen/bazhen.sock".into()));
    }

    #[test]
    fn a_socket_path_too_long_moves_to_a_short_hashed_directory() {
        let long = format!("/{}", "h".repeat(100));
        let home = Inputs {
            bazhen_home: Some(long.clone()),
            ..inputs()
        };
        let hash = short_hash(&format!("{long}/run"));
        assert_eq!(hash.len(), 8);
        assert_eq!(
            path(&home),
            Ok(format!("/tmp/bazhen-1000-{hash}/bazhen.sock"))
        );
    }

    #[test]
    fn the_socket_bazhen_started_the_caller_with_wins_over_the_flag_the_home_and_the_default() {
        let agents = "/b/run/bazhen.sock";
        let bare = Inputs {
            bazhen_socket: Some(agents.into()),
            ..inputs()
        };
        let homed = Inputs {
            bazhen_home: Some("/h".into()),
            ..bare.clone()
        };
        let flagged = Inputs {
            home_flag: Some("/f".into()),
            ..homed.clone()
        };
        assert_eq!(
            [path(&bare), path(&homed), path(&flagged)],
            [Ok(agents.into()), Ok(agents.into()), Ok(agents.into())]
        );
    }

    #[test]
    fn an_empty_bazhen_socket_is_none() {
        let empty = Inputs {
            bazhen_socket: Some(String::new()),
            bazhen_home: Some("/h".into()),
            ..inputs()
        };
        assert_eq!(
            socket(&empty),
            Ok(Socket {
                path: "/h/run/bazhen.sock".into(),
                overridden_home: None
            })
        );
    }

    #[test]
    fn names_the_flag_bazhen_socket_overrides_only_when_it_names_another_socket() {
        let agents = Inputs {
            bazhen_socket: Some("/b/run/bazhen.sock".into()),
            ..inputs()
        };
        let with = |home_flag: Option<&str>, bazhen_home: Option<&str>| {
            let i = Inputs {
                home_flag: home_flag.map(Into::into),
                bazhen_home: bazhen_home.map(Into::into),
                ..agents.clone()
            };
            socket(&i).map(|s| s.overridden_home)
        };
        assert_eq!(
            [
                with(Some("/f"), None),
                with(Some("/b/"), None),
                with(None, Some("/h"))
            ],
            [Ok(Some("/f".into())), Ok(None), Ok(None)]
        );
    }

    #[test]
    fn refuses_a_home_that_isnt_absolute_whatever_bazhen_socket_says() {
        let relative = Inputs {
            bazhen_socket: Some("/b/run/bazhen.sock".into()),
            bazhen_home: Some("rel".into()),
            ..inputs()
        };
        assert_eq!(socket(&relative), Err(RelativeHome("rel".into())));
    }
}
