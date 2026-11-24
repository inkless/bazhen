//! The system prompt each agent starts with (`agents/prompts.ts`): what every agent is told
//! about the fleet, then its launch role's prompt as the role's file says it now. Claude Code
//! reads it from a file only the daemon's user can reach, so a user's prompt is never in a
//! process's arguments. Nothing here logs a prompt's text.

use std::io::Write as _;
use std::os::unix::fs::OpenOptionsExt as _;
use std::path::{Path, PathBuf};

use bazhen_core::roles::RoleBook;
use bazhen_protocol::ids::AgentId;
use bazhen_protocol::names::Role;

use crate::pairing::random_bytes;
use crate::private_dir::ensure_private_dir;
use crate::tokens::hash_of;

/// What every agent Bazhen launches is told about the fleet it runs in, beside its harness's own
/// instructions, so it knows the task verbs before any task arrives (`FLEET_INSTRUCTIONS` in
/// `tasks/mail.ts`, which a launch's recorded hash is of).
pub(crate) const FLEET: &str = concat!(
    "You are an agent in a Bazhen fleet, launched and managed by Bazhen. Your agent id is in $BAZHEN_AGENT_ID; bazhen agents whoami says your name, your tasks and whom you report to.\n",
    "Tasks reach you as messages from Bazhen, and you answer them with the bazhen command:\n",
    "- bazhen tasks list: the tasks you are assigned; bazhen tasks show <task>: one in full.\n",
    "- bazhen tasks done <task> --note \"<what you did>\": report a task finished, to whoever gave it to you.\n",
    "- bazhen tasks note [<task>] \"<text>\": say in a line how your work on a task stands, at a milestone or when it changes; your latest note is your headline in the fleet. Add --handoff when it is what whoever takes the task after you needs to pick it up: their brief carries it.\n",
    "- bazhen inbox escalate \"<question>\" [--task <task>]: put a question or problem in the human's inbox.\n",
    "- bazhen agents list shows the other agents, with what each is doing and its headline (--json for a program), and bazhen agents send <agent> \"<text>\" (or --file <path>, for text with quotes or several lines) sends one a message: a question it can answer, or something it needs to act on. bazhen tasks send <task> \"<text>\" sends it to everyone else on that task. With --wait, either send waits until the agent's prompt carries the message and exits 0, or 4 if it bounced, or 5 if it is still on its way at the timeout. An agent is named by its name or its id. A message from another agent names its sender. Answer it only when there is something to answer or act on, never just to acknowledge or thank.\n",
    "- To wait for something, run one wait instead of polling bazhen agents list or sleeping: bazhen agents wait <agent> idle (its turn ended, after every message sent to it arrived), ready or ended; bazhen tasks wait <task> done (done, or everyone on it finished their part); or bazhen agents send <agent> \"<text>\" --reply, which sends and waits for that agent's answer, then prints who replied and the reply's id: the reply itself reaches you as a message. Each blocks until it happens and exits once: 0 when it did, 1 when it can't now, 4 if a --reply message bounced, 5 when --timeout (60 s unless given) ran out. Run one in the background for each thing you wait on, and act when it exits.\n",
    "- As a task's coordinator or lead, bazhen tasks delegate <agent> --task <task> --title \"<title>\" --brief \"<instructions>\" hands part of it to another agent; with --launch claude-code or --launch codex in place of the agent, to a new agent started for it.",
);

/// The system prompt one start of an agent gives it, and its hash, which the start records.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Composed {
    pub(crate) text: String,
    pub(crate) hash: String,
}

/// The prompt an agent launched in `role` starts with now. A role whose file has since gone
/// gives the fleet's instructions alone.
pub(crate) fn compose(fleet: &str, book: &RoleBook, role: Option<&Role>) -> Composed {
    let text = match role.and_then(|role| book.get(role)) {
        None => fleet.to_owned(),
        Some(definition) => format!(
            "{fleet}\n\n## Your role: {}\n\n{}",
            definition.title, definition.prompt
        ),
    };
    let hash = hash_of(&text);
    Composed { text, hash }
}

/// Where agents' prompts are written: a directory made private to `uid` before each write.
#[derive(Debug, Clone)]
pub(crate) struct Prompts {
    dir: PathBuf,
    uid: u32,
}

impl Prompts {
    pub(crate) fn new(dir: PathBuf, uid: u32) -> Self {
        Self { dir, uid }
    }

    /// Writes the agent's prompt for its harness to read, mode 0600, and answers where. It is
    /// renamed into place, so a harness starting meanwhile never reads half a prompt.
    ///
    /// # Errors
    ///
    /// A directory that can't be made private, or a file that can't be written.
    pub(crate) fn write(&self, agent: &AgentId, text: &str) -> std::io::Result<PathBuf> {
        ensure_private_dir(&self.dir, self.uid).map_err(std::io::Error::other)?;
        let path = self.path(agent);
        let start = random_bytes::<6>()?
            .iter()
            .fold(String::with_capacity(12), |mut hex, b| {
                hex.push(char::from_digit(u32::from(b >> 4), 16).unwrap_or('0'));
                hex.push(char::from_digit(u32::from(b & 0xf), 16).unwrap_or('0'));
                hex
            });
        let partial = self.dir.join(format!("{}.md.{start}.tmp", agent.as_str()));
        let written = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&partial)
            .and_then(|mut file| file.write_all(text.as_bytes()))
            .and_then(|()| std::fs::rename(&partial, &path));
        if let Err(err) = written {
            let _ = std::fs::remove_file(&partial);
            return Err(err);
        }
        Ok(path)
    }

    /// Removes the agent's prompt, taking one already gone.
    pub(crate) fn remove(&self, agent: &AgentId) {
        if let Err(err) = std::fs::remove_file(self.path(agent))
            && err.kind() != std::io::ErrorKind::NotFound
        {
            tracing::warn!("bazhen: can't remove agent {agent}'s prompt: {err}");
        }
    }

    fn path(&self, agent: &AgentId) -> PathBuf {
        self.dir.join(format!("{}.md", agent.as_str()))
    }
}

/// The daemon's prompts, in `run`'s `prompts`, as `daemonPrompts` keeps them.
pub(crate) fn daemon_prompts(run: &Path, uid: u32) -> Prompts {
    Prompts::new(run.join("prompts"), uid)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::TempDir;

    #[test]
    fn tells_every_agent_the_fleets_instructions_as_the_typescript_daemon_does() {
        // The SHA-256 of `FLEET_INSTRUCTIONS` in `tasks/mail.ts`, which launches record.
        assert_eq!(
            hash_of(FLEET),
            "3e9e7439a71a064399c493974cf842ee53bced6eb43dbc8d7856862a3d51a3cb"
        );
    }

    #[test]
    fn gives_the_fleets_instructions_alone_for_no_role_or_one_no_file_defines() {
        let book = RoleBook::new(Vec::new());
        let alone = Composed {
            text: "fleet".to_owned(),
            hash: hash_of("fleet"),
        };
        assert_eq!(
            [
                compose("fleet", &book, None),
                compose("fleet", &book, Role::parse("gone").as_ref()),
            ],
            [alone.clone(), alone]
        );
    }

    #[test]
    fn writes_each_agents_prompt_in_place_of_its_last_and_removes_it_once() {
        let dir = TempDir::new("prompts");
        let uid = rustix::process::getuid().as_raw();
        let prompts = daemon_prompts(dir.path(), uid);
        let agent = AgentId::mint(1, [7; 16]);
        prompts.write(&agent, "first").unwrap();
        let path = prompts.write(&agent, "second").unwrap();
        let listed = || {
            std::fs::read_dir(dir.path().join("prompts"))
                .unwrap()
                .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
        };
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "second");
        assert_eq!(listed(), [format!("{}.md", agent.as_str())]);
        prompts.remove(&agent);
        prompts.remove(&agent);
        assert_eq!(listed(), Vec::<String>::new());
    }
}
