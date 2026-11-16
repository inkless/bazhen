//! Where the daemon's socket is, as the daemon itself resolves it (apps/daemon/src/config/paths.ts):
//! one XDG layout on macOS and Linux, each place from a flag, then the environment, then the
//! default.

use crate::sha256::{hex, sha256};

/// `sun_path` holds 104 bytes, including the terminating NUL.
const MAX_SOCKET_PATH: usize = 103;
const SOCKET_NAME: &str = "bazhen.sock";

/// What the socket's place is resolved from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Inputs {
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

/// The daemon's socket.
pub(crate) fn socket(i: &Inputs) -> Result<String, RelativeHome> {
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
            home_flag: None,
            bazhen_home: None,
            xdg_runtime_dir: Some("/run/user/1000".into()),
            tmp: "/var/folders/x/T".into(),
            uid: 1000,
            macos: false,
        }
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
        assert_eq!(socket(&home), Ok("/a/h/run/bazhen.sock".into()));
        assert_eq!(socket(&flag), Ok("/f/run/bazhen.sock".into()));
    }

    #[test]
    fn refuses_a_home_that_isnt_absolute() {
        let home = Inputs {
            home_flag: Some("rel".into()),
            ..inputs()
        };
        assert_eq!(socket(&home), Err(RelativeHome("rel".into())));
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
            socket(&inputs()),
            Ok("/run/user/1000/bazhen/bazhen.sock".into())
        );
        assert_eq!(socket(&relative), Ok("/tmp/bazhen-1000/bazhen.sock".into()));
        assert_eq!(
            socket(&mac),
            Ok("/var/folders/x/T/bazhen/bazhen.sock".into())
        );
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
            socket(&home),
            Ok(format!("/tmp/bazhen-1000-{hash}/bazhen.sock"))
        );
    }
}
