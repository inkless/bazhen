//! What `bazhen terminals attach` makes of each thing that happens while it is attached: a key the person
//! typed, a frame the daemon sent, the terminal resized. No I/O: each step returns what to do.

use bazhen_protocol::id::PROTOCOL_ID;
use bazhen_protocol::input::has_keystrokes;
use bazhen_protocol::stream::{AttachmentMode, EndedReason, StreamClientFrame, StreamServerFrame};

/// `Ctrl-\`: twice in a row detaches.
pub const DETACH: u8 = 0x1c;

/// The most keys held while the attachment can't yet send them: a paste, not a flood.
const HELD_MAX: usize = 64 << 10;

/// The sizes a view may have, either way.
const SIDE: std::ops::RangeInclusive<u16> = 2..=1000;

/// A terminal's size, in cells, as a view may give it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Size {
    pub cols: u16,
    pub rows: u16,
}

impl Size {
    /// The size of a terminal `cols` by `rows`, brought within what a view may say: a terminal
    /// too small or too large to be one is attached at the nearest size that is.
    #[must_use]
    pub fn clamped(cols: u16, rows: u16) -> Self {
        Self {
            cols: cols.clamp(*SIDE.start(), *SIDE.end()),
            rows: rows.clamp(*SIDE.start(), *SIDE.end()),
        }
    }
}

/// How an attachment ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Ending {
    /// The person detached.
    Detached,
    /// A signal asked this process to stop.
    Stopped,
    /// A direct attachment let go of the terminal's input for a daemon that came back.
    Yielded,
    /// The terminal closed.
    Exited,
    /// The daemon ended the view for falling behind; a new one starts from a fresh snapshot.
    Evicted,
    /// The daemon's client lost the terminal.
    Lost,
    /// The daemon refused the view, or sent what this build can't read.
    Failed(String),
}

/// One thing to do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Effect {
    /// A text frame for the daemon.
    Send(StreamClientFrame),
    /// Keys for the terminal, as a binary frame.
    Input(Vec<u8>),
    /// Something the person should read once their terminal is theirs again.
    Note(String),
    End(Ending),
}

/// Where an attachment stands with the terminal's lease.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
enum Standing {
    /// Another view drives, or none does.
    #[default]
    Watching,
    /// It has asked for the lease since the latest one named another driver.
    Asked,
    /// The latest lease names it the driver.
    Driving,
}

/// The keys the person types, but for two `Ctrl-\` in a row, which detach. A `Ctrl-\` followed
/// by any other key goes out with that key, however the reads split them.
#[derive(Debug, Default)]
pub struct DetachKeys {
    /// A `Ctrl-\` held back until the next key says whether it detaches.
    held: bool,
}

impl DetachKeys {
    /// The keys to send of `keys`, and whether they detach, after which the rest are dropped.
    pub fn scan(&mut self, keys: &[u8]) -> (Vec<u8>, bool) {
        let mut typed = Vec::with_capacity(keys.len() + 1);
        for &key in keys {
            if self.held {
                self.held = false;
                if key == DETACH {
                    return (typed, true);
                }
                typed.push(DETACH);
            }
            if key == DETACH {
                self.held = true;
            } else {
                typed.push(key);
            }
        }
        (typed, false)
    }
}

/// One attachment's state between steps.
#[derive(Debug, Default)]
pub struct Attachment {
    keys: DetachKeys,
    attached: bool,
    /// The epoch of the latest lease, sent once attached.
    epoch: Option<u64>,
    /// Where this attachment stands with the lease: only the driver's keys reach the terminal.
    lease: Standing,
    /// Keys the daemon would drop if sent now: before an epoch is declared, or while another view
    /// drives. Sent once this attachment drives under a declared epoch.
    held: Vec<u8>,
    /// How many bytes of keys past what `held` keeps were dropped.
    dropped: usize,
    /// The person's terminal's size, sent once attached: the daemon ignores one sent before.
    size: Option<Size>,
    sized: bool,
}

impl Attachment {
    /// The first frame of an attachment of this size.
    #[must_use]
    pub fn hello(size: Size) -> StreamClientFrame {
        StreamClientFrame::Hello {
            protocol_id: Some(PROTOCOL_ID.to_owned()),
            mode: AttachmentMode::Interactive,
            cols: size.cols,
            rows: size.rows,
            resumes: None,
        }
    }

    /// An attachment from a terminal of `size`.
    #[must_use]
    pub fn sized(size: Size) -> Self {
        Self {
            size: Some(size),
            ..Self::default()
        }
    }

    /// The person's terminal resized: the daemon is told once the attachment can tell it.
    pub fn resized(&mut self, size: Size) -> Vec<Effect> {
        self.size = Some(size);
        if !self.declared() {
            return vec![];
        }
        vec![Effect::Send(StreamClientFrame::Resize {
            cols: size.cols,
            rows: size.rows,
        })]
    }

    /// The keys typed: sent as typed, but for two `Ctrl-\` in a row, which detach. A `Ctrl-\`
    /// followed by any other key is sent, with that key, however the reads split them.
    pub fn keys(&mut self, keys: &[u8]) -> Vec<Effect> {
        let (typed, detached) = self.keys.scan(keys);
        let end = detached.then_some(Effect::End(Ending::Detached));
        if self.declared() && self.lease == Standing::Driving {
            let input = (!typed.is_empty()).then_some(Effect::Input(typed));
            return input.into_iter().chain(end).collect();
        }
        // As the daemon reads input from a view that doesn't drive: the terminal's replies and its
        // focus and mouse reports go nowhere, and only keystrokes ask for the lease.
        if !has_keystrokes(&typed) {
            return end.into_iter().collect();
        }
        let room = HELD_MAX.saturating_sub(self.held.len());
        self.dropped += typed.len().saturating_sub(room);
        self.held.extend(typed.into_iter().take(room));
        self.engage().into_iter().chain(end).collect()
    }

    /// Asks for the lease, once, when there are keys to send and another view drives. The daemon
    /// spends a keystroke from a view that doesn't drive on taking the lease and drops it, so the
    /// attachment asks first and sends its keys once the lease is its own.
    fn engage(&mut self) -> Option<Effect> {
        let wanted = self.declared() && self.lease == Standing::Watching && !self.held.is_empty();
        wanted.then(|| {
            self.lease = Standing::Asked;
            Effect::Send(StreamClientFrame::Engage)
        })
    }

    fn declared(&self) -> bool {
        self.attached && self.epoch.is_some()
    }

    /// A text frame from the daemon.
    pub fn frame(&mut self, text: &str) -> Vec<Effect> {
        let Ok(frame) = bazhen_protocol::wire::from_slice::<StreamServerFrame>(text.as_bytes())
        else {
            return vec![Effect::End(Ending::Failed(format!(
                "the daemon sent a frame this build can't read: {}",
                text.chars().take(200).collect::<String>()
            )))];
        };
        match frame {
            StreamServerFrame::Lease { epoch, driver, .. } => {
                self.epoch = Some(epoch);
                self.lease = if driver {
                    Standing::Driving
                } else {
                    Standing::Watching
                };
                self.declare()
            }
            StreamServerFrame::Attached { .. } => {
                self.attached = true;
                self.declare()
            }
            StreamServerFrame::Exit => vec![Effect::End(Ending::Exited)],
            StreamServerFrame::Ended { reason } => vec![Effect::End(match reason {
                EndedReason::EvictedSlow => Ending::Evicted,
                EndedReason::Disconnected => Ending::Lost,
            })],
            StreamServerFrame::Error { message } => vec![Effect::End(Ending::Failed(message))],
            StreamServerFrame::Notice { message } => vec![Effect::Note(message)],
            StreamServerFrame::Pong
            | StreamServerFrame::SnapshotStart { .. }
            | StreamServerFrame::SnapshotEnd
            | StreamServerFrame::InputDropped
            | StreamServerFrame::Screen { .. } => vec![],
        }
    }

    /// The epoch keys are typed under, once the attachment exists to take it, so a key takes the
    /// lease as a click in the web app does; then the terminal's size, and the keys held until
    /// they could be sent.
    fn declare(&mut self) -> Vec<Effect> {
        let (true, Some(epoch)) = (self.attached, self.epoch) else {
            return vec![];
        };
        let mut effects = vec![Effect::Send(StreamClientFrame::Epoch { epoch })];
        if let (false, Some(size)) = (std::mem::replace(&mut self.sized, true), self.size) {
            effects.push(Effect::Send(StreamClientFrame::Resize {
                cols: size.cols,
                rows: size.rows,
            }));
        }
        if self.lease == Standing::Driving {
            let held = std::mem::take(&mut self.held);
            if !held.is_empty() {
                effects.push(Effect::Input(held));
            }
        } else {
            effects.extend(self.engage());
        }
        let dropped = std::mem::take(&mut self.dropped);
        if dropped > 0 {
            effects.push(Effect::Note(format!(
                "{dropped} bytes typed before this attachment could send them were dropped: more \
                 than a paste"
            )));
        }
        effects
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    const ATTACHED: &str =
        r#"{"type":"attached","attachmentId":"att_0190c3b2a1d47a3b8c1d2e3f4a5b6c7d"}"#;

    /// An attachment the daemon has attached, driving under epoch 1.
    fn declared() -> Attachment {
        let mut a = Attachment::default();
        a.frame(r#"{"type":"lease","driver":true,"epoch":1}"#);
        a.frame(ATTACHED);
        a
    }

    fn typed(effects: &[Effect]) -> Vec<u8> {
        effects
            .iter()
            .flat_map(|e| match e {
                Effect::Input(keys) => keys.clone(),
                _ => vec![],
            })
            .collect()
    }

    fn detached(effects: &[Effect]) -> bool {
        effects.contains(&Effect::End(Ending::Detached))
    }

    #[test]
    fn detaches_on_two_ctrl_backslashes_however_the_reads_split_them() {
        let mut whole = declared();
        let mut split = declared();
        let once = whole.keys(b"ls\x1c\x1c");
        let first = split.keys(b"ls\x1c");
        let second = split.keys(b"\x1c");
        assert_eq!(
            once,
            [Effect::Input(b"ls".to_vec()), Effect::End(Ending::Detached)]
        );
        assert_eq!(first, [Effect::Input(b"ls".to_vec())]);
        assert_eq!(second, [Effect::End(Ending::Detached)]);
    }

    #[test]
    fn sends_a_lone_ctrl_backslash_with_the_key_after_it() {
        let mut s = declared();
        let held = s.keys(b"\x1c");
        let then = s.keys(b"q");
        assert_eq!(held, []);
        assert_eq!(then, [Effect::Input(b"\x1cq".to_vec())]);
    }

    #[test]
    fn declares_the_latest_epoch_once_attached_and_every_lease_after() {
        let mut s = Attachment::default();
        let early = s.frame(r#"{"type":"lease","driver":false,"epoch":3}"#);
        let attached =
            s.frame(r#"{"type":"attached","attachmentId":"att_0190c3b2a1d47a3b8c1d2e3f4a5b6c7d"}"#);
        let later = s.frame(r#"{"type":"lease","driver":true,"epoch":4}"#);
        assert_eq!(early, []);
        assert_eq!(
            attached,
            [Effect::Send(StreamClientFrame::Epoch { epoch: 3 })]
        );
        assert_eq!(later, [Effect::Send(StreamClientFrame::Epoch { epoch: 4 })]);
    }

    #[test]
    fn holds_keys_typed_before_the_epoch_is_declared_and_sends_them_after_it() {
        let mut s = Attachment::default();
        let early = s.keys(b"ls");
        s.frame(r#"{"type":"lease","driver":true,"epoch":5}"#);
        let more = s.keys(b" -l");
        let attached = s.frame(ATTACHED);
        let after = s.keys(b"\r");
        assert_eq!([early, more], [vec![], vec![]]);
        assert_eq!(
            attached,
            [
                Effect::Send(StreamClientFrame::Epoch { epoch: 5 }),
                Effect::Input(b"ls -l".to_vec())
            ]
        );
        assert_eq!(after, [Effect::Input(b"\r".to_vec())]);
    }

    #[test]
    fn asks_for_the_lease_before_its_keys_and_sends_them_once_it_drives() {
        let mut s = Attachment::default();
        s.frame(r#"{"type":"lease","driver":false,"epoch":3}"#);
        let attached = s.frame(ATTACHED);
        let first = s.keys(b"exit");
        let more = s.keys(b"\r");
        let taken = s.frame(r#"{"type":"lease","driver":true,"epoch":4}"#);
        let after = s.keys(b"x");
        let lost = s.frame(r#"{"type":"lease","driver":false,"epoch":5}"#);
        let again = s.keys(b"y");
        assert_eq!(
            attached,
            [Effect::Send(StreamClientFrame::Epoch { epoch: 3 })]
        );
        assert_eq!(first, [Effect::Send(StreamClientFrame::Engage)]);
        assert_eq!(more, []);
        assert_eq!(
            taken,
            [
                Effect::Send(StreamClientFrame::Epoch { epoch: 4 }),
                Effect::Input(b"exit\r".to_vec())
            ]
        );
        assert_eq!(after, [Effect::Input(b"x".to_vec())]);
        assert_eq!(lost, [Effect::Send(StreamClientFrame::Epoch { epoch: 5 })]);
        assert_eq!(again, [Effect::Send(StreamClientFrame::Engage)]);
    }

    #[test]
    fn neither_asks_for_the_lease_nor_holds_reports_and_replies_while_another_view_drives() {
        let mut s = Attachment::default();
        s.frame(r#"{"type":"lease","driver":false,"epoch":3}"#);
        s.frame(ATTACHED);
        let focus = s.keys(b"\x1b[I\x1b[O");
        let mouse = s.keys(b"\x1b[<35;10;5M");
        let device = s.keys(b"\x1b[?62;22c");
        let key = s.keys(b"q");
        let taken = s.frame(r#"{"type":"lease","driver":true,"epoch":4}"#);
        assert_eq!([focus, mouse, device], [vec![], vec![], vec![]]);
        assert_eq!(key, [Effect::Send(StreamClientFrame::Engage)]);
        assert_eq!(
            taken,
            [
                Effect::Send(StreamClientFrame::Epoch { epoch: 4 }),
                Effect::Input(b"q".to_vec())
            ]
        );
    }

    #[test]
    fn asks_again_when_the_lease_goes_to_another_view_while_it_asks() {
        let mut s = Attachment::default();
        s.frame(r#"{"type":"lease","driver":false,"epoch":3}"#);
        s.frame(ATTACHED);
        let asked = s.keys(b"q");
        let other = s.frame(r#"{"type":"lease","driver":false,"epoch":4}"#);
        assert_eq!(asked, [Effect::Send(StreamClientFrame::Engage)]);
        assert_eq!(
            other,
            [
                Effect::Send(StreamClientFrame::Epoch { epoch: 4 }),
                Effect::Send(StreamClientFrame::Engage)
            ]
        );
    }

    #[test]
    fn asks_for_the_lease_once_attached_for_keys_typed_while_another_view_drives() {
        let mut s = Attachment::default();
        s.keys(b"ls\r");
        s.frame(r#"{"type":"lease","driver":false,"epoch":2}"#);
        let attached = s.frame(ATTACHED);
        assert_eq!(
            attached,
            [
                Effect::Send(StreamClientFrame::Epoch { epoch: 2 }),
                Effect::Send(StreamClientFrame::Engage)
            ]
        );
    }

    #[test]
    fn holds_no_more_than_a_paste_and_still_detaches_while_holding() {
        let mut s = Attachment::default();
        s.keys(&vec![b'x'; HELD_MAX + 10]);
        let detach = s.keys(&[DETACH, DETACH]);
        s.frame(r#"{"type":"lease","driver":true,"epoch":1}"#);
        let attached = s.frame(ATTACHED);
        assert_eq!(detach, [Effect::End(Ending::Detached)]);
        assert_eq!(typed(&attached).len(), HELD_MAX);
        assert!(
            attached
                .iter()
                .any(|e| matches!(e, Effect::Note(n) if n.starts_with("10 bytes"))),
            "{attached:?}"
        );
    }

    #[test]
    fn sends_the_size_once_attached_and_each_resize_after() {
        let size = |cols, rows| Size { cols, rows };
        let resize = |cols, rows| Effect::Send(StreamClientFrame::Resize { cols, rows });
        let mut s = Attachment::sized(size(80, 24));
        let early = s.resized(size(100, 30));
        s.frame(r#"{"type":"lease","driver":false,"epoch":1}"#);
        let attached = s.frame(ATTACHED);
        let lease = s.frame(r#"{"type":"lease","driver":true,"epoch":2}"#);
        let later = s.resized(size(120, 40));
        assert_eq!(early, []);
        assert_eq!(
            attached,
            [
                Effect::Send(StreamClientFrame::Epoch { epoch: 1 }),
                resize(100, 30)
            ]
        );
        assert_eq!(lease, [Effect::Send(StreamClientFrame::Epoch { epoch: 2 })]);
        assert_eq!(later, [resize(120, 40)]);
    }

    #[test]
    fn ends_as_the_daemon_says_and_passes_on_its_notices() {
        let mut s = Attachment::default();
        let read = |s: &mut Attachment, text: &str| s.frame(text);
        assert_eq!(
            [
                read(&mut s, r#"{"type":"exit"}"#),
                read(&mut s, r#"{"type":"ended","reason":"evicted_slow"}"#),
                read(&mut s, r#"{"type":"ended","reason":"disconnected"}"#),
                read(&mut s, r#"{"type":"error","message":"no such terminal"}"#),
                read(&mut s, r#"{"type":"notice","message":"resize refused"}"#),
            ],
            [
                vec![Effect::End(Ending::Exited)],
                vec![Effect::End(Ending::Evicted)],
                vec![Effect::End(Ending::Lost)],
                vec![Effect::End(Ending::Failed("no such terminal".to_owned()))],
                vec![Effect::Note("resize refused".to_owned())],
            ]
        );
    }

    #[test]
    fn fails_on_a_frame_it_cannot_read() {
        let mut s = Attachment::default();
        let effects = s.frame(r#"{"type":"teleport"}"#);
        assert!(
            matches!(effects.as_slice(), [Effect::End(Ending::Failed(m))] if m.contains("teleport")),
            "{effects:?}"
        );
    }

    #[test]
    fn brings_a_size_within_what_a_view_may_say() {
        assert_eq!(
            [
                Size::clamped(0, 1),
                Size::clamped(80, 24),
                Size::clamped(4000, 1001)
            ],
            [
                Size { cols: 2, rows: 2 },
                Size { cols: 80, rows: 24 },
                Size {
                    cols: 1000,
                    rows: 1000
                }
            ]
        );
    }

    fn sent(keys: &[&[u8]]) -> Vec<Effect> {
        let mut s = declared();
        let mut out = Vec::new();
        for read in keys {
            if detached(&out) {
                break;
            }
            out.extend(s.keys(read));
        }
        out
    }

    proptest! {
        /// However the reads split the keys, the same keys are sent and the same detach happens.
        #[test]
        fn sends_the_same_however_the_reads_split(
            keys in proptest::collection::vec(prop_oneof![Just(DETACH), any::<u8>()], 0..64),
            cut in 0usize..64,
        ) {
            let (a, b) = keys.split_at(cut.min(keys.len()));
            let whole = sent(&[&keys]);
            let split = sent(&[a, b]);
            prop_assert_eq!(typed(&split), typed(&whole));
            prop_assert_eq!(detached(&split), detached(&whole));
        }

        /// Keys with no two `Ctrl-\` in a row, ending in anything else, are sent as typed.
        #[test]
        fn sends_keys_without_a_pair_as_typed(
            runs in proptest::collection::vec(
                (any::<bool>(), any::<u8>().prop_filter("not Ctrl-\\", |k| *k != DETACH)),
                0..32,
            ),
        ) {
            let keys: Vec<u8> = runs
                .iter()
                .flat_map(|&(lead, key)| lead.then_some(DETACH).into_iter().chain([key]))
                .collect();
            let out = sent(&[&keys]);
            prop_assert!(!detached(&out));
            prop_assert_eq!(typed(&out), keys);
        }
    }
}
