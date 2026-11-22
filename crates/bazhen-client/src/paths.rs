//! Where a Bazhen home keeps everything, as the TypeScript daemon puts it
//! (`apps/daemon/src/config/paths.ts`): one XDG layout on macOS and Linux, each location from a
//! flag, then the environment, then the config file, then the default. The CLI finds the daemon's
//! socket with it, and the Rust daemon puts it there.

use std::fmt;
use std::path::{Path, PathBuf};

use crate::sha256::{hex, sha256};

/// `sun_path` holds 104 bytes, including the terminating NUL.
const MAX_SOCKET_PATH: usize = 103;
const SOCKET_NAME: &str = "bazhen.sock";

/// What the locations are resolved from.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Inputs {
    /// `--home`, over `BAZHEN_HOME`.
    pub home_flag: Option<String>,
    pub bazhen_home: Option<String>,
    pub bazhen_bank: Option<String>,
    /// `bank.path` from the config file, under `BAZHEN_BANK`.
    pub config_bank: Option<String>,
    pub xdg_config_home: Option<String>,
    pub xdg_data_home: Option<String>,
    pub xdg_state_home: Option<String>,
    pub xdg_cache_home: Option<String>,
    pub xdg_runtime_dir: Option<String>,
    /// The user's home directory.
    pub home: String,
    /// The temporary directory, as Node's `os.tmpdir()` finds it.
    pub tmp: String,
    pub uid: u32,
    pub macos: bool,
}

impl Inputs {
    /// This process's inputs, read from its environment, for the user `uid`.
    pub fn current(home_flag: Option<&str>, uid: u32) -> Self {
        let var = |name: &str| std::env::var(name).ok();
        Self {
            home_flag: home_flag.map(str::to_owned),
            bazhen_home: var("BAZHEN_HOME"),
            bazhen_bank: var("BAZHEN_BANK"),
            config_bank: None,
            xdg_config_home: var("XDG_CONFIG_HOME"),
            xdg_data_home: var("XDG_DATA_HOME"),
            xdg_state_home: var("XDG_STATE_HOME"),
            xdg_cache_home: var("XDG_CACHE_HOME"),
            xdg_runtime_dir: var("XDG_RUNTIME_DIR"),
            home: node_homedir(var("HOME"), std::env::home_dir),
            tmp: node_tmpdir(var),
            uid,
            macos: std::env::consts::OS == "macos",
        }
    }
}

/// `os.homedir()`: `HOME` whenever it is set, empty too, which a home then refuses as relative;
/// the password database's only when it isn't. std's `home_dir` would take the database's for an
/// empty `HOME`, and so reach another home than the TypeScript daemon does.
fn node_homedir(home: Option<String>, passwd: impl FnOnce() -> Option<PathBuf>) -> String {
    home.unwrap_or_else(|| {
        passwd().map_or_else(|| "/".to_owned(), |h| h.to_string_lossy().into_owned())
    })
}

/// `os.tmpdir()`: the first of `TMPDIR`, `TMP` and `TEMP` that is set, less a trailing `/`.
fn node_tmpdir(var: impl Fn(&str) -> Option<String>) -> String {
    ["TMPDIR", "TMP", "TEMP"]
        .iter()
        .find_map(|name| var(name).filter(|v| !v.is_empty()))
        .map_or_else(
            || "/tmp".to_owned(),
            |t| {
                let trimmed = t.trim_end_matches('/');
                if trimmed.is_empty() {
                    "/".to_owned()
                } else {
                    trimmed.to_owned()
                }
            },
        )
}

/// Every place a home has.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Paths {
    pub config: String,
    pub data: String,
    pub bank: String,
    pub state: String,
    pub cache: String,
    /// Holds the daemon's Unix socket; mode 0700.
    pub run: String,
    pub socket: String,
}

/// A home, or the user's home directory, that isn't an absolute path: it would name another
/// instance from each directory a command ran in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelativeHome {
    /// The variable that names it: `BAZHEN_HOME`, for `--home` too, or `HOME`.
    pub name: &'static str,
    pub path: String,
}

impl fmt::Display for RelativeHome {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{} must be an absolute path, not {}",
            self.name, self.path
        )
    }
}

impl std::error::Error for RelativeHome {}

/// Every place the home `i` names has.
///
/// # Errors
///
/// [`RelativeHome`] when `--home` or `BAZHEN_HOME` isn't an absolute path, or, without either,
/// the user's home directory isn't.
pub fn resolve(i: &Inputs) -> Result<Paths, RelativeHome> {
    let home = i.home_flag.as_ref().or(i.bazhen_home.as_ref());
    let relative = |name, path: &str| RelativeHome {
        name,
        path: path.to_owned(),
    };
    let [config, data, state, cache, run] = match home {
        Some(home) if !home.starts_with('/') => return Err(relative("BAZHEN_HOME", home)),
        Some(home) => ["config", "data", "state", "cache", "run"]
            .map(|dir| normalize(&format!("{home}/{dir}"))),
        None if !i.home.starts_with('/') => return Err(relative("HOME", &i.home)),
        None => {
            let xdg = |var: &Option<String>, fallback: &str| {
                let base = var
                    .as_deref()
                    .filter(|v| v.starts_with('/'))
                    .map_or_else(|| format!("{}/{fallback}", i.home), str::to_owned);
                normalize(&format!("{base}/bazhen"))
            };
            [
                xdg(&i.xdg_config_home, ".config"),
                xdg(&i.xdg_data_home, ".local/share"),
                xdg(&i.xdg_state_home, ".local/state"),
                xdg(&i.xdg_cache_home, ".cache"),
                default_run(i),
            ]
        }
    };
    let run = if format!("{run}/{SOCKET_NAME}").len() > MAX_SOCKET_PATH {
        format!("/tmp/bazhen-{}-{}", i.uid, short_hash(&run))
    } else {
        run
    };
    let bank = i
        .bazhen_bank
        .clone()
        .or_else(|| i.config_bank.clone())
        .unwrap_or_else(|| format!("{data}/bank"));
    Ok(Paths {
        socket: format!("{run}/{SOCKET_NAME}"),
        config,
        data,
        bank,
        state,
        cache,
        run,
    })
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

/// The start-up lock file for the daemon on `socket`, beside it. It is never removed: a daemon that
/// removed it could let a second one lock a fresh file while a third still holds the old one.
pub fn lock_of(socket: &Path) -> PathBuf {
    let mut path = socket.as_os_str().to_owned();
    path.push(".lock");
    PathBuf::from(path)
}

/// The directory containing terminal holder sockets for the daemon with this runtime directory,
/// as resolved by the TypeScript daemon in `apps/daemon/src/config/paths.ts`, which hashes the
/// normalised path: `run` is normalised the same way, whatever its spelling.
pub fn holders_dir(run: &Path, uid: u32) -> PathBuf {
    let Some(run) = run.to_str().map(normalize) else {
        return run.join("holders");
    };
    let holders = Path::new(&run).join("holders");
    let sample = holders.join("term_00000000000000000000000000000000.sock");
    if sample.as_os_str().len() > MAX_SOCKET_PATH {
        PathBuf::from(format!(
            "/tmp/bazhen-holders-{uid}-{}/holders",
            short_hash(&run)
        ))
    } else {
        holders
    }
}

/// The first 8 hex digits of `value`'s SHA-256.
fn short_hash(value: &str) -> String {
    hex(sha256(value.as_bytes()).get(..4).unwrap_or_default())
}

/// A path as Node's `path.normalize` leaves it, without a trailing `/`: no `.`, no repeated `/`,
/// and no `..` but those leading a relative path, which it keeps relative.
pub fn normalize(path: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            // Above an absolute path's root is the root; above a relative one's start is kept.
            ".." if parts.last().is_none_or(|p| *p == "..") => {
                if !path.starts_with('/') {
                    parts.push("..");
                }
            }
            ".." => {
                parts.pop();
            }
            part => parts.push(part),
        }
    }
    let joined = parts.join("/");
    match (path.starts_with('/'), joined.is_empty()) {
        (true, _) => format!("/{joined}"),
        (false, true) => ".".to_owned(),
        (false, false) => joined,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inputs() -> Inputs {
        Inputs {
            xdg_runtime_dir: Some("/run/user/1000".into()),
            home: "/home/u".into(),
            tmp: "/var/folders/x/T".into(),
            uid: 1000,
            ..Inputs::default()
        }
    }

    fn socket(i: &Inputs) -> Result<String, RelativeHome> {
        resolve(i).map(|p| p.socket)
    }

    #[test]
    fn a_home_holds_everything_under_it_normalised_and_the_flag_wins() {
        let home = Inputs {
            bazhen_home: Some("/a/./b/../h/".into()),
            ..inputs()
        };
        let flag = Inputs {
            home_flag: Some("/f".into()),
            ..home.clone()
        };
        assert_eq!(
            resolve(&home),
            Ok(Paths {
                config: "/a/h/config".into(),
                data: "/a/h/data".into(),
                bank: "/a/h/data/bank".into(),
                state: "/a/h/state".into(),
                cache: "/a/h/cache".into(),
                run: "/a/h/run".into(),
                socket: "/a/h/run/bazhen.sock".into(),
            })
        );
        assert_eq!(socket(&flag), Ok("/f/run/bazhen.sock".into()));
    }

    #[test]
    fn refuses_a_home_that_isnt_absolute() {
        let home = Inputs {
            home_flag: Some("rel".into()),
            ..inputs()
        };
        let empty = Inputs {
            bazhen_home: Some(String::new()),
            ..inputs()
        };
        assert_eq!(
            [resolve(&home), resolve(&empty)],
            [
                Err(relative("BAZHEN_HOME", "rel")),
                Err(relative("BAZHEN_HOME", ""))
            ]
        );
        assert_eq!(
            relative("BAZHEN_HOME", "rel").to_string(),
            "BAZHEN_HOME must be an absolute path, not rel"
        );
    }

    fn relative(name: &'static str, path: &str) -> RelativeHome {
        RelativeHome {
            name,
            path: path.into(),
        }
    }

    /// The TypeScript daemon refuses it too: a relative HOME would name another instance from
    /// each directory a command ran in. A home of Bazhen's own doesn't use it.
    #[test]
    fn refuses_a_relative_users_home_unless_a_home_of_bazhens_own_is_named() {
        let rel = Inputs {
            home: "rel".into(),
            ..inputs()
        };
        let named = Inputs {
            bazhen_home: Some("/b".into()),
            ..rel.clone()
        };
        assert_eq!(
            [
                resolve(&rel).map(|p| p.data),
                resolve(&named).map(|p| p.data)
            ],
            [Err(relative("HOME", "rel")), Ok("/b/data".into())]
        );
        assert_eq!(
            relative("HOME", "rel").to_string(),
            "HOME must be an absolute path, not rel"
        );
    }

    #[test]
    fn the_users_home_is_home_when_set_even_empty_and_the_password_databases_only_when_not() {
        let passwd = || Some(PathBuf::from("/home/pw"));
        assert_eq!(
            [
                node_homedir(Some("/home/env".into()), passwd),
                node_homedir(Some(String::new()), passwd),
                node_homedir(None, passwd),
                node_homedir(None, || None),
            ],
            ["/home/env", "", "/home/pw", "/"]
        );
        let empty = Inputs {
            home: node_homedir(Some(String::new()), passwd),
            ..inputs()
        };
        assert_eq!(resolve(&empty).map(|p| p.data), Err(relative("HOME", "")));
    }

    #[test]
    fn normalises_a_path_and_keeps_a_relative_one_relative() {
        assert_eq!(
            ["/a/./b/../c/", "/../a", "a/./b/../c", "../a/..", "a/..", ""].map(normalize),
            ["/a/c", "/a", "a/c", "..", ".", "."]
        );
    }

    #[test]
    fn with_no_home_each_place_is_its_xdg_directorys_or_under_the_users_home() {
        let set = Inputs {
            xdg_config_home: Some("/c".into()),
            xdg_data_home: Some("/d/".into()),
            xdg_state_home: Some("/s".into()),
            xdg_cache_home: Some("/k".into()),
            ..inputs()
        };
        let relative = Inputs {
            xdg_config_home: Some("c".into()),
            xdg_data_home: Some("d".into()),
            xdg_state_home: Some("s".into()),
            xdg_cache_home: Some("k".into()),
            ..inputs()
        };
        let places = |p: Paths| [p.config, p.data, p.state, p.cache, p.bank];
        assert_eq!(
            resolve(&set).map(places),
            Ok([
                "/c/bazhen",
                "/d/bazhen",
                "/s/bazhen",
                "/k/bazhen",
                "/d/bazhen/bank"
            ]
            .map(String::from))
        );
        assert_eq!(
            resolve(&relative).map(places),
            Ok([
                "/home/u/.config/bazhen",
                "/home/u/.local/share/bazhen",
                "/home/u/.local/state/bazhen",
                "/home/u/.cache/bazhen",
                "/home/u/.local/share/bazhen/bank"
            ]
            .map(String::from))
        );
    }

    #[test]
    fn the_bank_is_bazhen_bank_then_the_configs_then_the_datas() {
        let configured = Inputs {
            config_bank: Some("/cfg/bank".into()),
            bazhen_home: Some("/h".into()),
            ..inputs()
        };
        let both = Inputs {
            bazhen_bank: Some("/env/bank".into()),
            ..configured.clone()
        };
        assert_eq!(
            [resolve(&both), resolve(&configured)].map(|p| p.map(|p| p.bank)),
            [Ok("/env/bank".into()), Ok("/cfg/bank".into())]
        );
    }

    #[test]
    fn with_no_home_the_run_dir_is_the_runtime_dirs_or_the_users_under_tmp_or_macos_tmp() {
        let relative = Inputs {
            xdg_runtime_dir: Some("run".into()),
            ..inputs()
        };
        let mac = Inputs {
            macos: true,
            ..inputs()
        };
        assert_eq!(
            [socket(&inputs()), socket(&relative), socket(&mac)],
            [
                "/run/user/1000/bazhen/bazhen.sock",
                "/tmp/bazhen-1000/bazhen.sock",
                "/var/folders/x/T/bazhen/bazhen.sock"
            ]
            .map(|s| Ok(s.into()))
        );
    }

    #[test]
    fn a_socket_path_too_long_moves_the_run_dir_to_a_short_hashed_one() {
        let long = format!("/{}", "h".repeat(100));
        let home = Inputs {
            bazhen_home: Some(long.clone()),
            ..inputs()
        };
        let hash = short_hash(&format!("{long}/run"));
        assert_eq!(hash.len(), 8);
        assert_eq!(
            resolve(&home).map(|p| [p.run, p.socket]),
            Ok([
                format!("/tmp/bazhen-1000-{hash}"),
                format!("/tmp/bazhen-1000-{hash}/bazhen.sock")
            ])
        );
    }

    #[test]
    fn a_holder_socket_path_too_long_moves_only_the_holders() {
        let run = format!("/var/folders/xy/{}/T/bazhen", "d".repeat(30));
        let at_limit = format!("/var/folders/xy/{}/T/bazhen", "d".repeat(27));
        assert_eq!(
            holders_dir(Path::new(&run), 501),
            PathBuf::from("/tmp/bazhen-holders-501-a71017ba/holders")
        );
        assert_eq!(
            holders_dir(Path::new(&at_limit), 501),
            Path::new(&at_limit).join("holders")
        );
    }

    #[test]
    fn the_holders_move_at_a_104_byte_socket_path_and_not_at_103() {
        let sample = "/holders/term_00000000000000000000000000000000.sock";
        let fits = format!("/{}", "a".repeat(51));
        let over = format!("/{}", "a".repeat(52));
        assert_eq!(fits.len() + sample.len(), 103);
        assert_eq!(over.len() + sample.len(), 104);
        assert_eq!(
            holders_dir(Path::new(&fits), 1000),
            Path::new(&fits).join("holders")
        );
        assert!(
            holders_dir(Path::new(&over), 1000)
                .to_string_lossy()
                .starts_with("/tmp/bazhen-holders-1000-"),
            "a run directory one byte over moves the holders"
        );
    }

    #[test]
    fn the_holders_directory_for_a_long_linux_runtime_directory_is_pinned() {
        let run = format!("/run/user/1000/{}/bazhen", "d".repeat(38));
        assert_eq!(
            holders_dir(Path::new(&run), 1000),
            PathBuf::from("/tmp/bazhen-holders-1000-d76ecabd/holders")
        );
    }

    #[test]
    fn a_run_directory_spelled_unnormalised_names_the_same_holders_as_the_daemons() {
        let run = format!("/run/user/1000/{}/bazhen", "d".repeat(38));
        let spelled = format!("/run/./user//1000/x/../{}/bazhen/", "d".repeat(38));
        assert_eq!(
            holders_dir(Path::new(&spelled), 1000),
            holders_dir(Path::new(&run), 1000)
        );
        let short = holders_dir(Path::new("/r/./run/"), 1000);
        assert_eq!(short, Path::new("/r/run/holders"));
    }

    #[test]
    fn the_lock_file_sits_beside_the_socket() {
        assert_eq!(
            lock_of(Path::new("/h/run/bazhen.sock")),
            PathBuf::from("/h/run/bazhen.sock.lock")
        );
    }

    #[test]
    fn tmpdir_is_the_first_variable_set_less_its_trailing_slash() {
        let env = |vars: &'static [(&'static str, &'static str)]| {
            move |name: &str| {
                vars.iter()
                    .find(|(n, _)| *n == name)
                    .map(|(_, v)| (*v).to_owned())
            }
        };
        assert_eq!(
            [
                node_tmpdir(env(&[("TMP", "/t/"), ("TEMP", "/e")])),
                node_tmpdir(env(&[("TMPDIR", ""), ("TEMP", "/e")])),
                node_tmpdir(env(&[("TMPDIR", "/")])),
                node_tmpdir(env(&[])),
            ],
            ["/t", "/e", "/", "/tmp"]
        );
    }
}
