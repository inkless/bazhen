//! `scripts/xtask.sh`, which the gate tasks run, under the runners that outrank the alias's own,
//! the configs that would have fooled a gate, and binaries planted where it builds; and
//! `cargo xtask`, run as a caller does, with a logging `env` first on PATH: the alias names `env`
//! as the runner in place of the capping one, so the log shows which runner cargo really started.
//!
//! `BZ_XTASK_WRAPPER` names the script under test, a file in the repository's `scripts/` (it
//! finds the repository from where it is), and the words it takes before xtask's own: by default
//! `scripts/xtask.sh`. Every child runs with the environment the caller of the test gave it, less
//! what cargo and nextest add for a test binary.

use std::env;
use std::error::Error;
use std::ffi::{OsStr, OsString};
use std::fs;
use std::os::unix::fs::{PermissionsExt as _, symlink};
use std::path::{Path, PathBuf};
use std::process::{self, Command, Output, Stdio};

type Result<T, E = Box<dyn Error>> = std::result::Result<T, E>;

fn root() -> Result<PathBuf> {
    Ok(Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .ok_or("the crate is two levels below the repository")?
        .to_path_buf())
}

/// The script under test and the words it takes before xtask's own arguments.
fn wrapper() -> Result<(PathBuf, Vec<String>)> {
    let named = env::var("BZ_XTASK_WRAPPER").unwrap_or_default();
    let mut words = named.split_whitespace().map(str::to_owned);
    let script = match words.next() {
        Some(path) => PathBuf::from(path),
        None => root()?.join("scripts").join("xtask.sh"),
    };
    Ok((script, words.collect()))
}

/// The repository's wrapper, and the words before xtask's arguments.
fn wrapped(args: &[&str]) -> Result<Vec<OsString>> {
    let (script, prefix) = wrapper()?;
    Ok(argv(script, &prefix, args))
}

/// The wrapper copied into `copy`, and the words before xtask's arguments.
fn wrapped_in(copy: &Path, args: &[&str]) -> Result<Vec<OsString>> {
    let (_, prefix) = wrapper()?;
    Ok(argv(copy.join("scripts").join("xtask.sh"), &prefix, args))
}

fn argv(script: PathBuf, prefix: &[String], args: &[&str]) -> Vec<OsString> {
    let mut all = vec![script.into_os_string()];
    all.extend(prefix.iter().map(OsString::from));
    all.extend(args.iter().map(OsString::from));
    all
}

fn direct(args: &[&str]) -> Vec<OsString> {
    ["cargo", "xtask"]
        .iter()
        .chain(args)
        .map(OsString::from)
        .collect()
}

/// What cargo and nextest set for a test binary that a caller of `cargo xtask` or the wrapper
/// wouldn't have: the package's variables, the gate's rustflags, nextest's own, and the library
/// path it adds.
fn added_for_a_test(name: &OsStr) -> bool {
    let name = name.to_string_lossy();
    let kept = ["CARGO_HOME", "CARGO_BUILD_JOBS", "CARGO_TARGET_DIR"];
    name == "CARGO"
        || (name.starts_with("CARGO_") && !kept.contains(&name.as_ref()))
        || name.starts_with("NEXTEST")
        || name.starts_with("__NEXTEST")
        || ["LD_LIBRARY_PATH", "DYLD_FALLBACK_LIBRARY_PATH", "PROPTEST_RNG_SEED"]
            .contains(&name.as_ref())
}

/// `argv` as the test's caller would start it, from `cwd`, with `vars` set on top.
fn start(argv: &[OsString], cwd: &Path, vars: &[(&str, &OsStr)]) -> Result<Output> {
    let (program, rest) = argv.split_first().ok_or("no program to start")?;
    let mut command = Command::new(program);
    command.args(rest).current_dir(cwd).stdin(Stdio::null());
    for (name, _) in env::vars_os() {
        if added_for_a_test(&name) {
            command.env_remove(name);
        }
    }
    command.envs(vars.iter().copied());
    Ok(command.output()?)
}

fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

/// A folder of the test's own, removed when the test ends.
#[derive(Debug)]
struct Scratch(PathBuf);

impl Scratch {
    fn new(prefix: &str) -> Result<Self> {
        let base = env::temp_dir();
        for n in 0.. {
            let path = base.join(format!("{prefix}{}-{n}", process::id()));
            match fs::create_dir(&path) {
                Ok(()) => return Ok(Self(path)),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(e) => return Err(e.into()),
            }
        }
        Err("no free scratch name".into())
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).ok();
    }
}

fn shell_lookup(command: &str) -> Result<String> {
    let found = Command::new("sh")
        .args(["-c", &format!("command -v {command}")])
        .output()?;
    let path = String::from_utf8(found.stdout)?.trim().to_owned();
    if path.is_empty() {
        return Err(format!("no {command} on PATH").into());
    }
    Ok(path)
}

/// PATH with `folder` first.
fn first_on_path(folder: &Path) -> OsString {
    let mut path = folder.as_os_str().to_owned();
    path.push(":");
    path.push(env::var_os("PATH").unwrap_or_default());
    path
}

/// The host's target triple, as `rustc -vV` names it.
fn host() -> Result<String> {
    let out = Command::new("rustc").arg("-vV").output()?;
    String::from_utf8(out.stdout)?
        .lines()
        .find_map(|l| l.strip_prefix("host: ").map(str::to_owned))
        .ok_or_else(|| "rustc -vV names no host".into())
}

fn host_var(suffix: &str) -> Result<String> {
    Ok(format!(
        "CARGO_TARGET_{}_{suffix}",
        host()?.to_uppercase().replace('-', "_")
    ))
}

/// A script at `name` in `dir`, made of `body`.
fn runner(dir: &Path, name: &str, body: &str) -> Result<PathBuf> {
    let path = dir.join(name);
    fs::write(&path, format!("#!/bin/sh\n{body}\n"))?;
    fs::set_permissions(&path, fs::Permissions::from_mode(0o755))?;
    Ok(path)
}

fn log_of(dir: &Path) -> String {
    fs::read_to_string(dir.join("log")).unwrap_or_default()
}

/// A TOML string, which JSON's quoting also is.
fn quoted(text: impl AsRef<OsStr>) -> Result<String> {
    Ok(serde_json::to_string(&text.as_ref().to_string_lossy())?)
}

/// `cargo xtask <args>` run directly, and through the wrapper, from the root, under `vars`.
fn both(vars: &[(&str, &OsStr)], args: &[&str]) -> Result<(Option<i32>, Option<i32>)> {
    let root = root()?;
    Ok((
        start(&direct(args), &root, vars)?.status.code(),
        start(&wrapped(args)?, &root, vars)?.status.code(),
    ))
}

/// A copy of the repository's cargo workspace and of the wrapper, at `<dir>/repo`, so a test can
/// plant configs in and around it without touching the checkout other tests build in. The files
/// git would take, tracked or new, as they are on disk.
fn workspace(dir: &Path) -> Result<PathBuf> {
    let root = root()?;
    let copy = dir.join("repo");
    let kept = [
        "Cargo.toml",
        "Cargo.lock",
        "rust-toolchain.toml",
        ".cargo/config.toml",
        "crates",
    ];
    let listed = Command::new("git")
        .args(["ls-files", "-z", "-co", "--exclude-standard", "--"])
        .args(kept)
        .current_dir(&root)
        .output()?;
    for path in String::from_utf8(listed.stdout)?.split('\0') {
        if path.is_empty() || !root.join(path).exists() {
            continue;
        }
        let to = copy.join(path);
        fs::create_dir_all(to.parent().ok_or("a listed file has a folder")?)?;
        fs::copy(root.join(path), to)?;
    }
    let script = copy.join("scripts").join("xtask.sh");
    fs::create_dir_all(copy.join("scripts"))?;
    fs::copy(wrapper()?.0, &script)?;
    fs::set_permissions(&script, fs::Permissions::from_mode(0o755))?;
    Ok(copy)
}

/// `gate fmt` in `copy`, through `command`: plain `cargo xtask` builds in a folder of the test's
/// own, and the wrapper in the copy's, so neither reuses a binary another test built.
fn format_copy(
    dir: &Path,
    copy: &Path,
    command: Vec<OsString>,
    vars: &[(&str, &OsStr)],
) -> Result<Output> {
    let builds = dir.join("builds");
    let mut all: Vec<(&str, &OsStr)> = vec![("CARGO_TARGET_DIR", builds.as_os_str())];
    all.extend_from_slice(vars);
    start(&command, copy, &all)
}

fn gate_fmt_direct() -> Vec<OsString> {
    direct(&["gate", "fmt"])
}

/// A copy of the workspace with a file rustfmt would change, so a genuine `gate fmt` fails.
fn misformatted(dir: &Path) -> Result<PathBuf> {
    let copy = workspace(dir)?;
    let lib = copy.join("crates").join("bazhen-pid").join("src").join("lib.rs");
    let text = fs::read_to_string(&lib)?;
    fs::write(&lib, format!("pub const  MISFORMATTED : u8=0;\n{text}"))?;
    Ok(copy)
}

/// Plants `config` as the cargo config of the folder above the copy.
fn parent_config(dir: &Path, config: &str) -> Result<PathBuf> {
    fs::create_dir(dir.join(".cargo"))?;
    let path = dir.join(".cargo").join("config.toml");
    fs::write(&path, config)?;
    Ok(path)
}

/// The version of `name` that `copy`'s Cargo.lock holds.
fn locked_version(copy: &Path, name: &str) -> Result<String> {
    let lock = fs::read_to_string(copy.join("Cargo.lock"))?;
    let after = lock
        .split(&format!("name = \"{name}\"\nversion = \""))
        .nth(1)
        .ok_or_else(|| format!("Cargo.lock holds no {name}"))?;
    Ok(after.split('"').next().unwrap_or_default().to_owned())
}

/// A linker at `name` in `dir` that links with the system's `cc`, then puts a script that exits 0
/// in place of xtask.
fn forger(dir: &Path, name: &str) -> Result<PathBuf> {
    let cc = shell_lookup("cc")?;
    runner(
        dir,
        name,
        &[
            &format!("{cc} \"$@\" || exit"),
            "out=; prev=; for arg; do [ \"$prev\" = -o ] && out=$arg; prev=$arg; done",
            "case $out in */bazhen_xtask*) printf '#!/bin/sh\\nexit 0\\n' > \"$out\" ;; esac",
        ]
        .join("\n"),
    )
}

/// The target directory cargo uses for `copy` when nothing names one.
fn target_of(copy: &Path) -> Result<PathBuf> {
    let mut command = Command::new("cargo");
    command
        .args(["metadata", "--no-deps", "--format-version", "1"])
        .current_dir(copy)
        .env_remove("CARGO_TARGET_DIR");
    for (name, _) in env::vars_os() {
        if added_for_a_test(&name) {
            command.env_remove(name);
        }
    }
    let metadata: serde_json::Value = serde_json::from_slice(&command.output()?.stdout)?;
    let named = metadata
        .get("target_directory")
        .and_then(serde_json::Value::as_str)
        .ok_or("cargo metadata named no target directory")?;
    Ok(PathBuf::from(named))
}

/// A `cargo` first on PATH that removes nothing and builds nothing, but prints `executables`.
fn fake_cargo(dir: &Path, executables: &[&str]) -> Result<OsString> {
    let folder = dir.join("fake-cargo");
    fs::create_dir(&folder)?;
    let printed: String = executables
        .iter()
        .map(|path| format!("{}\n", serde_json::json!({ "reason": "x", "executable": path })))
        .collect();
    fs::write(folder.join("printed"), printed)?;
    let body = format!(
        "[ \"$1\" = clean ] && exit 0\ncat \"{}\"",
        folder.join("printed").display()
    );
    runner(&folder, "cargo", &body)?;
    Ok(first_on_path(&folder))
}

/// What genuine xtask says of a config it refuses; a forged one says nothing.
fn refused_by(stderr: &str, config: &Path) -> bool {
    stderr.contains(&format!("{} ", config.display()))
        && stderr.contains("which the Rust gates can't override")
}

/// A cargo home sharing the real one's downloads, whose config sets `config`.
fn cargo_home(dir: &Path, config: &str) -> Result<PathBuf> {
    let real = match env::var_os("CARGO_HOME") {
        Some(home) => PathBuf::from(home),
        None => PathBuf::from(env::var_os("HOME").ok_or("no HOME")?).join(".cargo"),
    };
    let made = dir.join("cargo-home");
    fs::create_dir(&made)?;
    for kept in ["registry", "git"] {
        symlink(real.join(kept), made.join(kept))?;
    }
    fs::write(made.join("config.toml"), config)?;
    Ok(made)
}

#[test]
fn cargo_xtask_runs_xtask_through_the_alias_s_own_runner_not_the_capping_test_runner() {
    let dir = Scratch::new("bz-cargo-config-").unwrap();
    let env = shell_lookup("env").unwrap();
    let log = dir.path().join("log");
    runner(
        dir.path(),
        "env",
        &format!("echo \"$*\" >> \"{}\"\nexec {env} \"$@\"", log.display()),
    )
    .unwrap();
    let path = first_on_path(dir.path());
    let run = start(&direct(&["nope"]), &root().unwrap(), &[("PATH", &path)]).unwrap();
    let logged = log_of(dir.path());
    // Wherever the target directory is: falsify builds in one of its own.
    let ran = logged.strip_suffix("/bazhen-xtask nope\n");
    assert_eq!(
        (run.status.code(), ran.is_some_and(|before| !before.contains(char::is_whitespace))),
        (Some(2), true),
        "log: {logged:?}"
    );
}

#[test]
fn the_wrapper_passes_xtask_s_own_exit_on() {
    assert_eq!(
        [both(&[], &["help"]).unwrap(), both(&[], &["nope"]).unwrap()],
        [(Some(0), Some(0)), (Some(2), Some(2))]
    );
}

// `cargo xtask` starts xtask through such a runner, which here stands in for it and exits 0.
#[test]
fn the_wrapper_runs_xtask_itself_under_a_host_runner_set_in_the_environment() {
    let dir = Scratch::new("bz-cargo-config-").unwrap();
    let log = dir.path().join("log");
    let logs = runner(dir.path(), "logs", &format!("echo \"$*\" >> \"{}\"\nexit 0", log.display()))
        .unwrap();
    let exits = both(&[(&host_var("RUNNER").unwrap(), logs.as_os_str())], &["nope"]).unwrap();
    let ran = log_of(dir.path()).lines().filter(|l| !l.is_empty()).count();
    assert_eq!((exits, ran), ((Some(0), Some(2)), 1));
}

#[test]
fn the_wrapper_runs_xtask_itself_under_a_host_runner_set_in_a_cargo_config() {
    let dir = Scratch::new("bz-cargo-config-").unwrap();
    let home = cargo_home(dir.path(), &format!("[target.{}]\nrunner = \"true\"\n", host().unwrap()))
        .unwrap();
    assert_eq!(
        both(&[("CARGO_HOME", home.as_os_str())], &["nope"]).unwrap(),
        (Some(0), Some(2))
    );
}

// cargo appends an alias from the environment to the configured one, after its `--`; the wrapper
// runs no alias.
#[test]
fn the_wrapper_runs_xtask_with_its_own_arguments_under_an_alias_in_the_environment() {
    assert_eq!(
        both(&[("CARGO_ALIAS_XTASK", OsStr::new("version"))], &["help"]).unwrap(),
        (Some(2), Some(0))
    );
}

#[test]
fn the_wrapper_refuses_to_format_under_a_cargo_home_whose_env_puts_another_cargo_fmt_first() {
    let dir = Scratch::new("bz-cargo-config-").unwrap();
    runner(dir.path(), "cargo-fmt", "exit 0").unwrap();
    let path = quoted(first_on_path(dir.path())).unwrap();
    let home = cargo_home(
        dir.path(),
        &format!("[env]\nPATH = {{ value = {path}, force = true }}\n"),
    )
    .unwrap();
    let run = start(
        &wrapped(&["gate", "fmt"]).unwrap(),
        &root().unwrap(),
        &[("CARGO_HOME", home.as_os_str())],
    )
    .unwrap();
    assert_eq!(
        (run.status.code(), stderr(&run).contains("sets a test runner")),
        (Some(1), true)
    );
}

// The runner would have started xtask with a root far from the config, so the config check never
// saw it, and the PATH it set put another cargo-fmt first.
#[test]
fn the_wrapper_refuses_a_parent_config_whose_runner_would_move_xtask_s_root_and_its_path() {
    let dir = Scratch::new("bz-cargo-config-").unwrap();
    let copy = workspace(dir.path()).unwrap();
    runner(dir.path(), "cargo-fmt", "exit 0").unwrap();
    let elsewhere = Scratch::new("bz-elsewhere-").unwrap();
    let forged = serde_json::to_string(&[
        "env".to_owned(),
        format!("CARGO_MANIFEST_DIR={}", elsewhere.path().join("crates").join("x").display()),
        format!("PATH={}", first_on_path(dir.path()).to_string_lossy()),
    ])
    .unwrap();
    parent_config(dir.path(), &format!("[target.{}]\nrunner = {forged}\n", host().unwrap()))
        .unwrap();
    let plain = format_copy(dir.path(), &copy, gate_fmt_direct(), &[]).unwrap();
    let run =
        format_copy(dir.path(), &copy, wrapped_in(&copy, &["gate", "fmt"]).unwrap(), &[]).unwrap();
    let said = format!("{}/.cargo/config.toml sets a test runner", dir.path().display());
    assert_eq!(
        (plain.status.code(), run.status.code(), stderr(&run).contains(&said)),
        (Some(0), Some(1), true)
    );
}

// cargo reads .cargo/config in place of the pinned .cargo/config.toml, and only warns.
#[test]
fn the_wrapper_refuses_to_format_in_a_repository_whose_dot_cargo_config_puts_another_cargo_fmt_first()
 {
    let dir = Scratch::new("bz-cargo-config-").unwrap();
    let copy = workspace(dir.path()).unwrap();
    runner(dir.path(), "cargo-fmt", "exit 0").unwrap();
    let path = quoted(first_on_path(dir.path())).unwrap();
    fs::write(
        copy.join(".cargo").join("config"),
        format!("[env]\nPATH = {{ value = {path}, force = true }}\n"),
    )
    .unwrap();
    let run =
        format_copy(dir.path(), &copy, wrapped_in(&copy, &["gate", "fmt"]).unwrap(), &[]).unwrap();
    let said = format!("{}/.cargo/config is there", copy.display());
    assert_eq!(
        (run.status.code(), stderr(&run).contains(&said)),
        (Some(1), true)
    );
}

#[test]
fn the_wrapper_builds_xtask_itself_under_a_parent_config_whose_linker_would_forge_it() {
    let dir = Scratch::new("bz-cargo-config-").unwrap();
    let copy = misformatted(dir.path()).unwrap();
    let linker = quoted(forger(dir.path(), "forger").unwrap()).unwrap();
    let config =
        parent_config(dir.path(), &format!("[target.{}]\nlinker = {linker}\n", host().unwrap()))
            .unwrap();
    let plain = format_copy(dir.path(), &copy, gate_fmt_direct(), &[]).unwrap();
    let run =
        format_copy(dir.path(), &copy, wrapped_in(&copy, &["gate", "fmt"]).unwrap(), &[]).unwrap();
    assert_eq!(
        (plain.status.code(), run.status.code(), refused_by(&stderr(&run), &config)),
        (Some(0), Some(1), true)
    );
}

// [env] reaches rustc, and so the `cc` it links with.
#[test]
fn the_wrapper_builds_xtask_itself_under_a_parent_config_whose_env_puts_a_forging_cc_first() {
    let dir = Scratch::new("bz-cargo-config-").unwrap();
    let copy = misformatted(dir.path()).unwrap();
    fs::create_dir(dir.path().join("bin")).unwrap();
    forger(dir.path(), "bin/cc").unwrap();
    let path = quoted(first_on_path(&dir.path().join("bin"))).unwrap();
    let config = parent_config(
        dir.path(),
        &format!("[env]\nPATH = {{ value = {path}, force = true }}\n"),
    )
    .unwrap();
    let plain = format_copy(dir.path(), &copy, gate_fmt_direct(), &[]).unwrap();
    let run =
        format_copy(dir.path(), &copy, wrapped_in(&copy, &["gate", "fmt"]).unwrap(), &[]).unwrap();
    assert_eq!(
        (plain.status.code(), run.status.code(), refused_by(&stderr(&run), &config)),
        (Some(0), Some(1), true)
    );
}

// `paths` swaps a dependency's code without changing Cargo.lock; this one doesn't compile.
#[test]
fn the_wrapper_builds_xtask_itself_under_a_parent_config_whose_paths_swaps_a_dependency() {
    let dir = Scratch::new("bz-cargo-config-").unwrap();
    let copy = misformatted(dir.path()).unwrap();
    let version = locked_version(&copy, "itoa").unwrap();
    let swapped = dir.path().join("itoa");
    fs::create_dir_all(swapped.join("src")).unwrap();
    fs::write(
        swapped.join("Cargo.toml"),
        format!("[package]\nname = \"itoa\"\nversion = \"{version}\"\nedition = \"2021\"\n"),
    )
    .unwrap();
    fs::write(swapped.join("src").join("lib.rs"), "compile_error!(\"swapped itoa\");\n").unwrap();
    let config =
        parent_config(dir.path(), &format!("paths = [{}]\n", quoted(&swapped).unwrap())).unwrap();
    let plain = format_copy(dir.path(), &copy, gate_fmt_direct(), &[]).unwrap();
    let run =
        format_copy(dir.path(), &copy, wrapped_in(&copy, &["gate", "fmt"]).unwrap(), &[]).unwrap();
    assert_eq!(
        (
            plain.status.code(),
            stderr(&plain).contains("swapped itoa"),
            run.status.code(),
            refused_by(&stderr(&run), &config),
        ),
        (Some(101), true, Some(1), true)
    );
}

// The build runs with none of the caller's variables but those the wrapper names.
#[test]
fn the_wrapper_builds_xtask_with_no_linker_rustflags_or_rustc_wrapper_from_the_caller() {
    let dir = Scratch::new("bz-cargo-config-").unwrap();
    let copy = workspace(dir.path()).unwrap();
    let log = dir.path().join("log");
    let logs = runner(dir.path(), "logs", &format!("echo \"$*\" >> \"{}\"\nexit 1", log.display()))
        .unwrap();
    let linker = host_var("LINKER").unwrap();
    let run = start(
        &wrapped_in(&copy, &["nope"]).unwrap(),
        &copy,
        &[
            (&linker, logs.as_os_str()),
            ("RUSTFLAGS", OsStr::new("--no-such-flag")),
            ("RUSTC_WRAPPER", logs.as_os_str()),
        ],
    )
    .unwrap();
    assert_eq!((run.status.code(), log.exists()), (Some(2), false));
}

#[test]
fn the_wrapper_builds_xtask_itself_under_a_cargo_home_config_whose_linker_would_forge_it() {
    let dir = Scratch::new("bz-cargo-config-").unwrap();
    let copy = misformatted(dir.path()).unwrap();
    let linker = quoted(forger(dir.path(), "forger").unwrap()).unwrap();
    let home = cargo_home(
        dir.path(),
        &format!("[target.{}]\nlinker = {linker}\n", host().unwrap()),
    )
    .unwrap();
    let vars = [("CARGO_HOME", home.as_os_str())];
    let plain = format_copy(dir.path(), &copy, gate_fmt_direct(), &vars).unwrap();
    let run =
        format_copy(dir.path(), &copy, wrapped_in(&copy, &["gate", "fmt"]).unwrap(), &vars)
            .unwrap();
    assert_eq!(
        (
            plain.status.code(),
            run.status.code(),
            refused_by(&stderr(&run), &home.join("config.toml")),
        ),
        (Some(0), Some(1), true)
    );
}

#[test]
fn the_wrapper_names_the_root_it_is_in_whatever_cargo_manifest_dir_the_caller_set() {
    let dir = Scratch::new("bz-cargo-config-").unwrap();
    let copy = workspace(dir.path()).unwrap();
    let elsewhere = dir.path().join("elsewhere").join("crates").join("x");
    let run = format_copy(
        dir.path(),
        &copy,
        wrapped_in(&copy, &["gate", "fmt"]).unwrap(),
        &[("CARGO_MANIFEST_DIR", elsewhere.as_os_str())],
    )
    .unwrap();
    assert_eq!(run.status.code(), Some(0), "{}", stderr(&run));
}

// cargo would read the configs above its own folder, which a symlink can hide from a walk of the
// names; xtask is built from `/`, wherever the caller and TMPDIR are.
#[test]
fn the_wrapper_s_build_reads_no_config_above_the_caller_s_folder_or_tmpdir_through_a_symlink_or_not()
 {
    let dir = Scratch::new("bz-cargo-config-").unwrap();
    let log = dir.path().join("log");
    let logs = runner(dir.path(), "logs", &format!("echo \"$*\" >> \"{}\"\nexit 1", log.display()))
        .unwrap();
    let real = dir.path().join("real");
    fs::create_dir_all(real.join(".cargo")).unwrap();
    fs::create_dir(real.join("tmp")).unwrap();
    fs::write(
        real.join(".cargo").join("config.toml"),
        format!("[build]\nrustc-wrapper = {}\n", quoted(&logs).unwrap()),
    )
    .unwrap();
    symlink(real.join("tmp"), dir.path().join("link")).unwrap();
    let runs: Vec<_> = [real.join("tmp"), dir.path().join("link")]
        .iter()
        .map(|folder| {
            start(&wrapped(&["help"]).unwrap(), folder, &[("TMPDIR", folder.as_os_str())])
                .unwrap()
                .status
                .code()
        })
        .collect();
    assert_eq!((runs, log.exists()), (vec![Some(0), Some(0)], false));
}

#[test]
fn the_wrapper_builds_xtask_afresh_so_a_binary_forged_in_its_place_is_replaced_on_the_next_run() {
    let dir = Scratch::new("bz-cargo-config-").unwrap();
    let copy = workspace(dir.path()).unwrap();
    let root = root().unwrap();
    let built = start(&wrapped_in(&copy, &["help"]).unwrap(), &root, &[]).unwrap();
    let binary = target_of(&copy).unwrap().join("xtask").join("debug").join("bazhen-xtask");
    fs::write(binary, "#!/bin/sh\nexit 0\n").unwrap();
    let next = start(&wrapped_in(&copy, &["nope"]).unwrap(), &root, &[]).unwrap();
    assert_eq!(
        (built.status.code(), next.status.code()),
        (Some(0), Some(2))
    );
}

// cargo would rewrite a stale Cargo.lock while it resolves the workspace, and then build with it.
#[test]
fn the_wrapper_refuses_a_cargo_lock_that_doesn_t_match_the_workspace_and_leaves_it_as_it_was() {
    let dir = Scratch::new("bz-cargo-config-").unwrap();
    let copy = workspace(dir.path()).unwrap();
    let lock = copy.join("Cargo.lock");
    let text = fs::read_to_string(&lock).unwrap();
    let version = locked_version(&copy, "bazhen-xtask").unwrap();
    let stale = text.replace(
        &format!("name = \"bazhen-xtask\"\nversion = \"{version}\""),
        "name = \"bazhen-xtask\"\nversion = \"0.0.9\"",
    );
    assert_ne!(stale, text);
    fs::write(&lock, &stale).unwrap();
    let run = start(&wrapped_in(&copy, &["gate", "fmt"]).unwrap(), &root().unwrap(), &[]).unwrap();
    assert_eq!(
        (run.status.code(), fs::read_to_string(&lock).unwrap() == stale),
        (Some(1), true)
    );
}

#[test]
fn the_wrapper_runs_only_the_one_executable_cargo_names_and_refuses_none_or_two() {
    let runs: Vec<_> = [&[][..], &["/bin/true", "/bin/false"], &["/bin/true"]]
        .iter()
        .map(|executables| {
            let dir = Scratch::new("bz-cargo-config-").unwrap();
            let path = fake_cargo(dir.path(), executables).unwrap();
            let run = start(&wrapped(&["help"]).unwrap(), &root().unwrap(), &[("PATH", &path)])
                .unwrap();
            (run.status.code(), stderr(&run).contains("no single executable"))
        })
        .collect();
    assert_eq!(
        runs,
        [(Some(1), true), (Some(1), true), (Some(0), false)]
    );
}

#[test]
fn the_wrapper_refuses_to_build_with_a_config_in_its_own_cargo_home() {
    let dir = Scratch::new("bz-cargo-config-").unwrap();
    let copy = workspace(dir.path()).unwrap();
    let root = root().unwrap();
    let built = start(&wrapped_in(&copy, &["help"]).unwrap(), &root, &[]).unwrap();
    fs::write(
        target_of(&copy).unwrap().join("xtask").join("cargo-home").join("config.toml"),
        "[build]\njobs = 1\n",
    )
    .unwrap();
    let run = start(&wrapped_in(&copy, &["help"]).unwrap(), &root, &[]).unwrap();
    assert_eq!(
        (
            built.status.code(),
            run.status.code(),
            stderr(&run).contains("the build's own cargo home has a config.toml"),
        ),
        (Some(0), Some(1), true)
    );
}
