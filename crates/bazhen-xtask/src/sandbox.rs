//! Whether this host may run the tests that signal processes they didn't start: the check
//! `bazhen_test_signal::require_sandbox` makes, which a binary can't depend on, as that crate
//! signals whatever a test names.

use std::os::unix::fs::MetadataExt as _;
use std::path::Path;

/// Marks a host that exists to be thrown away: the test container, or a CI runner.
const DISPOSABLE_HOST_MARKER: &str = "/etc/bazhen-disposable-host";

/// Whether this host carries root's marker: a file, not a link, that root owns. A PID namespace
/// alone doesn't count: Flatpak terminals, devcontainers and WSL2 are workstations in one.
pub(crate) fn sandboxed() -> bool {
    let marker = std::fs::symlink_metadata(Path::new(DISPOSABLE_HOST_MARKER)).ok();
    marks_sandbox(marker.map(|m| (m.is_file(), m.uid())))
}

/// Whether a marker, as whether it is a plain file and who owns it, marks a sandbox.
fn marks_sandbox(marker: Option<(bool, u32)>) -> bool {
    marker == Some((true, 0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_plain_file_root_owns_marks_a_sandbox() {
        let marks =
            [None, Some((true, 1000)), Some((false, 0)), Some((true, 0))].map(marks_sandbox);
        assert_eq!(marks, [false, false, false, true]);
    }
}
