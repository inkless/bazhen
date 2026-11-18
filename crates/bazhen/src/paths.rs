//! Which daemon's socket a verb reaches. Inside anything Bazhen started, that is the one
//! `BAZHEN_SOCKET` names: the daemon that started it, the only one its agent id and token mean
//! anything to, wherever its home is. Elsewhere it is where the daemon itself puts its socket
//! (apps/daemon/src/config/paths.ts): one XDG layout on macOS and Linux, each place from a flag,
//! then the environment, then the default.

use std::path::Path;

use crate::sha256::{hex, sha256};

/// `sun_path` holds 104 bytes, including the terminating NUL.
const MAX_SOCKET_PATH: usize = 103;
const SOCKET_NAME: &str = "bazhen.sock";

/// What the socket's place is resolved from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Inputs {
    /// Over the homes when it isn't empty; a `--home` naming another socket is refused.
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

/// Where the socket's inputs name no daemon, or two.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Refused {
    /// A home that isn't an absolute path, which names no instance.
    RelativeHome(String),
    /// A `BAZHEN_SOCKET` no daemon would have set: not absolute, not UTF-8, or holding a control
    /// character.
    BadSocket(String),
    /// `--home` names another daemon than the one `BAZHEN_SOCKET` does. Taking either would act
    /// on a daemon someone didn't mean: the home's, or the one hosting the shell they typed in.
    Conflict { socket: String, home: String },
}

impl std::fmt::Display for Refused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::RelativeHome(home) => {
                write!(f, "BAZHEN_HOME must be an absolute path, not {home}")
            }
            Self::BadSocket(socket) => write!(
                f,
                "BAZHEN_SOCKET must be an absolute path, not \"{}\"",
                socket.escape_debug()
            ),
            Self::Conflict { socket, home } => write!(
                f,
                "--home {home} names another daemon than BAZHEN_SOCKET {socket}; run with \
                 BAZHEN_SOCKET= to use --home"
            ),
        }
    }
}

/// The socket a verb reaches.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Socket {
    pub(crate) path: String,
    /// Whether it is `BAZHEN_SOCKET`'s, so a daemon not answering is the caller's own.
    pub(crate) from_env: bool,
}

/// The socket a verb reaches, `same` saying whether two paths are one socket. A home that isn't
/// absolute is refused even when `BAZHEN_SOCKET` wins: the command line is wrong either way.
pub(crate) fn socket(i: &Inputs, same: impl Fn(&str, &str) -> bool) -> Result<Socket, Refused> {
    let homes = home_socket(i)?;
    let Some(given) = i.bazhen_socket.as_deref().filter(|s| !s.is_empty()) else {
        return Ok(Socket {
            path: homes,
            from_env: false,
        });
    };
    if !given.starts_with('/')
        || given
            .chars()
            .any(|c| c.is_control() || c == char::REPLACEMENT_CHARACTER)
    {
        return Err(Refused::BadSocket(given.to_owned()));
    }
    if let Some(home) = i.home_flag.as_ref().filter(|_| !same(given, &homes)) {
        return Err(Refused::Conflict {
            socket: given.to_owned(),
            home: home.clone(),
        });
    }
    Ok(Socket {
        path: given.to_owned(),
        from_env: true,
    })
}

/// Whether two socket paths are one socket: the same path, or the same name in one directory
/// however it is reached, as through a symlinked home.
pub(crate) fn same_socket(a: &str, b: &str) -> bool {
    let place = |p: &str| {
        let p = Path::new(p);
        Some((p.parent()?.canonicalize().ok()?, p.file_name()?.to_owned()))
    };
    normalize(a) == normalize(b) || place(a).is_some_and(|a| place(b) == Some(a))
}

/// The socket of the home `--home` or `BAZHEN_HOME` names, else of the default one.
fn home_socket(i: &Inputs) -> Result<String, Refused> {
    let home = i.home_flag.as_ref().or(i.bazhen_home.as_ref());
    let run = match home {
        Some(home) if !home.starts_with('/') => return Err(Refused::RelativeHome(home.clone())),
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

    fn path(i: &Inputs) -> Result<String, Refused> {
        socket(i, same_socket).map(|s| s.path)
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
        assert_eq!(path(&home), Err(Refused::RelativeHome("rel".into())));
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

    const AGENTS: &str = "/b/run/bazhen.sock";

    fn agents() -> Inputs {
        Inputs {
            bazhen_socket: Some(AGENTS.into()),
            ..inputs()
        }
    }

    #[test]
    fn the_socket_bazhen_started_the_caller_with_wins_over_the_home_and_the_default() {
        let homed = Inputs {
            bazhen_home: Some("/h".into()),
            ..agents()
        };
        assert_eq!(
            [socket(&agents(), same_socket), socket(&homed, same_socket)],
            [AGENTS, AGENTS].map(|path| Ok(Socket {
                path: path.into(),
                from_env: true
            }))
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
            socket(&empty, same_socket),
            Ok(Socket {
                path: "/h/run/bazhen.sock".into(),
                from_env: false
            })
        );
    }

    #[test]
    fn refuses_a_flag_naming_another_socket_than_bazhen_socket_and_takes_one_naming_it() {
        let flagged = |home: &str| Inputs {
            home_flag: Some(home.into()),
            ..agents()
        };
        assert_eq!(
            [path(&flagged("/f")), path(&flagged("/b/"))],
            [
                Err(Refused::Conflict {
                    socket: AGENTS.into(),
                    home: "/f".into()
                }),
                Ok(AGENTS.into())
            ]
        );
        assert_eq!(
            socket(&flagged("/f"), |_, _| true).map(|s| s.path),
            Ok(AGENTS.into())
        );
    }

    #[test]
    fn refuses_a_bazhen_socket_no_daemon_would_set() {
        let bad = [
            "run/bazhen.sock",
            " /b/run/bazhen.sock",
            "/b/run/bazhen.sock\n",
            "/b/run/\u{FFFD}.sock",
        ];
        assert_eq!(
            bad.map(|socket| path(&Inputs {
                bazhen_socket: Some(socket.into()),
                ..inputs()
            })),
            bad.map(|socket| Err(Refused::BadSocket(socket.into())))
        );
        assert_eq!(
            Refused::BadSocket("/b\n".into()).to_string(),
            "BAZHEN_SOCKET must be an absolute path, not \"/b\\n\""
        );
    }

    #[test]
    fn refuses_a_home_that_isnt_absolute_whatever_bazhen_socket_says() {
        let relative = Inputs {
            bazhen_home: Some("rel".into()),
            ..agents()
        };
        assert_eq!(path(&relative), Err(Refused::RelativeHome("rel".into())));
    }

    #[test]
    fn one_socket_is_the_same_by_its_path_or_its_directory_however_reached() {
        let root = std::env::temp_dir().join(format!("bazhen-paths-{}", std::process::id()));
        let run = root.join("run");
        let linked = root.join("linked");
        std::fs::create_dir_all(&run).unwrap();
        std::os::unix::fs::symlink(&run, &linked).unwrap();
        let at = |dir: &Path, name: &str| dir.join(name).display().to_string();
        let answers = [
            same_socket(&at(&run, "bazhen.sock"), &at(&linked, "bazhen.sock")),
            same_socket("/nowhere/a/../run/bazhen.sock", "/nowhere/run/bazhen.sock"),
            same_socket(&at(&run, "bazhen.sock"), &at(&linked, "other.sock")),
            same_socket(&at(&run, "bazhen.sock"), "/nowhere/run/bazhen.sock"),
        ];
        std::fs::remove_dir_all(&root).unwrap();
        assert_eq!(answers, [true, true, false, false]);
    }
}
