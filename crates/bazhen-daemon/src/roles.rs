//! The roles in force, as `roles/roles.ts`'s `Roles` keeps them: the built-ins, shipped in the
//! binary, and the user's files in the config directory's `roles/`, read again whenever the
//! directory's listing or a file's modification time or size changes, so an edit takes effect at
//! the next use without a restart. A bad file is reported, once for each change, and skipped. A
//! problem names its file from the config directory (`roles/lead.md`), since it is shown to
//! agents, which have no need of the user's home; only the daemon's log names the whole path.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::UNIX_EPOCH;

use bazhen_client::{Unread, read_regular};
use bazhen_core::role_file::{FILE_MAX, parse_role};
use bazhen_core::roles::{RoleBook, UserRole, resolve_roles};
use bazhen_protocol::roles::{RoleDefinition, RoleProblem, RoleSource, RolesResponse};
use rustix::io::Errno;

/// The role files Bazhen ships, by key, as [`bazhen_protocol::roles::BUILTIN_ROLES`] orders them.
const BUILTINS: [(&str, &str); 4] = [
    (
        "coordinator",
        include_str!("../../../apps/daemon/roles/coordinator.md"),
    ),
    ("lead", include_str!("../../../apps/daemon/roles/lead.md")),
    (
        "worker",
        include_str!("../../../apps/daemon/roles/worker.md"),
    ),
    (
        "reviewer",
        include_str!("../../../apps/daemon/roles/reviewer.md"),
    ),
];

/// The roles Bazhen ships. One that doesn't parse is a bug in Bazhen, which a test here catches:
/// at run time it is logged and left out, where TypeScript would refuse to start.
fn builtin_roles() -> Vec<RoleDefinition> {
    BUILTINS
        .iter()
        .filter_map(|(key, text)| {
            parse_role(key, text.as_bytes(), RoleSource::Builtin)
                .map_err(|problem| {
                    tracing::error!("bazhen: the built-in role {key} is broken: {problem}");
                })
                .ok()
        })
        .collect()
}

/// The roles in force at a read, and the files skipped.
#[derive(Debug)]
pub(crate) struct RolesNow {
    pub(crate) book: RoleBook,
    pub(crate) problems: Vec<RoleProblem>,
}

impl RolesNow {
    pub(crate) fn response(&self) -> RolesResponse {
        RolesResponse {
            roles: self.book.roles().to_vec(),
            problems: self.problems.clone(),
        }
    }
}

#[derive(Debug)]
pub(crate) struct Roles {
    /// The user's role files, or none for a daemon given no config directory.
    dir: Option<PathBuf>,
    builtins: Vec<RoleDefinition>,
    /// The listing's signature at the last read, and what it read.
    last: Mutex<Option<(String, Arc<RolesNow>)>>,
}

impl Roles {
    pub(crate) fn new(dir: Option<PathBuf>) -> Self {
        Self {
            dir,
            builtins: builtin_roles(),
            last: Mutex::new(None),
        }
    }

    /// The roles in force now, read again if the directory changed since the last read.
    pub(crate) fn current(&self) -> Arc<RolesNow> {
        let listed = self
            .dir
            .as_deref()
            .map_or_else(|| Ok(Listing::default()), listing);
        let signature = match &listed {
            Ok(listing) => listing.signature.clone(),
            Err(error) => format!("error:{error}"),
        };
        let mut last = self.last.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some((seen, now)) = last.as_ref()
            && *seen == signature
        {
            return Arc::clone(now);
        }
        let now = Arc::new(self.read(&listed));
        *last = Some((signature, Arc::clone(&now)));
        now
    }

    fn read(&self, listed: &Result<Listing, String>) -> RolesNow {
        let shown_dir = self
            .dir
            .as_deref()
            .and_then(Path::file_name)
            .map_or_else(|| "roles".to_owned(), |n| n.to_string_lossy().into_owned());
        let mut problems = Vec::new();
        let mut user = Vec::new();
        let files = listed.as_ref().map_or(&[][..], |l| l.files.as_slice());
        for file in files {
            let shown = format!("{shown_dir}/{file}");
            match self.read_role(file) {
                Ok(role) => user.push(UserRole { file: shown, role }),
                Err(problem) => problems.push(RoleProblem {
                    file: shown,
                    problem,
                }),
            }
        }
        if let Err(error) = listed {
            problems.push(RoleProblem {
                file: shown_dir,
                problem: error.clone(),
            });
        }
        let (book, refused) = resolve_roles(&self.builtins, &user);
        problems.extend(refused);
        for RoleProblem { file, problem } in &problems {
            let whole = self.dir.as_deref().and_then(Path::parent).map_or_else(
                || file.clone(),
                |config| config.join(file).display().to_string(),
            );
            tracing::warn!("bazhen: role file {whole} skipped: {problem}");
        }
        RolesNow { book, problems }
    }

    /// A user's role file, by its name in the directory, or why it isn't one.
    fn read_role(&self, file: &str) -> Result<RoleDefinition, String> {
        let dir = self.dir.as_deref().unwrap_or(Path::new("."));
        let key = file.strip_suffix(".md").unwrap_or(file);
        let bytes =
            read_regular(&dir.join(file), FILE_MAX as u64).map_err(|unread| match unread {
                Unread::NotAFile => "it isn't a regular file".to_owned(),
                Unread::TooLarge { max } => {
                    format!("it is over {max} bytes, longer than a role file is")
                }
                Unread::Io(err) => format!("can't read it: {}", reason(&err)),
            })?;
        parse_role(key, &bytes, RoleSource::User)
    }
}

/// The role files in a directory, by name, and what tells a changed one apart.
#[derive(Debug, Default)]
struct Listing {
    files: Vec<String>,
    signature: String,
}

/// The `.md` files of `dir` but hidden ones, sorted, or why it can't be listed. A directory that
/// isn't there holds none.
fn listing(dir: &Path) -> Result<Listing, String> {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Listing::default()),
        Err(err) => return Err(format!("can't list it: {}", reason(&err))),
    };
    let mut files: Vec<String> = entries
        .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
        .filter(|name| name.strip_suffix(".md").is_some() && !name.starts_with('.'))
        .collect();
    files.sort();
    let signature = files
        .iter()
        .map(|name| match std::fs::metadata(dir.join(name)) {
            Ok(meta) => {
                let modified = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map_or(0, |d| d.as_nanos());
                format!("{name}:{modified}:{}", meta.len())
            }
            Err(_) => format!("{name}:gone"),
        })
        .collect::<Vec<_>>()
        .join("\n");
    Ok(Listing { files, signature })
}

/// Why a file system call failed, by its code as Node names it, since its message names the
/// absolute path.
fn reason(err: &std::io::Error) -> &'static str {
    let Some(raw) = err.raw_os_error() else {
        return "an unexpected error";
    };
    [
        (Errno::NOENT, "ENOENT"),
        (Errno::ACCESS, "EACCES"),
        (Errno::PERM, "EPERM"),
        (Errno::LOOP, "ELOOP"),
        (Errno::NAMETOOLONG, "ENAMETOOLONG"),
        (Errno::NOTDIR, "ENOTDIR"),
        (Errno::ISDIR, "EISDIR"),
        (Errno::IO, "EIO"),
        (Errno::MFILE, "EMFILE"),
        (Errno::NFILE, "ENFILE"),
        (Errno::NOMEM, "ENOMEM"),
        (Errno::AGAIN, "EAGAIN"),
        (Errno::NXIO, "ENXIO"),
    ]
    .into_iter()
    .find_map(|(errno, name)| (errno.raw_os_error() == raw).then_some(name))
    .unwrap_or("an unexpected error")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::TempDir;

    fn keys(now: &RolesNow) -> Vec<&str> {
        now.book.roles().iter().map(|r| r.key.as_str()).collect()
    }

    #[test]
    fn ships_every_built_in_role_parsed() {
        let roles = Roles::new(None);
        assert_eq!(
            keys(&roles.current()),
            bazhen_protocol::roles::BUILTIN_ROLES
        );
        assert_eq!(roles.current().problems, []);
    }

    #[test]
    fn reads_the_user_s_files_again_once_one_changes_and_names_each_skipped_from_the_config_dir() {
        let config = TempDir::new("roles");
        let dir = config.path().join("roles");
        std::fs::create_dir(&dir).ok();
        let write = |name: &str, text: &str| std::fs::write(dir.join(name), text).ok();
        write(
            "tester.md",
            "---\ntitle: Tester\ngrants: [worker]\n---\nTest it.\n",
        );
        write("Bad.md", "---\ntitle: B\n---\nx\n");
        write(".hidden.md", "not read");
        write("notes.txt", "not read");
        let roles = Roles::new(Some(dir.clone()));
        let first = roles.current();
        assert_eq!(
            keys(&first),
            ["coordinator", "lead", "worker", "reviewer", "tester"]
        );
        assert_eq!(
            first.problems,
            [RoleProblem {
                file: "roles/Bad.md".to_owned(),
                problem: "a role file is named <role>.md, the role lowercase letters, digits or -"
                    .to_owned()
            }]
        );
        assert!(
            Arc::ptr_eq(&first, &roles.current()),
            "read again with nothing changed"
        );
        write(
            "tester.md",
            "---\ntitle: Tester\ngrants: [tester]\n---\nTest it again.\n",
        );
        let second = roles.current();
        assert_eq!(keys(&second), ["coordinator", "lead", "worker", "reviewer"]);
        assert_eq!(second.problems.len(), 2, "{:?}", second.problems);
        assert_eq!(
            second.problems[1].problem,
            "a tester can't grant its own role"
        );
    }

    #[test]
    fn reads_no_user_roles_from_a_directory_that_isn_t_there_and_refuses_what_isn_t_a_file() {
        let config = TempDir::new("roles-absent");
        let roles = Roles::new(Some(config.path().join("roles")));
        assert_eq!(keys(&roles.current()).len(), 4);
        let dir = config.path().join("roles");
        std::fs::create_dir_all(dir.join("lead.md")).ok();
        std::fs::write(dir.join("big.md"), "x".repeat(FILE_MAX + 1)).ok();
        let problems: Vec<(String, String)> = roles
            .current()
            .problems
            .iter()
            .map(|p| (p.file.clone(), p.problem.clone()))
            .collect();
        assert_eq!(
            problems,
            [
                (
                    "roles/big.md".to_owned(),
                    format!("it is over {FILE_MAX} bytes, longer than a role file is")
                ),
                (
                    "roles/lead.md".to_owned(),
                    "it isn't a regular file".to_owned()
                ),
            ]
        );
    }
}
