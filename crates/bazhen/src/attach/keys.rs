//! Which keys detach an attachment: `--detach-keys`, else `attach.detach_keys` in `config.toml`,
//! else the default. The CLI reads the file itself: `--direct` runs when the daemon can't be asked.

use std::io;
use std::path::Path;

use bazhen_protocol::detach_keys::DetachKeys;
use serde::Deserialize;

const CONFIG_FILE: &str = "config.toml";

/// The keys that detach, and why they aren't the ones `config.toml` names, when it names them
/// wrongly or can't be read.
#[derive(Debug, Default, PartialEq, Eq)]
pub(super) struct Detach {
    pub(super) keys: DetachKeys,
    pub(super) passed_over: Option<String>,
}

/// As much of `config.toml` as attach reads; the daemon judges the rest.
#[derive(Deserialize, Default)]
struct ConfigFile {
    #[serde(default)]
    attach: Attach,
}

#[derive(Deserialize, Default)]
struct Attach {
    detach_keys: Option<String>,
}

/// The keys `flag` names, else those `config.toml` in `config_dir` does.
///
/// # Errors
///
/// Why `flag` names no keys.
pub(super) fn detach(flag: Option<&str>, config_dir: Option<&Path>) -> Result<Detach, String> {
    if let Some(flag) = flag {
        let keys = DetachKeys::parse(flag).map_err(|why| format!("--detach-keys: {why}"))?;
        return Ok(Detach {
            keys,
            passed_over: None,
        });
    }
    let Some(dir) = config_dir else {
        return Ok(Detach::default());
    };
    let file = dir.join(CONFIG_FILE);
    Ok(from_file(
        &file.display().to_string(),
        std::fs::read_to_string(&file),
    ))
}

/// The keys `attach.detach_keys` names in `file`, whose text is `read`. A file that can't be read,
/// or names keys wrongly, leaves the default, with why: an attach run because a broken config
/// keeps the daemon down must still attach.
fn from_file(file: &str, read: io::Result<String>) -> Detach {
    let named = match read {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("{file}: {e}")),
        Ok(text) => toml::from_str::<ConfigFile>(&text)
            .map_err(|e| format!("{file}: {}", e.message()))
            .and_then(|config| {
                config
                    .attach
                    .detach_keys
                    .map(|keys| {
                        DetachKeys::parse(&keys)
                            .map_err(|why| format!("{file}: attach.detach_keys: {why}"))
                    })
                    .transpose()
            }),
    };
    match named {
        Ok(keys) => Detach {
            keys: keys.unwrap_or_default(),
            passed_over: None,
        },
        Err(why) => Detach {
            keys: DetachKeys::default(),
            passed_over: Some(why),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::TERMINALS_USAGE;

    #[test]
    fn the_usage_names_the_default_keys() {
        let said = format!("attach: {} detaches", DetachKeys::default());
        assert!(TERMINALS_USAGE.contains(&said), "{TERMINALS_USAGE}");
    }

    fn keys(text: &str) -> DetachKeys {
        DetachKeys::parse(text).unwrap()
    }

    #[test]
    fn takes_the_flag_and_refuses_one_that_names_no_keys() {
        assert_eq!(
            [
                detach(Some("ctrl-p,ctrl-q"), None),
                detach(Some("ctrl-[,x"), None),
            ],
            [
                Ok(Detach {
                    keys: keys("ctrl-p,ctrl-q"),
                    passed_over: None
                }),
                Err(
                    "--detach-keys: can't start with ctrl-[: that is Escape, which every arrow \
                     key starts with"
                        .to_owned()
                ),
            ]
        );
    }

    #[test]
    fn reads_attach_detach_keys_from_the_file_and_nothing_else_there() {
        let text = "[daemon]\nport = 7901\n\n[attach]\ndetach_keys = \"ctrl-p,ctrl-q\"\n";
        assert_eq!(
            [
                from_file("/c/config.toml", Ok(text.to_owned())),
                from_file("/c/config.toml", Ok("[daemon]\nport = 7901\n".to_owned())),
                from_file("/c/config.toml", Err(io::ErrorKind::NotFound.into())),
            ],
            [
                Detach {
                    keys: keys("ctrl-p,ctrl-q"),
                    passed_over: None
                },
                Detach::default(),
                Detach::default(),
            ]
        );
    }

    #[test]
    fn falls_back_to_the_default_saying_why_when_the_file_is_wrong() {
        let wrong = |read: io::Result<String>| {
            let detach = from_file("/c/config.toml", read);
            (detach.keys == DetachKeys::default(), detach.passed_over)
        };
        let why = |text: &str| Some(text.to_owned());
        assert_eq!(
            [
                wrong(Ok("[attach]\ndetach_keys = \"ctrl-[\"\n".to_owned())),
                wrong(Ok("[attach]\ndetach_keys = 3\n".to_owned())),
                wrong(Err(io::ErrorKind::PermissionDenied.into())),
            ],
            [
                (
                    true,
                    why(
                        "/c/config.toml: attach.detach_keys: can't start with ctrl-[: that is \
                         Escape, which every arrow key starts with"
                    )
                ),
                (
                    true,
                    why("/c/config.toml: invalid type: integer `3`, expected a string")
                ),
                (true, why("/c/config.toml: permission denied")),
            ]
        );
    }
}
