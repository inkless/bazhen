//! Where a terminal's holder incarnation is, as the daemon records it beside the terminal: the
//! `locator` of `RuntimeRef` in `packages/core/src/runtime.ts`, a JSON object of strings, with the
//! keys `refOf` in `runtime.ts` writes and the daemon's peer reader takes (`holderPid`,
//! `childPid`).

use std::path::PathBuf;

use bazhen_holder_proto::body::{Generation, HelloReply, Pid, StartTime};
use bazhen_host_guard::holder::HolderProcess;
use bazhen_protocol::ids::TerminalId;
use serde_json::{Map, Value};

const SOCKET: &str = "socket";
const HOLDER_PID: &str = "holderPid";
const HOLDER_START: &str = "holderStart";
const CHILD_PID: &str = "childPid";
const CHILD_START: &str = "childStart";
const GENERATION: &str = "generation";

/// The holder that runs a terminal, and the process it runs for it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HolderLocator {
    pub socket: PathBuf,
    pub holder_pid: Pid,
    pub holder_start: StartTime,
    pub child_pid: Pid,
    pub child_start: StartTime,
    /// `None` for a locator that records none, on which no verb acts.
    pub generation: Option<Generation>,
}

/// One holder incarnation of a terminal: what the runtime gives back from `create`, and acts on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HolderRef {
    pub terminal_id: TerminalId,
    pub locator: HolderLocator,
}

/// A locator that names no holder: not a JSON object, or a key missing or not a whole number as
/// the daemon writes one.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("refusing the holder locator: {why}")]
pub struct LocatorError {
    pub why: String,
}

impl HolderLocator {
    /// The locator of the holder that said `hello`, at `socket`.
    pub fn of(socket: PathBuf, hello: &HelloReply) -> Self {
        Self {
            socket,
            holder_pid: hello.holder_pid,
            holder_start: hello.holder_start,
            child_pid: hello.child_pid,
            child_start: hello.child_start,
            generation: Some(hello.generation),
        }
    }

    /// The JSON the daemon records, every value a string, in the order `refOf` writes them.
    ///
    /// # Errors
    ///
    /// When the socket's path isn't UTF-8, as no holder's is.
    pub fn encode(&self) -> Result<String, LocatorError> {
        let socket = self.socket.to_str().ok_or_else(|| LocatorError {
            why: format!("its socket {} isn't UTF-8", self.socket.display()),
        })?;
        let mut fields = vec![
            (SOCKET, socket.to_owned()),
            (HOLDER_PID, self.holder_pid.get().to_string()),
            (HOLDER_START, self.holder_start.get().to_string()),
            (CHILD_PID, self.child_pid.get().to_string()),
            (CHILD_START, self.child_start.get().to_string()),
        ];
        if let Some(generation) = self.generation {
            fields.push((GENERATION, generation.get().to_string()));
        }
        let body: Vec<String> = fields
            .into_iter()
            .map(|(key, value)| format!("{}:{}", Value::from(key), Value::from(value)))
            .collect();
        Ok(format!("{{{}}}", body.join(",")))
    }

    /// The locator `encode` wrote. One with no `generation` reads as unnumbered.
    ///
    /// # Errors
    ///
    /// When it isn't a JSON object of strings naming a socket, a holder and its child.
    pub fn decode(text: &str) -> Result<Self, LocatorError> {
        let refuse = |why: String| LocatorError { why };
        let fields: Map<String, Value> = match serde_json::from_str(text) {
            Ok(Value::Object(fields)) => fields,
            Ok(_) => return Err(refuse("it isn't a JSON object".to_owned())),
            Err(e) => return Err(refuse(e.to_string())),
        };
        let text_of = |key: &str| match fields.get(key) {
            Some(Value::String(value)) => Ok(Some(value.as_str())),
            None => Ok(None),
            Some(_) => Err(refuse(format!("its {key} isn't a string"))),
        };
        let number = |key: &str| -> Result<Option<u64>, LocatorError> {
            let Some(value) = text_of(key)? else {
                return Ok(None);
            };
            // Compared as text with what a holder says, so only the digits the daemon writes.
            match value.parse::<u64>() {
                Ok(n) if n.to_string() == value => Ok(Some(n)),
                _ => Err(refuse(format!("its {key} {value:?} isn't a whole number"))),
            }
        };
        let required = |key: &str| {
            number(key)?.ok_or_else(|| LocatorError {
                why: format!("it has no {key}"),
            })
        };
        let bounded = |key: &str, n: u64| LocatorError {
            why: format!("its {key} {n} is out of range"),
        };
        let pid = |key: &str| {
            let n = required(key)?;
            Pid::new(n).map_err(|_| bounded(key, n))
        };
        let start = |key: &str| {
            let n = required(key)?;
            StartTime::new(n).map_err(|_| bounded(key, n))
        };
        let socket = text_of(SOCKET)?.ok_or_else(|| LocatorError {
            why: "it has no socket".to_owned(),
        })?;
        let generation = match number(GENERATION)? {
            Some(n) => Some(Generation::new(n).map_err(|_| bounded(GENERATION, n))?),
            None => None,
        };
        Ok(Self {
            socket: PathBuf::from(socket),
            holder_pid: pid(HOLDER_PID)?,
            holder_start: start(HOLDER_START)?,
            child_pid: pid(CHILD_PID)?,
            child_start: start(CHILD_START)?,
            generation,
        })
    }

    /// Whether `hello` came from the holder this records.
    pub(crate) fn is_holder_of(&self, hello: &HelloReply) -> bool {
        hello.holder_pid == self.holder_pid && hello.holder_start == self.holder_start
    }
}

impl HolderRef {
    /// The holder process the locator records, as host-guard checks one; `None` for a pid no
    /// process here can have.
    pub fn holder(&self) -> Option<HolderProcess> {
        Some(HolderProcess {
            pid: os_pid(self.locator.holder_pid)?,
            start: self.locator.holder_start.get(),
        })
    }
}

/// A pid as the kernel takes it, when it is one.
pub(crate) fn os_pid(pid: Pid) -> Option<rustix::process::Pid> {
    i32::try_from(pid.get())
        .ok()
        .and_then(rustix::process::Pid::from_raw)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn locator(generation: Option<u64>) -> HolderLocator {
        HolderLocator {
            socket: PathBuf::from("/run/bz/holders/term_1.sock"),
            holder_pid: Pid::new(700).unwrap(),
            holder_start: StartTime::new(1_700_000_000).unwrap(),
            child_pid: Pid::new(701).unwrap(),
            child_start: StartTime::new(1_700_000_001).unwrap(),
            generation: generation.map(|g| Generation::new(g).unwrap()),
        }
    }

    #[test]
    fn writes_every_key_as_a_string_in_the_order_the_typescript_daemon_does() {
        assert_eq!(
            locator(Some(3)).encode().unwrap(),
            r#"{"socket":"/run/bz/holders/term_1.sock","holderPid":"700","holderStart":"1700000000","childPid":"701","childStart":"1700000001","generation":"3"}"#
        );
    }

    #[test]
    fn reads_back_what_it_wrote_and_one_with_no_generation_as_unnumbered() {
        let back = [Some(3), None].map(|g| HolderLocator::decode(&locator(g).encode().unwrap()));
        assert_eq!(back, [Ok(locator(Some(3))), Ok(locator(None))]);
    }

    #[test]
    fn refuses_a_locator_naming_no_holder_or_one_not_written_as_the_daemon_writes() {
        let written = locator(Some(0)).encode().unwrap();
        let refused = [
            "[]".to_owned(),
            written.replace(r#""holderPid":"700","#, ""),
            written.replace(r#""700""#, r#""0700""#),
            written.replace(r#""700""#, "700"),
            written.replace(r#""701""#, r#""0""#),
        ];
        let whys: Vec<_> = refused
            .iter()
            .map(|text| HolderLocator::decode(text).map_err(|e| e.why))
            .collect();
        assert_eq!(
            whys,
            [
                Err("it isn't a JSON object".to_owned()),
                Err("it has no holderPid".to_owned()),
                Err(r#"its holderPid "0700" isn't a whole number"#.to_owned()),
                Err("its holderPid isn't a string".to_owned()),
                Err("its childPid 0 is out of range".to_owned()),
            ]
        );
    }
}
