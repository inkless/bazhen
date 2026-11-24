//! The screen a view opens on: a snapshot of its terminal, and the one its stream was opened
//! with, kept for the first view that can use it, as `runtimeScreen` in
//! `apps/daemon/src/stream/screen-source.ts` keeps it.

use bazhen_holder_proto::body::Size;

use super::seam::Position;

/// A terminal's screen and history as VT, which a view that replays it into a fresh terminal of
/// the same size sees as the terminal shows them, and where the stream was as it was taken.
pub(crate) struct Snapshot {
    vt: Vec<u8>,
    at: Position,
}

impl Snapshot {
    #[must_use]
    pub(crate) const fn new(vt: Vec<u8>, at: Position) -> Self {
        Self { vt, at }
    }

    #[must_use]
    pub(crate) const fn at(&self) -> Position {
        self.at
    }

    pub(crate) fn vt(&self) -> &[u8] {
        &self.vt
    }
}

impl std::fmt::Debug for Snapshot {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Snapshot")
            .field("bytes", &self.vt.len())
            .field("at", &self.at)
            .finish()
    }
}

/// The snapshot a stream was opened with, and the size it was drawn at.
#[derive(Debug)]
pub(crate) struct Opening {
    snapshot: Snapshot,
    geometry: Size,
}

impl Opening {
    pub(crate) const fn new(snapshot: Snapshot, geometry: Size) -> Self {
        Self { snapshot, geometry }
    }

    /// The snapshot, if it still shows the terminal as it is at `now` and `size`. Output since it
    /// was taken would be missing from it, and one drawn at another size would be replayed into
    /// a view of this one: the stream may have learnt of a resize before the hub hears of it.
    pub(crate) fn usable(self, now: Position, size: Size) -> Option<Snapshot> {
        (self.snapshot.at == now && self.geometry == size).then_some(self.snapshot)
    }
}

#[cfg(test)]
mod tests {
    use bazhen_holder_proto::body::{Cols, Rows};

    use super::*;

    fn size(cols: u64, rows: u64) -> Size {
        Size {
            cols: Cols::new(cols).unwrap(),
            rows: Rows::new(rows).unwrap(),
        }
    }

    fn opened_at(generation: u64, offset: u64) -> Opening {
        Opening::new(
            Snapshot::new(b"drawn".to_vec(), Position { generation, offset }),
            size(80, 24),
        )
    }

    #[test]
    fn is_used_only_where_the_stream_still_is_and_at_the_size_it_was_drawn_at() {
        let now = Position {
            generation: 1,
            offset: 7,
        };
        let usable = |opening: Opening, size| opening.usable(now, size).map(|s| s.vt().to_vec());
        assert_eq!(
            [
                usable(opened_at(1, 7), size(80, 24)),
                usable(opened_at(1, 6), size(80, 24)),
                usable(opened_at(0, 7), size(80, 24)),
                usable(opened_at(1, 7), size(80, 25)),
                usable(opened_at(1, 7), size(81, 24)),
            ],
            [Some(b"drawn".to_vec()), None, None, None, None]
        );
    }
}
