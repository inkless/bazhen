//! Paired devices and the notices they open, as `store.ts` and `attention/notices.ts` keep them:
//! a device paired opens its notice in the same transaction, a revocation is flushed to disk and
//! closes the device's open notices, and only the owner on this machine dismisses one.

use std::time::Duration;

use bazhen_protocol::events::{DevicePaired, NoticeClosed, NoticeOpened};
use bazhen_protocol::ids::{DeviceId, NoticeId};
use bazhen_protocol::notices::{
    DEVICE_PAIRED, Device, DismissNoticeResponse, NoticeCloseReason, NoticeCloser, NoticeDevice,
};
use bazhen_protocol::time::timestamp_ms;
use rusqlite::OptionalExtension;
use serde::Serialize;

use crate::events::Reads;
use crate::{AppendError, NewEvent, OnceError, Store};

/// How long a device paired over HTTPS stays paired without being used.
pub const SECURE_IDLE: Duration = Duration::from_hours(30 * 24);
/// The same for one paired over plain HTTP, whose cookie other local ports can read.
pub const LOOPBACK_IDLE: Duration = Duration::from_hours(24);
/// How stale a device's last use may get before a request records it, and sets the cookie again.
pub const TOUCH_EVERY: Duration = Duration::from_hours(1);

/// What a pairing's notice says, here and on a locked screen: nothing the device chose.
const DEVICE_PAIRED_SUMMARY: &str = "A new device paired";

/// A device to pair: its name as it may be stored, the hash of its token (never the token), and
/// where it paired from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewDevice {
    pub name: String,
    pub token_hash: String,
    /// Paired over HTTPS.
    pub secure: bool,
    /// The allowed origin it paired from.
    pub origin: String,
    /// The connection's own peer, on the LAN listener only.
    pub address: Option<String>,
    /// Paired through a forwarder: over loopback TCP from a socket no readable process holds,
    /// each process that may hold it the human's.
    pub forwarded: bool,
}

/// A device just paired.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Paired {
    pub device_id: DeviceId,
    pub name: String,
}

/// What a revocation did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Revoked {
    /// The device was paired, and is revoked now.
    Now,
    /// It was revoked already, and nothing more was recorded.
    Already,
}

/// What the cookie gate needs of a device, revoked or not.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceRow {
    pub id: DeviceId,
    pub name: String,
    /// When it was last used, in milliseconds since the epoch.
    pub last_seen_at_ms: i64,
    pub revoked: bool,
    /// Paired over HTTPS.
    pub secure: bool,
    /// Paired through a forwarder.
    pub forwarded: bool,
}

impl DeviceRow {
    /// How long it stays paired unused.
    pub fn idle_limit(&self) -> Duration {
        idle_limit(self.secure)
    }
}

fn idle_limit(secure: bool) -> Duration {
    if secure { SECURE_IDLE } else { LOOPBACK_IDLE }
}

/// Who asks to dismiss a notice: the owner on this machine, by the Unix socket or from a loopback
/// browser where no device must pair, or a paired device.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Viewer {
    OwnerSocket,
    OwnerLoopback,
    Device(DeviceId),
}

impl Viewer {
    /// The viewer as the TypeScript daemon names it in a request it keeps under its key.
    pub fn as_str(&self) -> &str {
        match self {
            Self::OwnerSocket => NoticeCloser::OwnerSocket.as_str(),
            Self::OwnerLoopback => NoticeCloser::OwnerLoopback.as_str(),
            Self::Device(id) => id.as_str(),
        }
    }
}

/// A dismissal of a notice, once per idempotency key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Dismissal {
    /// The notice's id, as the request named it.
    pub notice: String,
    pub key: String,
    pub by: Viewer,
    /// Advisory: the device whose shell a socket call came from, as that shell's environment
    /// claimed. Recorded only from the Unix socket, and only for a device this daemon paired.
    pub from_device: Option<DeviceId>,
}

/// The request as the TypeScript daemon keeps it under its key.
#[derive(Serialize)]
struct Kept<'a> {
    notice: &'a str,
    dismiss: bool,
    by: &'a str,
}

impl Dismissal {
    /// The text a repeat of this request must match, as the TypeScript daemon writes it.
    ///
    /// # Errors
    ///
    /// `serde_json`'s, which a struct of strings never meets.
    pub fn request_text(&self) -> serde_json::Result<String> {
        serde_json::to_string(&Kept {
            notice: &self.notice,
            dismiss: true,
            by: self.by.as_str(),
        })
    }
}

/// Why a device wasn't paired.
#[derive(Debug, thiserror::Error)]
pub enum PairError {
    #[error(transparent)]
    Append(#[from] AppendError),
    #[error("can't mint an id: {0}")]
    Random(#[from] std::io::Error),
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
}

/// Why a device wasn't revoked.
#[derive(Debug, thiserror::Error)]
pub enum RevokeError {
    #[error("no device {0}")]
    Unknown(String),
    #[error(transparent)]
    Append(#[from] AppendError),
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
}

/// Why a notice wasn't dismissed.
#[derive(Debug, thiserror::Error)]
pub enum DismissError {
    /// The notice is closed, or never was.
    #[error("notice {0} is not open")]
    NotOpen(String),
    /// A paired device asked: one paired with a stolen code would otherwise hide its own pairing.
    #[error("notice {0} can't be answered with dismiss by this device")]
    ByDevice(String),
    #[error(transparent)]
    Once(#[from] OnceError),
    #[error(transparent)]
    Append(#[from] AppendError),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
}

impl Store {
    /// Records a newly paired device under the hash of its token, and opens its notice in the
    /// same transaction, so no crash leaves a pairing the inbox never shows.
    ///
    /// # Errors
    ///
    /// [`PairError`], a token hash already paired among them; nothing is recorded then.
    pub fn pair_device(&mut self, device: &NewDevice) -> Result<Paired, PairError> {
        self.write(|w| {
            let id = DeviceId::mint(crate::now_ms(), crate::urandom()?);
            let at = crate::now();
            w.connection().execute(
                "INSERT INTO devices
                   (id, name, token_hash, paired_at, last_seen_at, secure, forwarded)
                 VALUES (?, ?, ?, ?, ?, ?, ?)",
                (
                    id.as_str(),
                    &device.name,
                    &device.token_hash,
                    &at,
                    &at,
                    i64::from(device.secure),
                    i64::from(device.forwarded),
                ),
            )?;
            w.append(&NewEvent::DevicePaired {
                device: id.clone(),
                payload: DevicePaired {
                    name: device.name.clone(),
                },
            })?;
            w.append(&NewEvent::NoticeOpened {
                notice: NoticeId::mint(crate::now_ms(), crate::urandom()?),
                payload: NoticeOpened {
                    kind: DEVICE_PAIRED.to_owned(),
                    summary: DEVICE_PAIRED_SUMMARY.to_owned(),
                    device: Some(NoticeDevice {
                        id: id.clone(),
                        name: device.name.clone(),
                        origin: device.origin.clone(),
                        address: device.address.clone(),
                    }),
                },
            })?;
            Ok(Paired {
                device_id: id,
                name: device.name.clone(),
            })
        })
    }

    /// Revokes a device and closes its open notices, flushed to disk as it commits: lost to a
    /// crash, a revocation would let the device back in. One already revoked is left as it is.
    ///
    /// # Errors
    ///
    /// [`RevokeError::Unknown`] for a device never paired, or `SQLite`'s; nothing is recorded then.
    pub fn revoke_device(&mut self, id: &str) -> Result<Revoked, RevokeError> {
        self.write_durable(|w| {
            let db = w.connection();
            let revoked_at: Option<Option<String>> = db
                .query_row("SELECT revoked_at FROM devices WHERE id = ?", [id], |row| {
                    row.get(0)
                })
                .optional()?;
            let device = match (revoked_at, DeviceId::parse(id)) {
                (Some(None), Some(device)) => device,
                (Some(Some(_)), _) => return Ok(Revoked::Already),
                _ => return Err(RevokeError::Unknown(id.to_owned())),
            };
            db.execute(
                "UPDATE devices SET revoked_at = ? WHERE id = ?",
                (crate::now(), id),
            )?;
            w.append(&NewEvent::DeviceRevoked {
                device: device.clone(),
            })?;
            let open: Vec<String> = db
                .prepare(
                    "SELECT id FROM notices WHERE state = 'open' AND device_id = ?
                     ORDER BY created_event_id",
                )?
                .query_map([id], |row| row.get(0))?
                .collect::<rusqlite::Result<_>>()?;
            for notice in open.iter().filter_map(|n| NoticeId::parse(n)) {
                w.append(&NewEvent::NoticeClosed {
                    notice,
                    payload: NoticeClosed {
                        reason: NoticeCloseReason::Revoked,
                        by: NoticeCloser::Revoke,
                        from_device: None,
                    },
                })?;
            }
            Ok(Revoked::Now)
        })
    }

    /// Records that the device was used now.
    ///
    /// # Errors
    ///
    /// `SQLite`'s.
    pub fn touch_device(&mut self, id: &DeviceId) -> rusqlite::Result<()> {
        self.db.execute(
            "UPDATE devices SET last_seen_at = ? WHERE id = ?",
            (crate::now(), id.as_str()),
        )?;
        Ok(())
    }

    /// Dismisses an open notice for the owner on this machine, or answers what its key was first
    /// answered. A paired device dismisses none.
    ///
    /// # Errors
    ///
    /// [`DismissError`]; nothing is recorded then.
    pub fn dismiss_notice(
        &mut self,
        dismissal: &Dismissal,
    ) -> Result<DismissNoticeResponse, DismissError> {
        self.once(&dismissal.key, &dismissal.request_text()?, |w| {
            let not_open = || DismissError::NotOpen(dismissal.notice.clone());
            let notice = NoticeId::parse(&dismissal.notice).ok_or_else(not_open)?;
            let open = w
                .connection()
                .prepare("SELECT 1 FROM notices WHERE id = ? AND state = 'open'")?
                .exists([notice.as_str()])?;
            if !open {
                return Err(not_open());
            }
            let by = match dismissal.by {
                Viewer::OwnerSocket => NoticeCloser::OwnerSocket,
                Viewer::OwnerLoopback => NoticeCloser::OwnerLoopback,
                Viewer::Device(_) => return Err(DismissError::ByDevice(dismissal.notice.clone())),
            };
            let from_device = match (&dismissal.by, &dismissal.from_device) {
                (Viewer::OwnerSocket, Some(device))
                    if Reads(w.connection()).paired_ever(device.as_str())? =>
                {
                    Some(device.clone())
                }
                _ => None,
            };
            let closed = w.append(&NewEvent::NoticeClosed {
                notice,
                payload: NoticeClosed {
                    reason: NoticeCloseReason::Dismissed,
                    by,
                    from_device,
                },
            })?;
            Ok(DismissNoticeResponse {
                event_ids: vec![closed],
            })
        })
    }
}

/// A stored value that isn't what the column holds.
#[derive(Debug, thiserror::Error)]
#[error("{0}")]
struct Malformed(String);

fn malformed(column: usize, what: String) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(
        column,
        rusqlite::types::Type::Text,
        Box::new(Malformed(what)),
    )
}

fn device_id(row: &rusqlite::Row<'_>, column: usize) -> rusqlite::Result<DeviceId> {
    let id: String = row.get(column)?;
    DeviceId::parse(&id).ok_or_else(|| malformed(column, format!("not a device id: {id}")))
}

fn millis(row: &rusqlite::Row<'_>, column: usize) -> rusqlite::Result<i64> {
    let at: String = row.get(column)?;
    timestamp_ms(&at).ok_or_else(|| malformed(column, format!("not a time: {at}")))
}

impl Reads<'_> {
    /// The device whose token hashes to `token_hash`, revoked or not.
    ///
    /// # Errors
    ///
    /// `SQLite`'s, or a stored id or time that isn't one.
    pub fn device_by_token(self, token_hash: &str) -> rusqlite::Result<Option<DeviceRow>> {
        self.0
            .query_row(
                "SELECT id, name, last_seen_at, revoked_at IS NOT NULL, secure, forwarded
                 FROM devices WHERE token_hash = ?",
                [token_hash],
                |row| {
                    Ok(DeviceRow {
                        id: device_id(row, 0)?,
                        name: row.get(1)?,
                        last_seen_at_ms: millis(row, 2)?,
                        revoked: row.get(3)?,
                        secure: row.get::<_, i64>(4)? == 1,
                        forwarded: row.get::<_, i64>(5)? == 1,
                    })
                },
            )
            .optional()
    }

    /// Every device not revoked, oldest first, expired ones too, each with when it lapses unless
    /// it is used before then.
    ///
    /// # Errors
    ///
    /// `SQLite`'s, or a stored id or time that isn't one.
    pub fn devices(self) -> rusqlite::Result<Vec<Device>> {
        self.0
            .prepare(
                "SELECT id, name, paired_at, last_seen_at, secure FROM devices
                 WHERE revoked_at IS NULL ORDER BY paired_at, id",
            )?
            .query_map((), |row| {
                let secure = row.get::<_, i64>(4)? == 1;
                let limit = i64::try_from(idle_limit(secure).as_millis()).unwrap_or(i64::MAX);
                let lapses = millis(row, 3)?.saturating_add(limit);
                let expires_at = jiff::Timestamp::from_millisecond(lapses)
                    .map_err(|_| malformed(3, format!("lapses past any time: {lapses}")))?;
                Ok(Device {
                    id: device_id(row, 0)?,
                    name: row.get(1)?,
                    paired_at: row.get(2)?,
                    last_seen_at: row.get(3)?,
                    expires_at: crate::iso(expires_at),
                })
            })?
            .collect()
    }

    /// Whether `id` names a device this daemon paired, revoked or not.
    ///
    /// # Errors
    ///
    /// `SQLite`'s.
    pub fn paired_ever(self, id: &str) -> rusqlite::Result<bool> {
        self.0
            .prepare("SELECT 1 FROM devices WHERE id = ?")?
            .exists([id])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::TempDir;

    fn device(name: &str, token: char, secure: bool) -> NewDevice {
        NewDevice {
            name: name.to_owned(),
            token_hash: token.to_string().repeat(64),
            secure,
            origin: "http://127.0.0.1:7900".to_owned(),
            address: None,
            forwarded: false,
        }
    }

    /// The notice the device's pairing opened.
    fn notice_of(store: &Store, device: &DeviceId) -> String {
        store
            .db
            .query_row(
                "SELECT id FROM notices WHERE device_id = ?",
                [device.as_str()],
                |row| row.get(0),
            )
            .unwrap()
    }

    fn closed(store: &Store, notice: &str) -> (String, Option<String>, Option<String>) {
        store
            .db
            .query_row(
                "SELECT state, close_reason, closed_from_device FROM notices WHERE id = ?",
                [notice],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap()
    }

    fn dismissal(key: &str, notice: &str, by: Viewer) -> Dismissal {
        Dismissal {
            notice: notice.to_owned(),
            key: key.to_owned(),
            by,
            from_device: None,
        }
    }

    #[test]
    fn pairs_nothing_when_its_token_hash_is_already_paired() {
        let dir = TempDir::new("pair-twice");
        let mut store = Store::open(&dir.db("a.db")).unwrap();
        store.pair_device(&device("Laptop", 'a', false)).unwrap();
        let again = store.pair_device(&device("Phone", 'a', true));
        assert!(matches!(again, Err(PairError::Sqlite(_))), "{again:?}");
        let notices: i64 = store
            .db
            .query_row("SELECT count(*) FROM notices", (), |row| row.get(0))
            .unwrap();
        assert_eq!((store.reads().latest_event_id().unwrap(), notices), (2, 1));
    }

    #[test]
    fn revokes_once_closing_only_that_devices_open_notice_and_refuses_a_device_never_paired() {
        let dir = TempDir::new("revoke");
        let mut store = Store::open(&dir.db("a.db")).unwrap();
        let laptop = store
            .pair_device(&device("Laptop", 'a', false))
            .unwrap()
            .device_id;
        let phone = store
            .pair_device(&device("Phone", 'b', true))
            .unwrap()
            .device_id;
        let (laptops, phones) = (notice_of(&store, &laptop), notice_of(&store, &phone));
        assert_eq!(store.revoke_device(phone.as_str()).unwrap(), Revoked::Now);
        let after = store.reads().latest_event_id().unwrap();
        assert_eq!(
            store.revoke_device(phone.as_str()).unwrap(),
            Revoked::Already
        );
        assert_eq!(store.reads().latest_event_id().unwrap(), after);
        assert_eq!(
            [closed(&store, &phones), closed(&store, &laptops)],
            [
                ("closed".to_owned(), Some("revoked".to_owned()), None),
                ("open".to_owned(), None, None)
            ]
        );
        let never = DeviceId::mint(1, [7; 16]);
        for id in [never.as_str(), "nope"] {
            let refused = store.revoke_device(id);
            assert!(
                matches!(&refused, Err(RevokeError::Unknown(i)) if i == id),
                "{refused:?}"
            );
        }
        assert_eq!(store.reads().latest_event_id().unwrap(), after);
    }

    #[test]
    fn revoking_leaves_a_notice_already_dismissed_as_it_was() {
        let dir = TempDir::new("revoke-dismissed");
        let mut store = Store::open(&dir.db("a.db")).unwrap();
        let laptop = store
            .pair_device(&device("Laptop", 'a', false))
            .unwrap()
            .device_id;
        let notice = notice_of(&store, &laptop);
        store
            .dismiss_notice(&dismissal("k", &notice, Viewer::OwnerLoopback))
            .unwrap();
        assert_eq!(store.revoke_device(laptop.as_str()).unwrap(), Revoked::Now);
        assert_eq!(
            closed(&store, &notice),
            ("closed".to_owned(), Some("dismissed".to_owned()), None)
        );
    }

    #[test]
    fn dismisses_for_the_owner_only_and_refuses_a_notice_not_open() {
        let dir = TempDir::new("dismiss");
        let mut store = Store::open(&dir.db("a.db")).unwrap();
        let laptop = store
            .pair_device(&device("Laptop", 'a', false))
            .unwrap()
            .device_id;
        let notice = notice_of(&store, &laptop);
        let by_device = store.dismiss_notice(&dismissal("d", &notice, Viewer::Device(laptop)));
        assert!(
            matches!(&by_device, Err(DismissError::ByDevice(n)) if *n == notice),
            "{by_device:?}"
        );
        let unknown = NoticeId::mint(1, [7; 16]);
        for id in [unknown.as_str(), "ntc_nope"] {
            let refused = store.dismiss_notice(&dismissal(id, id, Viewer::OwnerSocket));
            assert!(
                matches!(&refused, Err(DismissError::NotOpen(n)) if n == id),
                "{refused:?}"
            );
        }
        assert_eq!(store.reads().latest_event_id().unwrap(), 2);
        let first = store
            .dismiss_notice(&dismissal("k", &notice, Viewer::OwnerSocket))
            .unwrap();
        assert_eq!(first.event_ids, [3]);
        let again = store.dismiss_notice(&dismissal("k", &notice, Viewer::OwnerSocket));
        assert_eq!(again.unwrap(), first);
        let closed_now = store.dismiss_notice(&dismissal("k2", &notice, Viewer::OwnerSocket));
        assert!(
            matches!(closed_now, Err(DismissError::NotOpen(_))),
            "{closed_now:?}"
        );
        let other = store.dismiss_notice(&dismissal("k", &notice, Viewer::OwnerLoopback));
        assert!(
            matches!(other, Err(DismissError::Once(OnceError::Conflict(_)))),
            "{other:?}"
        );
        assert_eq!(store.reads().latest_event_id().unwrap(), 3);
    }

    #[test]
    fn records_the_device_a_dismissal_came_from_only_from_the_socket_and_only_one_ever_paired() {
        let dir = TempDir::new("dismiss-from");
        let mut store = Store::open(&dir.db("a.db")).unwrap();
        let paired: Vec<DeviceId> = ['a', 'b', 'c', 'd']
            .into_iter()
            .map(|t| store.pair_device(&device("D", t, true)).unwrap().device_id)
            .collect();
        let revoked = paired[3].clone();
        store.revoke_device(revoked.as_str()).unwrap();
        let never = DeviceId::mint(1, [7; 16]);
        let cases = [
            (Viewer::OwnerSocket, Some(revoked.clone()), Some(revoked)),
            (Viewer::OwnerSocket, Some(never), None),
            (Viewer::OwnerLoopback, Some(paired[0].clone()), None),
        ];
        for (n, (by, from, recorded)) in cases.into_iter().enumerate() {
            let notice = notice_of(&store, &paired[n]);
            store
                .dismiss_notice(&Dismissal {
                    from_device: from,
                    ..dismissal(&format!("k{n}"), &notice, by)
                })
                .unwrap();
            assert_eq!(
                closed(&store, &notice).2,
                recorded.as_ref().map(|d| d.as_str().to_owned()),
                "case {n}"
            );
        }
    }

    #[test]
    fn refuses_to_close_a_notice_that_is_closed_or_was_never_opened() {
        let dir = TempDir::new("close-twice");
        let mut store = Store::open(&dir.db("a.db")).unwrap();
        let laptop = store
            .pair_device(&device("Laptop", 'a', false))
            .unwrap()
            .device_id;
        let notice = NoticeId::parse(&notice_of(&store, &laptop)).unwrap();
        store.revoke_device(laptop.as_str()).unwrap();
        let close = |notice: NoticeId| NewEvent::NoticeClosed {
            notice,
            payload: NoticeClosed {
                reason: NoticeCloseReason::Dismissed,
                by: NoticeCloser::OwnerSocket,
                from_device: None,
            },
        };
        let before = store.reads().latest_event_id().unwrap();
        for notice in [notice, NoticeId::mint(1, [7; 16])] {
            let refused = store.write(|w| w.append(&close(notice.clone())));
            assert!(
                matches!(refused, Err(AppendError::Refused { .. })),
                "{refused:?}"
            );
        }
        assert_eq!(store.reads().latest_event_id().unwrap(), before);
    }

    #[test]
    fn lists_devices_not_revoked_oldest_first_each_lapsing_by_how_it_paired() {
        let dir = TempDir::new("devices");
        let mut store = Store::open(&dir.db("a.db")).unwrap();
        let ids: Vec<DeviceId> = [('a', false), ('b', true), ('c', true)]
            .into_iter()
            .map(|(t, secure)| {
                store
                    .pair_device(&device("D", t, secure))
                    .unwrap()
                    .device_id
            })
            .collect();
        store.revoke_device(ids[2].as_str()).unwrap();
        // The later device paired first, so the list is by when, not by id.
        for (id, at) in [
            (&ids[0], "2026-11-02T00:00:00.000Z"),
            (&ids[1], "2026-11-01T00:00:00.000Z"),
        ] {
            store
                .db
                .execute(
                    "UPDATE devices SET paired_at = ?, last_seen_at = ? WHERE id = ?",
                    (at, "2026-11-10T12:30:00.250Z", id.as_str()),
                )
                .unwrap();
        }
        let listed: Vec<(String, String, String)> = store
            .reads()
            .devices()
            .unwrap()
            .into_iter()
            .map(|d| (d.id.as_str().to_owned(), d.paired_at, d.expires_at))
            .collect();
        assert_eq!(
            listed,
            [
                (
                    ids[1].as_str().to_owned(),
                    "2026-11-01T00:00:00.000Z".to_owned(),
                    "2026-12-10T12:30:00.250Z".to_owned()
                ),
                (
                    ids[0].as_str().to_owned(),
                    "2026-11-02T00:00:00.000Z".to_owned(),
                    "2026-11-11T12:30:00.250Z".to_owned()
                ),
            ]
        );
    }

    #[test]
    fn finds_a_device_by_its_tokens_hash_revoked_or_not_with_when_it_was_last_used_and_how_it_paired()
     {
        let dir = TempDir::new("by-token");
        let mut store = Store::open(&dir.db("a.db")).unwrap();
        let laptop = store
            .pair_device(&device("Laptop", 'a', false))
            .unwrap()
            .device_id;
        let phone = store
            .pair_device(&NewDevice {
                forwarded: true,
                ..device("Phone", 'b', true)
            })
            .unwrap()
            .device_id;
        store.revoke_device(phone.as_str()).unwrap();
        store
            .db
            .execute(
                "UPDATE devices SET last_seen_at = '2026-11-10T00:00:00.007Z' WHERE id = ?",
                [laptop.as_str()],
            )
            .unwrap();
        let by = |token: char| store.reads().device_by_token(&token.to_string().repeat(64));
        let found = by('a').unwrap().unwrap();
        assert_eq!(
            found,
            DeviceRow {
                id: laptop,
                name: "Laptop".to_owned(),
                last_seen_at_ms: 1_794_268_800_007,
                revoked: false,
                secure: false,
                forwarded: false,
            }
        );
        assert_eq!(found.idle_limit(), LOOPBACK_IDLE);
        let revoked = by('b').unwrap().unwrap();
        assert_eq!(
            (revoked.revoked, revoked.secure, revoked.forwarded),
            (true, true, true)
        );
        assert_eq!(revoked.idle_limit(), SECURE_IDLE);
        assert_eq!(by('c').unwrap(), None);
    }

    #[test]
    fn records_a_use_of_a_device_as_now() {
        let dir = TempDir::new("touch");
        let mut store = Store::open(&dir.db("a.db")).unwrap();
        let laptop = store
            .pair_device(&device("Laptop", 'a', false))
            .unwrap()
            .device_id;
        store
            .db
            .execute(
                "UPDATE devices SET last_seen_at = '2000-01-01T00:00:00.000Z'",
                (),
            )
            .unwrap();
        let before = crate::now_ms();
        store.touch_device(&laptop).unwrap();
        let seen = store
            .reads()
            .device_by_token(&"a".repeat(64))
            .unwrap()
            .unwrap()
            .last_seen_at_ms;
        assert!(u64::try_from(seen).unwrap() >= before, "{seen} < {before}");
    }

    #[test]
    fn knows_a_device_it_paired_revoked_or_not_and_no_other() {
        let dir = TempDir::new("paired-ever");
        let mut store = Store::open(&dir.db("a.db")).unwrap();
        let laptop = store
            .pair_device(&device("Laptop", 'a', false))
            .unwrap()
            .device_id;
        store.revoke_device(laptop.as_str()).unwrap();
        let reads = store.reads();
        assert_eq!(
            [
                reads.paired_ever(laptop.as_str()).unwrap(),
                reads
                    .paired_ever(DeviceId::mint(1, [7; 16]).as_str())
                    .unwrap()
            ],
            [true, false]
        );
    }

    #[test]
    fn snapshots_every_open_notice_and_the_twenty_last_closed_oldest_first() {
        let dir = TempDir::new("snapshot-notices");
        let mut store = Store::open(&dir.db("a.db")).unwrap();
        let notices: Vec<String> = (0..23_u8)
            .map(|n| {
                let paired = store
                    .pair_device(&NewDevice {
                        token_hash: format!("{n:064}"),
                        ..device("D", 'x', true)
                    })
                    .unwrap();
                notice_of(&store, &paired.device_id)
            })
            .collect();
        // Closed newest first, so the two closed earliest, and left out, were opened last.
        for (n, notice) in notices.iter().take(22).enumerate().rev() {
            store
                .dismiss_notice(&dismissal(&format!("k{n}"), notice, Viewer::OwnerSocket))
                .unwrap();
        }
        let shown: Vec<(String, Vec<String>)> = store
            .reads()
            .snapshot(&crate::testing::view())
            .unwrap()
            .notices
            .into_iter()
            .map(|n| (n.id.as_str().to_owned(), n.actions))
            .collect();
        let expected: Vec<(String, Vec<String>)> = notices
            .iter()
            .take(20)
            .map(|n| (n.clone(), vec![]))
            .chain([(notices[22].clone(), vec!["dismiss".to_owned()])])
            .collect();
        assert_eq!(shown, expected);
    }

    #[test]
    fn keeps_a_dismissal_as_the_typescript_daemon_keeps_it_under_its_key() {
        let notice = "ntc_0190c3b2a1d47a3b8c1d2e3f4a5b6c7d";
        let device = DeviceId::mint(1, [7; 16]);
        let texts = [
            Viewer::OwnerSocket,
            Viewer::OwnerLoopback,
            Viewer::Device(device.clone()),
        ]
        .map(|by| dismissal("k", notice, by).request_text().unwrap());
        assert_eq!(
            texts,
            [
                format!(r#"{{"notice":"{notice}","dismiss":true,"by":"owner-socket"}}"#),
                format!(r#"{{"notice":"{notice}","dismiss":true,"by":"owner-loopback"}}"#),
                format!(r#"{{"notice":"{notice}","dismiss":true,"by":"{device}"}}"#),
            ]
        );
    }
}
