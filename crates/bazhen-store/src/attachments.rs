//! Views of a terminal and its input lease, as `projections.ts` keeps them: the attachments still
//! open, and each terminal's lease with the epoch of its last grant.

use bazhen_protocol::events::{
    AttachmentEndReason, AttachmentEnded, AttachmentStarted, LeaseGranted,
};
use bazhen_protocol::ids::{AttachmentId, TerminalId};
use rusqlite::{OptionalExtension, Transaction};

use crate::events::{AppendError, NewEvent, Reads, Writer, int};

/// A view opened: it is open until it ends.
pub(crate) fn started(
    tx: &Transaction<'_>,
    id: u64,
    attachment: &AttachmentId,
    payload: &AttachmentStarted,
) -> Result<(), AppendError> {
    tx.execute(
        "INSERT INTO attachments_open (id, terminal_id, mode, started_event_id) VALUES (?, ?, ?, ?)",
        (
            attachment.as_str(),
            payload.terminal_id.as_str(),
            payload.mode.as_str(),
            int(id)?,
        ),
    )?;
    Ok(())
}

/// An attachment ends once; one not open, ended before or never recorded, changes nothing. The
/// lease ends with it, and the epoch stays, so the next grant is higher.
pub(crate) fn ended(
    tx: &Transaction<'_>,
    id: u64,
    attachment: &AttachmentId,
) -> Result<(), AppendError> {
    let terminal: Option<String> = tx
        .query_row(
            "SELECT terminal_id FROM attachments_open WHERE id = ?",
            [attachment.as_str()],
            |row| row.get(0),
        )
        .optional()?;
    let Some(terminal) = terminal else {
        return Ok(());
    };
    tx.execute(
        "DELETE FROM attachments_open WHERE id = ?",
        [attachment.as_str()],
    )?;
    tx.execute(
        "UPDATE leases SET holder = NULL, updated_event_id = ? WHERE terminal_id = ? AND holder = ?",
        (int(id)?, &terminal, attachment.as_str()),
    )?;
    Ok(())
}

/// The largest integer a JavaScript number holds exactly, past which zod's `int()` refuses one.
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// A terminal's lease went to an attachment, at an epoch the TypeScript payload parses: positive,
/// so a grant is never mistaken for a terminal that has had none, and a safe integer.
pub(crate) fn granted(
    tx: &Transaction<'_>,
    id: u64,
    terminal: &TerminalId,
    payload: &LeaseGranted,
) -> Result<(), AppendError> {
    if !(1..=MAX_SAFE_INTEGER).contains(&payload.epoch) {
        return Err(AppendError::Refused {
            event: "lease.granted",
            reason: format!("its epoch {} isn't a positive safe integer", payload.epoch),
        });
    }
    tx.execute(
        "INSERT INTO leases (terminal_id, holder, epoch, updated_event_id) VALUES (?, ?, ?, ?)
         ON CONFLICT (terminal_id) DO UPDATE SET holder = excluded.holder, epoch = excluded.epoch,
           updated_event_id = excluded.updated_event_id",
        (
            terminal.as_str(),
            payload.attachment_id.as_str(),
            int(payload.epoch)?,
            int(id)?,
        ),
    )?;
    Ok(())
}

impl Reads<'_> {
    /// The epoch of a terminal's last lease grant, or 0 if it has had none.
    ///
    /// # Errors
    ///
    /// `SQLite`'s.
    pub fn lease_epoch(self, terminal: &TerminalId) -> rusqlite::Result<u64> {
        let epoch: Option<i64> = self
            .0
            .query_row(
                "SELECT epoch FROM leases WHERE terminal_id = ?",
                [terminal.as_str()],
                |row| row.get(0),
            )
            .optional()?;
        epoch.map_or(Ok(0), |epoch| {
            u64::try_from(epoch).map_err(|_| rusqlite::Error::IntegralValueOutOfRange(0, epoch))
        })
    }

    /// The attachments recorded as open, oldest first. A row whose id isn't an attachment's is
    /// left out, as the TypeScript store leaves it out, so a database it starts on starts here too.
    ///
    /// # Errors
    ///
    /// `SQLite`'s.
    pub fn open_attachments(self) -> rusqlite::Result<Vec<AttachmentId>> {
        let mut statement = self
            .0
            .prepare("SELECT id FROM attachments_open ORDER BY started_event_id")?;
        let ids = statement
            .query_map((), |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(ids
            .iter()
            .filter_map(|id| AttachmentId::parse(id))
            .collect())
    }
}

impl Writer<'_> {
    /// Ends every attachment still recorded as open as `daemon_restart`, releasing the leases they
    /// held: at start no view is attached any more, and each reattaches for a fresh screen.
    /// Answers how many it ended.
    ///
    /// # Errors
    ///
    /// [`AppendError`]; returned out of [`Store::write`](crate::Store::write), nothing is ended.
    pub fn end_open_attachments(&self) -> Result<usize, AppendError> {
        let open = self.reads().open_attachments()?;
        for attachment in &open {
            self.append(&NewEvent::AttachmentEnded {
                attachment: attachment.clone(),
                payload: AttachmentEnded {
                    reason: AttachmentEndReason::DaemonRestart,
                },
            })?;
        }
        Ok(open.len())
    }
}

#[cfg(test)]
mod tests {
    use bazhen_protocol::events::TerminalOpened;
    use bazhen_protocol::stream::AttachmentMode;

    use super::*;
    use crate::Store;
    use crate::events::{Actor, TerminalChange};
    use crate::testing::TempDir;

    fn attachment(n: u8) -> AttachmentId {
        AttachmentId::mint(1, [n; 16])
    }

    /// A store with one shell opened in the local environment.
    fn opened(dir: &TempDir) -> (Store, TerminalId) {
        let mut store = Store::open(&dir.db("attachments.db")).unwrap();
        let terminal = TerminalId::mint(1, [3; 16]);
        store
            .write(|w| -> Result<_, AppendError> {
                let environment = w.local_environment()?;
                w.append(&NewEvent::Terminal {
                    terminal: terminal.clone(),
                    actor: Actor::User,
                    change: TerminalChange::Opened(TerminalOpened {
                        environment_id: environment,
                        cwd: "/home/me".to_owned(),
                        linked_agent_id: None,
                        theme: None,
                        restart_of: None,
                        runtime: Some("holder".to_owned()),
                    }),
                })
            })
            .unwrap();
        (store, terminal)
    }

    fn append(store: &mut Store, event: &NewEvent) -> Result<u64, AppendError> {
        store.write(|w| w.append(event))
    }

    fn start(store: &mut Store, terminal: &TerminalId, attachment: &AttachmentId) -> u64 {
        append(
            store,
            &NewEvent::AttachmentStarted {
                attachment: attachment.clone(),
                payload: AttachmentStarted {
                    terminal_id: terminal.clone(),
                    mode: AttachmentMode::Interactive,
                },
            },
        )
        .unwrap()
    }

    fn end(store: &mut Store, attachment: &AttachmentId, reason: AttachmentEndReason) -> u64 {
        append(
            store,
            &NewEvent::AttachmentEnded {
                attachment: attachment.clone(),
                payload: AttachmentEnded { reason },
            },
        )
        .unwrap()
    }

    fn grant(
        store: &mut Store,
        terminal: &TerminalId,
        attachment: &AttachmentId,
        epoch: u64,
    ) -> Result<u64, AppendError> {
        append(
            store,
            &NewEvent::LeaseGranted {
                terminal: terminal.clone(),
                payload: LeaseGranted {
                    attachment_id: attachment.clone(),
                    epoch,
                },
            },
        )
    }

    fn holder(store: &Store, terminal: &TerminalId) -> Option<String> {
        store
            .db
            .query_row(
                "SELECT holder FROM leases WHERE terminal_id = ?",
                [terminal.as_str()],
                |row| row.get(0),
            )
            .unwrap()
    }

    fn recorded(store: &Store, id: u64) -> (String, String, String, String) {
        store
            .db
            .query_row(
                "SELECT type, entity_id, actor, payload FROM events WHERE id = ?",
                [int(id).unwrap()],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap()
    }

    #[test]
    fn records_attachments_and_grants_as_the_typescript_daemon_writes_them() {
        let dir = TempDir::new("attachment-payloads");
        let (mut store, terminal) = opened(&dir);
        let laptop = attachment(1);
        let started = start(&mut store, &terminal, &laptop);
        let granted = grant(&mut store, &terminal, &laptop, 1).unwrap();
        let ended = end(&mut store, &laptop, AttachmentEndReason::ClientClosed);
        let t = terminal.as_str();
        let a = laptop.as_str();
        assert_eq!(
            [started, granted, ended].map(|id| recorded(&store, id)),
            [
                (
                    "attachment.started".to_owned(),
                    a.to_owned(),
                    "system".to_owned(),
                    format!(r#"{{"terminalId":"{t}","mode":"interactive"}}"#),
                ),
                (
                    "lease.granted".to_owned(),
                    t.to_owned(),
                    "system".to_owned(),
                    format!(r#"{{"attachmentId":"{a}","epoch":1}}"#),
                ),
                (
                    "attachment.ended".to_owned(),
                    a.to_owned(),
                    "system".to_owned(),
                    r#"{"reason":"client_closed"}"#.to_owned(),
                ),
            ]
        );
    }

    #[test]
    fn keeps_an_attachment_open_until_it_ends_and_names_its_terminal_and_mode() {
        let dir = TempDir::new("attachment-open");
        let (mut store, terminal) = opened(&dir);
        let laptop = attachment(1);
        append(
            &mut store,
            &NewEvent::AttachmentStarted {
                attachment: laptop.clone(),
                payload: AttachmentStarted {
                    terminal_id: terminal.clone(),
                    mode: AttachmentMode::Observe,
                },
            },
        )
        .unwrap();
        let row: (String, String) = store
            .db
            .query_row(
                "SELECT terminal_id, mode FROM attachments_open WHERE id = ?",
                [laptop.as_str()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(row, (terminal.as_str().to_owned(), "observe".to_owned()));
        end(&mut store, &laptop, AttachmentEndReason::Disconnected);
        assert_eq!(store.reads().open_attachments().unwrap(), []);
    }

    #[test]
    fn ends_the_lease_with_the_attachment_that_holds_it_and_keeps_the_epoch() {
        let dir = TempDir::new("attachment-lease");
        let (mut store, terminal) = opened(&dir);
        let laptop = attachment(1);
        start(&mut store, &terminal, &laptop);
        grant(&mut store, &terminal, &laptop, 3).unwrap();
        assert_eq!(holder(&store, &terminal).as_deref(), Some(laptop.as_str()));
        end(&mut store, &laptop, AttachmentEndReason::ClientClosed);
        assert_eq!(holder(&store, &terminal), None);
        assert_eq!(store.reads().lease_epoch(&terminal).unwrap(), 3);
    }

    #[test]
    fn leaves_the_lease_with_its_holder_when_another_attachment_ends() {
        let dir = TempDir::new("attachment-other");
        let (mut store, terminal) = opened(&dir);
        let (laptop, phone) = (attachment(1), attachment(2));
        start(&mut store, &terminal, &laptop);
        start(&mut store, &terminal, &phone);
        grant(&mut store, &terminal, &laptop, 1).unwrap();
        end(&mut store, &phone, AttachmentEndReason::ClientClosed);
        assert_eq!(holder(&store, &terminal).as_deref(), Some(laptop.as_str()));
        assert_eq!(store.reads().open_attachments().unwrap(), [laptop]);
    }

    #[test]
    fn records_the_end_of_an_attachment_it_never_saw_open_and_changes_nothing() {
        let dir = TempDir::new("attachment-unknown");
        let (mut store, terminal) = opened(&dir);
        let laptop = attachment(1);
        start(&mut store, &terminal, &laptop);
        grant(&mut store, &terminal, &laptop, 1).unwrap();
        let ended = end(&mut store, &attachment(9), AttachmentEndReason::Replaced);
        assert_eq!(recorded(&store, ended).0, "attachment.ended");
        assert_eq!(holder(&store, &terminal).as_deref(), Some(laptop.as_str()));
        assert_eq!(store.reads().open_attachments().unwrap(), [laptop]);
    }

    #[test]
    fn moves_the_lease_to_each_grant_and_answers_its_epoch_or_0_before_any() {
        let dir = TempDir::new("lease-epoch");
        let (mut store, terminal) = opened(&dir);
        let (laptop, phone) = (attachment(1), attachment(2));
        assert_eq!(store.reads().lease_epoch(&terminal).unwrap(), 0);
        grant(&mut store, &terminal, &laptop, 1).unwrap();
        grant(&mut store, &terminal, &phone, 2).unwrap();
        assert_eq!(holder(&store, &terminal).as_deref(), Some(phone.as_str()));
        assert_eq!(store.reads().lease_epoch(&terminal).unwrap(), 2);
    }

    #[test]
    fn refuses_a_grant_at_an_epoch_the_typescript_payload_refuses_and_takes_the_safe_bounds() {
        let dir = TempDir::new("lease-bounds");
        let (mut store, terminal) = opened(&dir);
        for epoch in [0, MAX_SAFE_INTEGER + 1] {
            let refused = grant(&mut store, &terminal, &attachment(1), epoch);
            assert!(
                matches!(
                    refused,
                    Err(AppendError::Refused {
                        event: "lease.granted",
                        ..
                    })
                ),
                "{epoch}: {refused:?}"
            );
        }
        for epoch in [1, MAX_SAFE_INTEGER] {
            grant(&mut store, &terminal, &attachment(1), epoch).unwrap();
            assert_eq!(store.reads().lease_epoch(&terminal).unwrap(), epoch);
        }
    }

    #[test]
    fn leaves_out_an_open_row_whose_id_isn_t_an_attachment_s_as_the_typescript_store_does() {
        let dir = TempDir::new("attachment-malformed");
        let (mut store, terminal) = opened(&dir);
        let laptop = attachment(1);
        let started = start(&mut store, &terminal, &laptop);
        store
            .db
            .execute(
                "INSERT INTO attachments_open (id, terminal_id, mode, started_event_id)
                 VALUES ('not-an-id', ?, 'observe', ?)",
                (terminal.as_str(), int(started).unwrap()),
            )
            .unwrap();
        assert_eq!(store.reads().open_attachments().unwrap(), [laptop]);
    }

    #[test]
    fn ends_every_open_attachment_as_a_restart_oldest_first_and_frees_the_lease() {
        let dir = TempDir::new("attachment-restart");
        let (mut store, terminal) = opened(&dir);
        let (laptop, phone, gone) = (attachment(2), attachment(1), attachment(3));
        start(&mut store, &terminal, &laptop);
        start(&mut store, &terminal, &phone);
        start(&mut store, &terminal, &gone);
        end(&mut store, &gone, AttachmentEndReason::ClientClosed);
        grant(&mut store, &terminal, &phone, 4).unwrap();
        let before = store.reads().latest_event_id().unwrap();
        let ended = store
            .write(|w: &Writer<'_>| w.end_open_attachments())
            .unwrap();
        assert_eq!(ended, 2);
        let a = |id: &AttachmentId| {
            (
                "attachment.ended".to_owned(),
                id.as_str().to_owned(),
                "system".to_owned(),
                r#"{"reason":"daemon_restart"}"#.to_owned(),
            )
        };
        assert_eq!(
            [before + 1, before + 2].map(|id| recorded(&store, id)),
            [a(&laptop), a(&phone)]
        );
        assert_eq!(store.reads().open_attachments().unwrap(), []);
        assert_eq!(holder(&store, &terminal), None);
        assert_eq!(store.reads().lease_epoch(&terminal).unwrap(), 4);
    }
}
