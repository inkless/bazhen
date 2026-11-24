//! TEMPORARY, not to merge: measures, on the host it runs on, what a reader racing a rename(2)
//! over a path sees, by how it reads the path. It always fails, so its report is printed.

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

const SWAPS: usize = 2_000;

#[derive(Clone, Copy, Debug)]
enum Method {
    Lstat,
    Readlink,
    StatFollow,
    OpenFollow,
}

fn read(method: Method, path: &Path) -> std::io::Result<()> {
    match method {
        Method::Lstat => std::fs::symlink_metadata(path).map(drop),
        Method::Readlink => std::fs::read_link(path).map(drop),
        Method::StatFollow => std::fs::metadata(path).map(drop),
        Method::OpenFollow => std::fs::File::open(path).map(drop),
    }
}

#[derive(Default)]
struct Seen {
    probes: u64,
    misses: BTreeMap<String, u64>,
}

/// Swaps `link` `SWAPS` times through `swap` while one reader per method reads it, and says what
/// each saw.
fn race(label: &str, methods: &[Method], link: &Path, swap: &dyn Fn(usize)) -> String {
    let done = AtomicBool::new(false);
    let seen: Vec<Seen> = std::thread::scope(|scope| {
        let readers: Vec<_> = methods
            .iter()
            .map(|&method| {
                let done = &done;
                scope.spawn(move || {
                    let mut seen = Seen::default();
                    while !done.load(Ordering::Relaxed) {
                        seen.probes += 1;
                        if let Err(err) = read(method, link) {
                            let errno = format!("{:?}/{:?}", err.raw_os_error(), err.kind());
                            *seen.misses.entry(errno).or_default() += 1;
                        }
                    }
                    seen
                })
            })
            .collect();
        for i in 0..SWAPS {
            swap(i);
        }
        done.store(true, Ordering::Relaxed);
        readers.into_iter().map(|r| r.join().unwrap()).collect()
    });
    let mut out = format!("{label}:\n");
    for (method, seen) in methods.iter().zip(seen) {
        let total: u64 = seen.misses.values().sum();
        writeln!(
            out,
            "  {method:?}: {total} misses in {} probes {:?}",
            seen.probes, seen.misses
        )
        .unwrap();
    }
    out
}

fn dir(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("swap-probe-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::canonicalize(dir).unwrap()
}

#[test]
fn report_what_a_reader_racing_a_rename_over_a_path_sees() {
    const ALL: [Method; 4] = [
        Method::Lstat,
        Method::Readlink,
        Method::StatFollow,
        Method::OpenFollow,
    ];
    let mut report = format!("{} {}\n", std::env::consts::OS, std::env::consts::ARCH);

    // As hook_link's relink: a new symlink at a temporary name, renamed over the link.
    let d = dir("symlink");
    let (first, second) = (d.join("first-client"), d.join("second-client"));
    std::fs::write(&first, "").unwrap();
    std::fs::write(&second, "").unwrap();
    let (link, next) = (d.join("bazhen-hook"), d.join("bazhen-hook.tmp"));
    std::os::unix::fs::symlink(&first, &link).unwrap();
    let relink = |i: usize| {
        let _ = std::fs::remove_file(&next);
        let target = if i % 2 == 0 { &second } else { &first };
        std::os::unix::fs::symlink(target, &next).unwrap();
        std::fs::rename(&next, &link).unwrap();
    };
    report += &race("symlink swap, four readers at once", &ALL, &link, &relink);
    for method in ALL {
        report += &race(&format!("symlink swap, {method:?} alone"), &[method], &link, &relink);
    }

    // The same swap with a relative target, so following it reads no other directory.
    let relative = |i: usize| {
        let _ = std::fs::remove_file(&next);
        let target = if i % 2 == 0 { "second-client" } else { "first-client" };
        std::os::unix::fs::symlink(target, &next).unwrap();
        std::fs::rename(&next, &link).unwrap();
    };
    report += &race("symlink swap, relative targets", &ALL, &link, &relative);

    // A regular file renamed over a regular file: whether the gap is the symlink's or the name's.
    let f = dir("file");
    let (file, tmp) = (f.join("client"), f.join("client.tmp"));
    std::fs::write(&file, "x").unwrap();
    let refile = |_: usize| {
        std::fs::write(&tmp, "x").unwrap();
        std::fs::rename(&tmp, &file).unwrap();
    };
    report += &race(
        "regular file swap",
        &[Method::Lstat, Method::StatFollow, Method::OpenFollow],
        &file,
        &refile,
    );

    let _ = std::fs::remove_dir_all(&d);
    let _ = std::fs::remove_dir_all(&f);
    panic!("\n{report}");
}
