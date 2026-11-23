//! The seam between a snapshot and the live output held for a view while it was taken, as
//! `apps/daemon/src/stream/seam.ts` cuts it: what the view still needs after the snapshot, with
//! nothing missed or repeated.

use bazhen_holder_proto::body::{Exited, Size};

/// What a respawn does to a view's terminal before the next process starts: back to its main
/// screen, every mode and colour as a fresh terminal has it, and the screen cleared, its history
/// kept. `RESPAWN_RESET` in `packages/core/src/runtime.ts`.
pub(crate) const RESPAWN_RESET: &[u8] =
    b"\x1b[?1049l\x1b[!p\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\
\x1b[?1004l\x1b[?2004l\x1b]104\x07\x1b]110\x07\x1b]111\x07\x1b]112\x07\x1b[H\x1b[2J";

/// Where a stream is: the next byte the process of `generation` prints is at `offset`. Ordered
/// by generation, then offset.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub(crate) struct Position {
    pub(crate) generation: u64,
    pub(crate) offset: u64,
}

impl Position {
    /// Where the process of `generation` starts.
    #[must_use]
    pub(crate) const fn start(generation: u64) -> Self {
        Self {
            generation,
            offset: 0,
        }
    }

    /// Where the stream is once `len` more bytes of this generation have come.
    #[must_use]
    pub(crate) fn after(self, len: usize) -> Self {
        let len = u64::try_from(len).unwrap_or(u64::MAX);
        Self {
            offset: self.offset.saturating_add(len),
            ..self
        }
    }
}

/// Output held for a view while its snapshot is on its way. A respawn's reset is held at the new
/// generation's offset 0, before that process's first byte, and takes up no offsets itself. An
/// exit is held in order with the output around it, and takes up none either.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Held {
    Geometry(Size),
    Data { at: Position, bytes: Vec<u8> },
    Reset { generation: u64 },
    Exited(Exited),
}

/// The bytes a held item adds to what the view lags by.
#[must_use]
pub(crate) fn held_bytes(item: &Held) -> usize {
    match item {
        Held::Data { bytes, .. } => bytes.len(),
        Held::Reset { .. } => RESPAWN_RESET.len(),
        Held::Geometry(_) | Held::Exited(_) => 0,
    }
}

/// Whether output held from `from` up to `now` can carry on from a snapshot taken at `taken`.
#[must_use]
pub(crate) fn seamable(from: Position, now: Position, taken: Position) -> bool {
    from <= taken && taken <= now
}

/// What of `held`, which the stream delivered from `from` up to `now`, follows a snapshot taken
/// at `taken`: the output a view that replays the snapshot still needs, none missed or repeated,
/// with a chunk the snapshot covers part of cut where it ends. `None` when no such output exists:
/// a snapshot older than `from` lacks the output between them, and one newer than `now` covers
/// output that hasn't arrived. The first `queued_before` items were held before the snapshot was
/// asked for, so a geometry among them is one the snapshot was taken at or after.
#[must_use]
pub(crate) fn seam(
    held: Vec<Held>,
    from: Position,
    now: Position,
    taken: Position,
    queued_before: usize,
) -> Option<Vec<Held>> {
    if !seamable(from, now, taken) {
        return None;
    }
    let rest = held
        .into_iter()
        .enumerate()
        .filter_map(|(index, item)| match item {
            Held::Geometry(_) => (index >= queued_before).then_some(item),
            Held::Reset { generation } => (generation > taken.generation).then_some(item),
            // A snapshot shows no exit, so one of its own process still follows it; a respawn's
            // is newer.
            Held::Exited(ref exit) => (exit.generation.get() >= taken.generation).then_some(item),
            Held::Data { at, bytes } => {
                if at.generation != taken.generation {
                    return (at.generation > taken.generation).then_some(Held::Data { at, bytes });
                }
                let Some(skip) = taken.offset.checked_sub(at.offset) else {
                    return Some(Held::Data { at, bytes });
                };
                let skip = usize::try_from(skip).unwrap_or(usize::MAX);
                match bytes.get(skip..) {
                    _ if skip == 0 => Some(Held::Data { at, bytes }),
                    Some(rest) if !rest.is_empty() => Some(Held::Data {
                        at: taken,
                        bytes: rest.to_vec(),
                    }),
                    _ => None,
                }
            }
        })
        .collect();
    Some(rest)
}

#[cfg(test)]
mod tests {
    use bazhen_holder_proto::body::{ExitCode, ExitStatus, Generation};
    use proptest::prelude::*;

    use super::*;

    fn at(generation: u64, offset: u64) -> Position {
        Position { generation, offset }
    }

    fn size(cols: u64, rows: u64) -> Size {
        Size {
            cols: bazhen_holder_proto::body::Cols::new(cols).unwrap(),
            rows: bazhen_holder_proto::body::Rows::new(rows).unwrap(),
        }
    }

    fn data(at: Position, bytes: &[u8]) -> Held {
        Held::Data {
            at,
            bytes: bytes.to_vec(),
        }
    }

    fn reset(generation: u64) -> Held {
        Held::Reset { generation }
    }

    /// What a reset stands for in a run of output: no byte, so never mistaken for one.
    const RESET: u16 = 256;

    /// A held item as the units of output it carries.
    fn units_of(item: &Held) -> Vec<u16> {
        match item {
            Held::Data { bytes, .. } => bytes.iter().map(|&b| u16::from(b)).collect(),
            Held::Reset { .. } => vec![RESET],
            Held::Geometry(_) | Held::Exited(_) => vec![],
        }
    }

    /// One unit of output, or a respawn's reset, as the stream delivered it, in order.
    struct Unit {
        value: u16,
        /// Where a snapshot taken just before this unit is.
        before: Position,
        /// For a reset, the generation it starts.
        starts: Option<u64>,
    }

    /// Everything delivered from `start`, unit by unit, and where the stream is after each event.
    /// `None` is a respawn.
    fn deliver(
        start: Position,
        events: &[Option<Vec<u8>>],
    ) -> (Vec<Unit>, Vec<Position>, Vec<Held>) {
        let mut now = start;
        let mut units = vec![];
        let mut positions = vec![now];
        let mut items = vec![];
        for event in events {
            match event {
                None => {
                    let next = now.generation + 1;
                    units.push(Unit {
                        value: RESET,
                        before: now,
                        starts: Some(next),
                    });
                    now = at(next, 0);
                    items.push(reset(next));
                }
                Some(bytes) => {
                    for (i, &b) in bytes.iter().enumerate() {
                        units.push(Unit {
                            value: u16::from(b),
                            before: now.after(i),
                            starts: None,
                        });
                    }
                    items.push(data(now, bytes));
                    now = now.after(bytes.len());
                }
            }
            positions.push(now);
        }
        (units, positions, items)
    }

    /// What a snapshot taken at `taken` already shows: a reset from its own generation on.
    fn precedes(unit: &Unit, taken: Position) -> bool {
        unit.starts
            .map_or(unit.before < taken, |starts| taken.generation >= starts)
    }

    fn events() -> impl Strategy<Value = Vec<Option<Vec<u8>>>> {
        prop::collection::vec(
            prop_oneof![
                4 => prop::collection::vec(any::<u8>(), 1..=6).prop_map(Some),
                1 => Just(None),
            ],
            0..=12,
        )
    }

    proptest! {
        #[test]
        fn gives_a_view_that_replays_the_snapshot_exactly_the_rest_of_the_stream(
            raw in events(),
            generation in 0u64..=3,
            offset in 0u64..=100,
            pick_from in any::<usize>(),
            pick_taken in any::<usize>(),
        ) {
            let start = at(generation, offset);
            let (units, positions, _) = deliver(start, &raw);
            let now = positions.last().copied().unwrap_or(start);
            let from_index = pick_from % positions.len();
            let from = positions[from_index];
            let later: Vec<Position> = units
                .iter()
                .map(|u| u.before)
                .chain([now])
                .filter(|p| *p >= from)
                .collect();
            let taken = later[pick_taken % later.len()];
            let (_, _, held) = deliver(from, &raw[from_index..]);
            let rest = seam(held, from, now, taken, 0).unwrap_or_default();
            let mut replayed: Vec<u16> = units
                .iter()
                .filter(|u| precedes(u, taken))
                .map(|u| u.value)
                .collect();
            replayed.extend(rest.iter().flat_map(units_of));
            let delivered: Vec<u16> = units.iter().map(|u| u.value).collect();
            prop_assert_eq!(replayed, delivered);
        }
    }

    #[test]
    fn keeps_only_geometry_after_capture_starts_even_when_the_byte_offset_is_unchanged() {
        let here = at(0, 4);
        let before = Held::Geometry(size(80, 24));
        let after = Held::Geometry(size(60, 40));
        assert_eq!(
            seam(vec![before, after.clone()], here, here, here, 1),
            Some(vec![after])
        );
    }

    #[test]
    fn refuses_a_snapshot_older_than_the_held_output_or_newer_than_the_stream() {
        let from = at(1, 10);
        let now = at(1, 20);
        let held = || vec![data(from, &[0; 10])];
        assert_eq!(
            [
                seam(held(), from, now, at(1, 9), 0).map(|r| r.len()),
                seam(held(), from, now, at(0, 50), 0).map(|r| r.len()),
                seam(held(), from, now, at(1, 21), 0).map(|r| r.len()),
                seam(held(), from, now, at(2, 0), 0).map(|r| r.len()),
                seam(held(), from, now, from, 0).map(|r| r.len()),
                seam(held(), from, now, now, 0).map(|r| r.len()),
            ],
            [None, None, None, None, Some(1), Some(0)]
        );
    }

    #[test]
    fn keeps_a_respawn_s_reset_for_a_snapshot_taken_before_it_and_drops_it_after() {
        let from = at(0, 4);
        let held = || vec![reset(1), data(at(1, 0), &[1, 2])];
        let now = at(1, 2);
        let units = |taken| -> Vec<Vec<u16>> {
            seam(held(), from, now, taken, 0)
                .unwrap()
                .iter()
                .map(units_of)
                .collect()
        };
        assert_eq!(
            [units(from), units(at(1, 0)), units(at(1, 1))],
            [
                vec![vec![RESET], vec![1, 2]],
                vec![vec![1, 2]],
                vec![vec![2]]
            ]
        );
    }

    #[test]
    fn keeps_an_exit_for_a_snapshot_of_its_own_process_wherever_in_it_and_drops_it_for_a_later_one()
    {
        let from = at(0, 4);
        let exit = Held::Exited(Exited {
            generation: Generation::new(0).unwrap(),
            status: ExitStatus::Exited {
                code: ExitCode::new(0).unwrap(),
            },
        });
        let held = || {
            vec![
                data(from, &[1, 2]),
                exit.clone(),
                data(at(0, 6), &[3]),
                reset(1),
            ]
        };
        let now = at(1, 0);
        let kinds = |taken| -> Vec<&'static str> {
            seam(held(), from, now, taken, 0)
                .unwrap()
                .iter()
                .map(|item| match item {
                    Held::Data { .. } => "data",
                    Held::Exited(_) => "exited",
                    Held::Reset { .. } => "reset",
                    Held::Geometry(_) => "geometry",
                })
                .collect()
        };
        assert_eq!(
            [kinds(from), kinds(at(0, 7)), kinds(at(1, 0))],
            [
                vec!["data", "exited", "data", "reset"],
                vec!["exited", "reset"],
                vec![]
            ]
        );
    }
}
