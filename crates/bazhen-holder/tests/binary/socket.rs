//! The holder's socket, through the built binary: where it binds, and when it refuses to.

use std::os::unix::fs::PermissionsExt as _;
use std::os::unix::net::{UnixListener, UnixStream};

use super::{Home, Result, Start, Started, home, spawn, spec, sweep};

/// A holder serving `argv`, once it has said `ready`, and its socket's path.
fn serving(home: &Home, argv: &[&str]) -> Result<(Started, std::path::PathBuf)> {
    let mut holder = spawn(&spec(home, argv, |_| {}), &Start::default())?;
    let line = holder.first_line()?;
    if line != "ready\n" {
        return Err(format!("the holder said {line:?}").into());
    }
    Ok((holder, home.join("t1.sock")))
}

#[test]
fn says_ready_once_its_socket_takes_connections_that_only_its_user_may_make() {
    sweep().unwrap();
    let home = home("bound").unwrap();
    let (_holder, socket) = serving(&home, &["sleep", "30"]).unwrap();
    let mode = std::fs::metadata(&socket).unwrap().permissions().mode();
    assert_eq!(mode & 0o777, 0o600);
    UnixStream::connect(&socket).unwrap();
}

#[test]
fn refuses_a_directory_others_may_enter_with_exit_6_writing_nothing() {
    sweep().unwrap();
    let home = home("open-dir").unwrap();
    std::fs::set_permissions(&*home, std::fs::Permissions::from_mode(0o750)).unwrap();
    let how = Start {
        stderr: true,
        ..Start::default()
    };
    let mut holder = spawn(&spec(&home, &["sleep", "30"], |_| {}), &how).unwrap();
    let (code, stderr) = holder.exit().unwrap();
    assert_eq!(code, Some(6), "{stderr}");
    assert!(stderr.contains("private"), "{stderr}");
    assert_eq!(std::fs::read_dir(&*home).unwrap().count(), 0);
}

#[test]
fn a_second_holder_for_a_terminal_exits_7_and_the_first_keeps_its_socket() {
    sweep().unwrap();
    let home = home("twice").unwrap();
    let (_first, socket) = serving(&home, &["sleep", "30"]).unwrap();
    let how = Start {
        stderr: true,
        ..Start::default()
    };
    let mut second = spawn(&spec(&home, &["sleep", "30"], |_| {}), &how).unwrap();
    let (code, stderr) = second.exit().unwrap();
    assert_eq!(code, Some(7), "{stderr}");
    UnixStream::connect(&socket).unwrap();
}

#[test]
fn refuses_a_socket_path_that_is_relative_or_too_long_with_exit_2() {
    sweep().unwrap();
    let home = home("path").unwrap();
    let long = format!("/tmp/{}.sock", "a".repeat(100));
    for socket in ["t1.sock".to_owned(), long] {
        let bytes = spec(&home, &["sleep", "30"], |s| {
            s["socket"] = socket.clone().into();
        });
        let mut holder = spawn(&bytes, &Start::default()).unwrap();
        assert_eq!(holder.exit().unwrap().0, Some(2), "{socket}");
    }
}

#[test]
fn replaces_a_dead_holders_socket() {
    sweep().unwrap();
    let home = home("stale").unwrap();
    drop(UnixListener::bind(home.join("t1.sock")).unwrap());
    let (_holder, socket) = serving(&home, &["sleep", "30"]).unwrap();
    UnixStream::connect(&socket).unwrap();
}

/// The holder binds under a umask of its own; the child must get the spawner's back.
#[test]
fn the_child_gets_the_spawners_umask() {
    sweep().unwrap();
    let home = home("umask").unwrap();
    let report = home.join("umask");
    let script = format!("umask > {}; exec sleep 30", report.display());
    let how = Start {
        prelude: "umask 027 &&",
        ..Start::default()
    };
    let mut holder = spawn(&spec(&home, &["sh", "-c", &script], |_| {}), &how).unwrap();
    assert_eq!(holder.first_line().unwrap(), "ready\n");
    super::wait_for_file(&report, |t| t.ends_with('\n')).unwrap();
    assert_eq!(std::fs::read_to_string(&report).unwrap().trim(), "0027");
}

#[test]
fn a_program_that_cant_start_leaves_no_socket_behind() {
    sweep().unwrap();
    let home = home("no-program").unwrap();
    let mut holder = spawn(
        &spec(&home, &["/nonexistent/program"], |_| {}),
        &Start::default(),
    )
    .unwrap();
    assert_eq!(holder.exit().unwrap().0, Some(1));
    assert!(!home.join("t1.sock").exists());
}
