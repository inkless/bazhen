//! The cargo configs outside the repository a gate refuses to run under. A config can set what the
//! gate can't override from the command line: a runner that stands in for the test binaries, a
//! rustdoc or a linker, environment variables for the tools (`[env]`, which can hand clippy
//! `--cap-lints`), a profile (which can turn off overflow checks and debug assertions in the tests),
//! or another config file to read (`include`), which this check wouldn't. Rustflags, rustc and the
//! wrappers the gate overrides itself, so a wrapper such as sccache is fine. Each key is matched in
//! any TOML spelling: under a table, dotted, quoted or inline.

use std::path::{Path, PathBuf};

/// The cargo configs cargo would read for a run in `dir` from outside the repository: one in each
/// parent directory, and one in `cargo_home`.
pub(crate) fn outside_configs(dir: &Path, cargo_home: &Path) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = dir.ancestors().skip(1).map(|d| d.join(".cargo")).collect();
    dirs.push(cargo_home.to_path_buf());
    let mut seen = Vec::new();
    for d in dirs {
        if !seen.contains(&d) {
            seen.push(d);
        }
    }
    seen.iter()
        .flat_map(|d| [d.join("config"), d.join("config.toml")])
        .collect()
}

/// A config's text, or why it couldn't be read; `None` when there is none.
pub(crate) type Read<'a> = &'a dyn Fn(&Path) -> Result<Option<String>, String>;

/// Why each config in `paths` could change what a gate runs. One that is there but can't be read
/// is refused too: a check that can't see a file can't vouch for it.
pub(crate) fn config_failures(paths: &[PathBuf], read: Read<'_>) -> Vec<String> {
    paths
        .iter()
        .filter_map(|path| match read(path) {
            Ok(None) => None,
            Ok(Some(text)) if !is_unsafe(&without_comments(&text)) => None,
            Ok(Some(_)) => Some(format!(
                "{} sets a test runner, a rustdoc, a linker, [env], a profile or include, which \
                 the Rust gates can't override and which could change what they run. Remove it, \
                 or move it out of this repository's parent directories.",
                path.display()
            )),
            Err(why) => Some(format!(
                "{} can't be read ({why}), so the Rust gates can't tell whether it changes what \
                 they run.",
                path.display()
            )),
        })
        .collect()
}

/// The text with each comment dropped: a `#` at the start of a line or after whitespace, to the
/// end of its line, with the whitespace before it.
fn without_comments(text: &str) -> String {
    text.split('\n')
        .map(|line| {
            let chars: Vec<(usize, char)> = line.char_indices().collect();
            let mut end = line.len();
            for (n, &(at, c)) in chars.iter().enumerate() {
                if c != '#' {
                    continue;
                }
                let before = n.checked_sub(1).and_then(|p| chars.get(p));
                match before {
                    None => end = at,
                    Some(&(ws, w)) if w.is_whitespace() => end = ws,
                    Some(_) => continue,
                }
                break;
            }
            line.get(..end).unwrap_or(line)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

const SET_ANYWHERE: [&str; 4] = ["runner", "rustdoc", "include", "linker"];
const TABLES: [&str; 2] = ["env", "profile"];

fn is_quote(c: char) -> bool {
    c == '"' || c == '\''
}

/// Whether the config, comments dropped, sets any key the gate refuses.
fn is_unsafe(code: &str) -> bool {
    let chars: Vec<char> = code.chars().collect();
    let at = |i: usize| chars.get(i).copied();
    let starts_line = |i: usize| i == 0 || at(i - 1) == Some('\n');
    // Past an optional quote and any whitespace from `i`, the character there.
    let after = |mut i: usize| {
        if at(i).is_some_and(is_quote) {
            i += 1;
        }
        while at(i).is_some_and(char::is_whitespace) {
            i += 1;
        }
        at(i)
    };
    let words = |list: &[&str]| -> Vec<(usize, usize)> {
        let mut found = Vec::new();
        for start in 0..chars.len() {
            for word in list {
                let len = word.chars().count();
                if chars
                    .get(start..start + len)
                    .is_some_and(|w| w.iter().copied().eq(word.chars()))
                {
                    found.push((start, start + len));
                }
            }
        }
        found
    };
    // `runner =`, `.runner =`, `"runner" =`, `{ runner =`: the key set, in any spelling.
    let set = words(&SET_ANYWHERE).into_iter().any(|(start, end)| {
        let led = starts_line(start)
            || at(start - 1).is_some_and(|c| c.is_whitespace() || ".{,\"'".contains(c));
        led && after(end) == Some('=')
    });
    let table = words(&TABLES).into_iter().any(|(start, end)| {
        // `[env]`, `[profile.test]`, `[ "env" ]`: a header naming the table, alone on its line.
        let mut open = start;
        if open > 0 && at(open - 1).is_some_and(is_quote) {
            open -= 1;
        }
        while open > 0 && at(open - 1).is_some_and(char::is_whitespace) {
            open -= 1;
        }
        let header = open > 0
            && at(open - 1) == Some('[')
            && {
                let mut line = open - 1;
                while line > 0 && at(line - 1).is_some_and(|c| c.is_whitespace() && c != '\n') {
                    line -= 1;
                }
                starts_line(line)
                    || chars
                        .get(..line)
                        .is_some_and(|b| b.iter().all(|c| c.is_whitespace()))
            }
            && matches!(after(end), Some(']' | '.'));
        // `env.X =`, `profile.dev.x =`, `{ env = …`: the table, dotted or inline.
        let mut lead = start;
        if lead > 0 && at(lead - 1).is_some_and(is_quote) {
            lead -= 1;
        }
        let keyed = (starts_line(lead)
            || at(lead.wrapping_sub(1)).is_some_and(|c| c.is_whitespace() || "{,".contains(c)))
            && matches!(after(end), Some('.' | '='));
        header || keyed
    });
    set || table
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use proptest::prelude::*;

    use super::*;

    #[test]
    fn lists_each_parent_directorys_config_and_cargo_homes_not_the_repositorys_own() {
        let got = outside_configs(Path::new("/a/b/repo/"), Path::new("/home/u/.cargo"));
        let want = [
            "/a/b/.cargo/config",
            "/a/b/.cargo/config.toml",
            "/a/.cargo/config",
            "/a/.cargo/config.toml",
            "/.cargo/config",
            "/.cargo/config.toml",
            "/home/u/.cargo/config",
            "/home/u/.cargo/config.toml",
        ];
        assert_eq!(got, want.map(PathBuf::from));
    }

    #[test]
    fn lists_cargo_home_once_when_it_is_a_parents_config_dir() {
        let got = outside_configs(Path::new("/a/repo"), Path::new("/a/.cargo"));
        assert_eq!(
            got,
            [
                "/a/.cargo/config",
                "/a/.cargo/config.toml",
                "/.cargo/config",
                "/.cargo/config.toml"
            ]
            .map(PathBuf::from)
        );
    }

    const REFUSED: [(&str, &str); 12] = [
        (
            "/a/.cargo/config.toml",
            "[target.x86_64-unknown-linux-gnu]\nrunner = \"true\"\n",
        ),
        (
            "/b/.cargo/config",
            "target.x86_64-unknown-linux-gnu.runner = \"true\"\n",
        ),
        (
            "/c/.cargo/config.toml",
            "[target.'cfg(unix)']\n\"runner\" = [\"true\"]\n",
        ),
        (
            "/d/.cargo/config.toml",
            "target = { x86_64-unknown-linux-gnu = { runner = \"true\" } }\n",
        ),
        (
            "/e/.cargo/config.toml",
            "[build]\nrustdoc = \"/fake/rustdoc\"\n",
        ),
        (
            "/f/.cargo/config.toml",
            "[env]\nCLIPPY_ARGS = { value = \"--cap-lints=allow\", force = true }\n",
        ),
        (
            "/g/.cargo/config.toml",
            "env.CLIPPY_ARGS = \"--cap-lints=allow\"\n",
        ),
        (
            "/i/.cargo/config.toml",
            "[env.CLIPPY_ARGS]\nvalue = \"--cap-lints=allow\"\nforce = true\n",
        ),
        (
            "/j/.cargo/config.toml",
            "include = [\"/elsewhere/more.toml\"]\n",
        ),
        (
            "/k/.cargo/config.toml",
            "[target.x86_64-unknown-linux-gnu]\nlinker = \"/fake/cc\"\n",
        ),
        (
            "/l/.cargo/config.toml",
            "[profile.test]\noverflow-checks = false\n",
        ),
        (
            "/m/.cargo/config.toml",
            "profile.dev.debug-assertions = false\n",
        ),
    ];

    const ACCEPTED: [(&str, &str); 3] = [
        (
            "/h/.cargo/config.toml",
            "[build]\nrustc-wrapper = \"/usr/bin/sccache\"\n",
        ),
        (
            "/home/u/.cargo/config.toml",
            "# runner = \"true\" is off\n[net]\ngit-fetch-with-cli = true # no runner = x\n\
             [build]\njobs = 4\nrustc = \"x\"\n",
        ),
        (
            "/n/.cargo/config.toml",
            "[environment]\nmyenv = 1\nprofiles = 2\nrunners = 3\n[alias]\nb = \"build\"\n",
        ),
    ];

    fn failures_for(configs: &BTreeMap<&str, &str>, paths: &[&str]) -> Vec<String> {
        let read = |p: &Path| Ok(configs.get(p.to_str().unwrap()).map(|t| (*t).to_owned()));
        let paths: Vec<PathBuf> = paths.iter().map(PathBuf::from).collect();
        config_failures(&paths, &read)
    }

    #[test]
    fn names_a_config_with_a_runner_rustdoc_linker_env_profile_or_include_in_any_spelling() {
        let configs: BTreeMap<&str, &str> = REFUSED.into_iter().chain(ACCEPTED).collect();
        let mut paths: Vec<&str> = REFUSED.iter().chain(&ACCEPTED).map(|(p, _)| *p).collect();
        paths.push("/missing/.cargo/config.toml");
        let named: Vec<String> = failures_for(&configs, &paths)
            .iter()
            .map(|f| f.split(' ').next().unwrap().to_owned())
            .collect();
        assert_eq!(named, REFUSED.map(|(p, _)| p.to_owned()));
    }

    #[test]
    fn refuses_a_config_that_is_there_but_cant_be_read() {
        let read = |_: &Path| Err("permission denied".to_owned());
        let failures = config_failures(&[PathBuf::from("/x/.cargo/config.toml")], &read);
        assert_eq!(failures.len(), 1);
        assert!(failures[0].starts_with("/x/.cargo/config.toml can't be read (permission denied)"));
    }

    proptest! {
        // A config is any text cargo finds: whatever comes before a refused key, on lines of its
        // own, can't hide it, and no text makes the check panic.
        #[test]
        fn a_refused_key_stays_refused_whatever_text_comes_before_it(
            noise in any::<String>(),
            sample in 0..REFUSED.len(),
        ) {
            let text = format!("{noise}\n{}", REFUSED[sample].1);
            prop_assert!(is_unsafe(&without_comments(&text)), "{text:?}");
            let _ = is_unsafe(&without_comments(&noise));
        }
    }
}
