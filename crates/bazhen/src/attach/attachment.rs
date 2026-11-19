//! What `bazhen terminals attach` makes of each thing that happens while it is attached: a key the person
//! typed, a frame the daemon sent, the terminal resized. No I/O: each step returns what to do.

use bazhen_protocol::agents::ExitStatus;
use bazhen_protocol::detach_keys::DetachKeys;
use bazhen_protocol::id::PROTOCOL_ID;
use bazhen_protocol::input::has_keystrokes;
use bazhen_protocol::stream::{AttachmentMode, EndedReason, StreamClientFrame, StreamServerFrame};

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
    /// The terminal's program exited, after the last of its output. The terminal goes on.
    ProgramExited(ExitStatus),
    /// The terminal closed.
    Closed,
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

/// The keys the person types, but for the sequence that detaches. Keys that start the sequence
/// are held until the next one says whether it goes on, however the reads split them.
#[derive(Debug)]
pub struct DetachScan {
    sequence: DetachKeys,
    /// How many of the sequence's keys the latest keys typed are, held back.
    matched: usize,
}

impl DetachScan {
    #[must_use]
    pub fn new(sequence: DetachKeys) -> Self {
        Self {
            sequence,
            matched: 0,
        }
    }

    /// The keys to send of `keys`, and whether they detach, after which the rest are dropped.
    pub fn scan(&mut self, keys: &[u8]) -> (Vec<u8>, bool) {
        let mut typed = Vec::with_capacity(keys.len() + self.matched);
        for &key in keys {
            if self.push(key, &mut typed) {
                return (typed, true);
            }
        }
        (typed, false)
    }

    /// Takes one key, adding to `typed` what it no longer holds back; true once the sequence is
    /// complete. A key that breaks a partial match lets go of only the first key held: the rest,
    /// and this one, may still start the sequence, as `a a` does of `a a b`.
    fn push(&mut self, key: u8, typed: &mut Vec<u8>) -> bool {
        let sequence = self.sequence.bytes();
        if sequence.get(self.matched) == Some(&key) {
            self.matched += 1;
            if self.matched < sequence.len() {
                return false;
            }
            // The sequence is complete: nothing is held, and keys scanned after start afresh.
            self.matched = 0;
            return true;
        }
        let Some((&first, rest)) = sequence.get(..self.matched).and_then(<[u8]>::split_first)
        else {
            typed.push(key);
            return false;
        };
        let again: Vec<u8> = rest.iter().copied().chain([key]).collect();
        typed.push(first);
        self.matched = 0;
        again.into_iter().any(|key| self.push(key, typed))
    }
}

/// One attachment's state between steps.
#[derive(Debug)]
pub struct Attachment {
    keys: DetachScan,
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

    /// An attachment that detaches on `keys`.
    #[must_use]
    pub fn new(keys: DetachKeys) -> Self {
        Self {
            keys: DetachScan::new(keys),
            attached: false,
            epoch: None,
            lease: Standing::default(),
            held: Vec::new(),
            dropped: 0,
            size: None,
            sized: false,
        }
    }

    /// An attachment from a terminal of `size`, that detaches on `keys`.
    #[must_use]
    pub fn sized(size: Size, keys: DetachKeys) -> Self {
        Self {
            size: Some(size),
            ..Self::new(keys)
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

    /// The keys typed: sent as typed, but for the sequence that detaches. A key that starts it
    /// and is followed by any other is sent, with that key, however the reads split them.
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
            StreamServerFrame::Exited { exit, .. } => {
                vec![Effect::End(Ending::ProgramExited(exit))]
            }
            StreamServerFrame::Closed => vec![Effect::End(Ending::Closed)],
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

    fn attachment() -> Attachment {
        Attachment::new(DetachKeys::default())
    }

    /// The default sequence's keys.
    fn detach() -> Vec<u8> {
        DetachKeys::default().bytes().to_vec()
    }

    /// An attachment the daemon has attached, driving under epoch 1, that detaches on `keys`.
    fn declared_with(keys: DetachKeys) -> Attachment {
        let mut a = Attachment::new(keys);
        a.frame(r#"{"type":"lease","driver":true,"epoch":1}"#);
        a.frame(ATTACHED);
        a
    }

    fn declared() -> Attachment {
        declared_with(DetachKeys::default())
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
    fn detaches_on_the_sequence_however_the_reads_split_it() {
        let detach = detach();
        let (first, last) = detach.split_at(1);
        let mut whole = declared();
        let mut split = declared();
        let once = whole.keys(&[b"ls", &detach[..]].concat());
        let before = split.keys(&[b"ls", first].concat());
        let after = split.keys(last);
        assert_eq!(
            once,
            [Effect::Input(b"ls".to_vec()), Effect::End(Ending::Detached)]
        );
        assert_eq!(before, [Effect::Input(b"ls".to_vec())]);
        assert_eq!(after, [Effect::End(Ending::Detached)]);
    }

    #[test]
    fn sends_a_lone_first_key_of_the_sequence_with_the_key_after_it() {
        let mut s = declared();
        let first = detach()[0];
        let held = s.keys(&[first]);
        let then = s.keys(b"q");
        assert_eq!(held, []);
        assert_eq!(then, [Effect::Input(vec![first, b'q'])]);
    }

    #[test]
    fn detaches_on_a_sequence_that_starts_again_inside_a_broken_match() {
        let keys = |text| DetachKeys::parse(text).unwrap();
        assert_eq!(
            [
                DetachScan::new(keys("a,a,b")).scan(b"xaaab"),
                DetachScan::new(keys("a,a,b")).scan(b"xaac"),
            ],
            [(b"xa".to_vec(), true), (b"xaac".to_vec(), false)]
        );
    }

    #[test]
    fn scans_afresh_after_a_detach_never_sending_the_sequence() {
        let keys = |text| DetachKeys::parse(text).unwrap();
        let mut one = DetachScan::new(keys("q"));
        let mut two = DetachScan::new(keys("ctrl-],ctrl-]"));
        assert_eq!(
            [
                one.scan(b"q"),
                one.scan(b"xy"),
                one.scan(b"q"),
                two.scan(b"\x1d\x1d"),
                two.scan(b"x\x1d"),
            ],
            [
                (vec![], true),
                (b"xy".to_vec(), false),
                (vec![], true),
                (vec![], true),
                (b"x".to_vec(), false),
            ]
        );
    }

    #[test]
    fn declares_the_latest_epoch_once_attached_and_every_lease_after() {
        let mut s = attachment();
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
        let mut s = attachment();
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
        let mut s = attachment();
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
        let mut s = attachment();
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
        let mut s = attachment();
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
        let mut s = attachment();
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
        let mut s = attachment();
        s.keys(&vec![b'x'; HELD_MAX + 10]);
        let detach = s.keys(&detach());
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
        let mut s = Attachment::sized(size(80, 24), DetachKeys::default());
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
        let mut s = attachment();
        let read = |s: &mut Attachment, text: &str| s.frame(text);
        assert_eq!(
            [
                read(
                    &mut s,
                    r#"{"type":"exited","generation":1,"exit":{"type":"exited","code":3}}"#
                ),
                read(&mut s, r#"{"type":"closed"}"#),
                read(&mut s, r#"{"type":"ended","reason":"evicted_slow"}"#),
                read(&mut s, r#"{"type":"ended","reason":"disconnected"}"#),
                read(&mut s, r#"{"type":"error","message":"no such terminal"}"#),
                read(&mut s, r#"{"type":"notice","message":"resize refused"}"#),
            ],
            [
                vec![Effect::End(Ending::ProgramExited(ExitStatus::Exited {
                    code: 3
                }))],
                vec![Effect::End(Ending::Closed)],
                vec![Effect::End(Ending::Evicted)],
                vec![Effect::End(Ending::Lost)],
                vec![Effect::End(Ending::Failed("no such terminal".to_owned()))],
                vec![Effect::Note("resize refused".to_owned())],
            ]
        );
    }

    #[test]
    fn fails_on_a_frame_it_cannot_read() {
        let mut s = attachment();
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

    fn sent(sequence: &DetachKeys, keys: &[&[u8]]) -> Vec<Effect> {
        let mut s = declared_with(sequence.clone());
        let mut out = Vec::new();
        for read in keys {
            if detached(&out) {
                break;
            }
            out.extend(s.keys(read));
        }
        out
    }

    /// Sequences of up to four keys from an alphabet small enough that typed keys often start
    /// one, break one off, or hold one inside another.
    fn sequences() -> impl Strategy<Value = DetachKeys> {
        proptest::collection::vec(proptest::sample::select(vec!["a", "b", "ctrl-]"]), 1..=4)
            .prop_map(|names| DetachKeys::parse(&names.join(",")).unwrap())
    }

    /// Keys from the sequences' alphabet, and `c`, which is in none.
    fn typed_keys() -> impl Strategy<Value = Vec<u8>> {
        proptest::collection::vec(proptest::sample::select(b"ab\x1dc".to_vec()), 0..64)
    }

    proptest! {
        /// However the reads split the keys, the same keys are sent and the same detach happens.
        #[test]
        fn sends_the_same_however_the_reads_split(
            sequence in sequences(),
            keys in typed_keys(),
            cut in 0usize..64,
        ) {
            let (a, b) = keys.split_at(cut.min(keys.len()));
            let whole = sent(&sequence, &[&keys]);
            let split = sent(&sequence, &[a, b]);
            prop_assert_eq!(typed(&split), typed(&whole));
            prop_assert_eq!(detached(&split), detached(&whole));
        }

        /// Everything typed before the sequence's first whole appearance is sent, and it detaches
        /// there; keys that never hold it are all sent, once a key outside it ends them.
        #[test]
        fn sends_what_comes_before_the_sequence_and_detaches_on_it(
            sequence in sequences(),
            mut keys in typed_keys(),
        ) {
            keys.push(b'c');
            let out = sent(&sequence, &[&keys]);
            let bytes = sequence.bytes();
            let before = keys.windows(bytes.len()).position(|w| w == bytes).map_or(&keys[..], |at| &keys[..at]);
            prop_assert_eq!(typed(&out), before.to_vec());
            prop_assert_eq!(detached(&out), before.len() < keys.len());
        }
    }
}
