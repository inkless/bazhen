//! The cargo configs outside the repository a gate refuses to run under. A config can set what the
//! gate can't override from the command line: a runner that stands in for the test binaries or
//! for xtask itself, a rustdoc or a linker, environment variables (`[env]`, which can hand clippy
//! `--cap-lints` or put another `cargo-fmt` first on PATH), a profile (which can turn off overflow
//! checks and debug assertions in the tests), or another config file to read (`include`), which
//! this check wouldn't. Rustflags, rustc and the wrappers the gate overrides itself, so a wrapper
//! such as sccache is fine. A config is parsed as TOML and each key read as cargo reads it, quoted,
//! escaped, dotted or inline; one that doesn't parse is refused, as cargo's reading of it can't be
//! vouched for.

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
            Ok(Some(text)) => refusal(&text).map(|why| {
                format!(
                    "{} {why}, which the Rust gates can't override and which could change what \
                     they run. Remove it, or move it out of this repository's parent directories.",
                    path.display()
                )
            }),
            Err(why) => Some(format!(
                "{} can't be read ({why}), so the Rust gates can't tell whether it changes what \
                 they run.",
                path.display()
            )),
        })
        .collect()
}

/// The keys a gate refuses wherever a config sets them.
const REFUSED_KEYS: [&str; 6] = ["runner", "rustdoc", "linker", "include", "env", "profile"];

/// Why a config's text could change what a gate runs, if it could.
fn refusal(text: &str) -> Option<&'static str> {
    match text.parse::<toml::Table>() {
        Err(_) => Some("isn't TOML that cargo's reading of could be vouched for"),
        Ok(table) => sets_refused_key(&table)
            .then_some("sets a test runner, a rustdoc, a linker, [env], a profile or include"),
    }
}

/// Whether `table`, or any table within it, sets a key the gate refuses.
fn sets_refused_key(table: &toml::Table) -> bool {
    table
        .iter()
        .any(|(key, value)| REFUSED_KEYS.contains(&key.as_str()) || within(value))
}

fn within(value: &toml::Value) -> bool {
    match value {
        toml::Value::Table(table) => sets_refused_key(table),
        toml::Value::Array(items) => items.iter().any(within),
        _ => false,
    }
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

    const REFUSED: [(&str, &str); 17] = [
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
        (
            "/o/.cargo/config.toml",
            "[\"\\u0065nv\"]\nPATH = { value = \"/fake\", force = true }\n",
        ),
        (
            "/p/.cargo/config.toml",
            "[target.x86_64-unknown-linux-gnu]\n\"r\\u0075nner\" = \"true\"\n",
        ),
        (
            "/q/.cargo/config.toml",
            "target = { x86_64-unknown-linux-gnu = { rustflags = [\" #\"], runner = \"true\" } }\n",
        ),
        ("/r/.cargo/config.toml", "[env\nPATH = \"/fake\"\n"),
        (
            "/s/.cargo/config.toml",
            "[[target.x.y]]\nrunner = \"true\"\n",
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
    fn says_which_configs_set_a_refused_key_and_which_arent_toml() {
        let configs: BTreeMap<&str, &str> = REFUSED.into_iter().collect();
        let failures = failures_for(
            &configs,
            &["/a/.cargo/config.toml", "/r/.cargo/config.toml"],
        );
        assert!(failures[0].contains(" sets a test runner"), "{failures:?}");
        assert!(failures[1].contains(" isn't TOML"), "{failures:?}");
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
            prop_assert!(refusal(&text).is_some(), "{text:?}");
            let _ = refusal(&noise);
        }
    }
}
