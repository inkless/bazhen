//! The daemon as a process, refusing before it serves. Its home's run directory is a file, so a
//! daemon that went on past the refusal would fail to start, saying something else, rather than
//! serve.

use std::ffi::OsStr;
use std::os::unix::ffi::OsStrExt as _;
use std::path::PathBuf;
use std::process::{Command, Output, Stdio};

type Res<T> = Result<T, Box<dyn std::error::Error + Send + Sync>>;

/// A home of the test's own, removed when this drops.
struct Home(PathBuf);

impl Home {
    fn new(name: &str) -> Res<Self> {
        let dir = std::env::temp_dir().join(format!("bz-refusal-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&dir)?;
        std::fs::write(dir.join("run"), "not a directory")?;
        Ok(Self(dir))
    }
}

impl Drop for Home {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// The daemon run with `args` and `port` as `BAZHEN_PORT` on `home`, to its end.
fn daemon(home: &Home, args: &[&str], port: &OsStr) -> Res<Output> {
    Ok(Command::new(env!("CARGO_BIN_EXE_bazhen-daemon"))
        .args(args)
        .env_clear()
        .env("HOME", &home.0)
        .env("BAZHEN_HOME", &home.0)
        .env("BAZHEN_PORT", port)
        .stdin(Stdio::null())
        .output()?)
}

fn said(output: &Output) -> (Option<i32>, String) {
    (
        output.status.code(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
    )
}

#[test]
fn refuses_to_serve_detached_unless_it_leads_a_session_of_its_own() {
    let home = Home::new("detached").unwrap();
    let (code, stderr) = said(&daemon(&home, &["--session"], OsStr::new("7999")).unwrap());
    assert_eq!(code, Some(1));
    assert!(stderr.contains("leads a session of its own"), "{stderr}");
}

#[test]
fn refuses_a_port_that_isnt_text_as_the_typescript_daemon_does_not_reading_it_as_unset() {
    let home = Home::new("port").unwrap();
    let (code, stderr) = said(&daemon(&home, &[], OsStr::from_bytes(b"79\xff0")).unwrap());
    assert_eq!(code, Some(1));
    assert!(stderr.contains("BAZHEN_PORT"), "{stderr}");
}
