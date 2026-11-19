//! Which daemon's socket a verb reaches. Inside anything Bazhen started, that is the one
//! `BAZHEN_SOCKET` names: the daemon that started it, the only one its agent id and token mean
//! anything to, wherever its home is. Elsewhere it is the home's own socket, where the daemon puts
//! it (`bazhen_client::paths`).

use std::path::Path;

use bazhen_client::paths::{self, RelativeHome, normalize};

/// What the socket's place is resolved from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Inputs {
    /// Over the homes when it isn't empty; a `--home` naming another socket is refused.
    pub(crate) bazhen_socket: Option<String>,
    pub(crate) paths: paths::Inputs,
}

/// Where the socket's inputs name no daemon, or two.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Refused {
    /// A home that isn't an absolute path, which names no instance.
    RelativeHome(RelativeHome),
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
            Self::RelativeHome(home) => home.fmt(f),
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
    let homes = paths::resolve(&i.paths)
        .map_err(Refused::RelativeHome)?
        .socket;
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
    if let Some(home) = i.paths.home_flag.as_ref().filter(|_| !same(given, &homes)) {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn inputs() -> Inputs {
        Inputs {
            bazhen_socket: None,
            paths: paths::Inputs {
                xdg_runtime_dir: Some("/run/user/1000".into()),
                home: "/home/u".into(),
                tmp: "/tmp".into(),
                uid: 1000,
                ..paths::Inputs::default()
            },
        }
    }

    fn path(i: &Inputs) -> Result<String, Refused> {
        socket(i, same_socket).map(|s| s.path)
    }

    fn homed(home_flag: Option<&str>, bazhen_home: Option<&str>, i: Inputs) -> Inputs {
        Inputs {
            paths: paths::Inputs {
                home_flag: home_flag.map(str::to_owned),
                bazhen_home: bazhen_home.map(str::to_owned),
                ..i.paths
            },
            ..i
        }
    }

    #[test]
    fn with_no_bazhen_socket_it_is_the_homes_socket() {
        assert_eq!(
            socket(&homed(None, Some("/h"), inputs()), same_socket),
            Ok(Socket {
                path: "/h/run/bazhen.sock".into(),
                from_env: false
            })
        );
    }

    #[test]
    fn refuses_a_home_that_isnt_absolute() {
        assert_eq!(
            path(&homed(Some("rel"), None, inputs())),
            Err(Refused::RelativeHome(RelativeHome {
                name: "BAZHEN_HOME",
                path: "rel".into()
            }))
        );
        assert_eq!(
            Refused::RelativeHome(RelativeHome {
                name: "BAZHEN_HOME",
                path: "rel".into()
            })
            .to_string(),
            "BAZHEN_HOME must be an absolute path, not rel"
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
        let homed = homed(None, Some("/h"), agents());
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
        let empty = homed(
            None,
            Some("/h"),
            Inputs {
                bazhen_socket: Some(String::new()),
                ..inputs()
            },
        );
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
        let flagged = |home: &str| homed(Some(home), None, agents());
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
        assert_eq!(
            path(&homed(None, Some("rel"), agents())),
            Err(Refused::RelativeHome(RelativeHome {
                name: "BAZHEN_HOME",
                path: "rel".into()
            }))
        );
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
