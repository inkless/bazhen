//! The last stretch of the child's output, under absolute offsets: what a subscriber that fell
//! behind, or reconnected, catches up from. It never blocks and never grows; what it no longer
//! holds a subscriber learns of as a `gap`, and resnapshots.

use crate::holder::Output;

/// What a holder keeps: reconnect catch-up only, since a gap resnapshots.
pub const RING_BYTES: usize = 1 << 20;

/// Every byte written, at offset `end − n` for the byte written `n` bytes ago, keeping the last
/// `capacity` of them: `[start, end)`.
#[derive(Debug)]
pub struct Ring {
    bytes: Box<[u8]>,
    end: u64,
}

impl Ring {
    /// # Panics
    ///
    /// Never: a zero capacity is taken as one.
    pub fn new(capacity: usize) -> Self {
        Self {
            bytes: vec![0; capacity.max(1)].into_boxed_slice(),
            end: 0,
        }
    }

    /// The offset of the next byte written.
    pub const fn end(&self) -> u64 {
        self.end
    }

    /// The offset of the oldest byte still held.
    pub fn start(&self) -> u64 {
        self.end.saturating_sub(self.capacity())
    }

    /// How many bytes it holds.
    pub fn held(&self) -> u64 {
        self.end - self.start()
    }

    fn capacity(&self) -> u64 {
        u64::try_from(self.bytes.len()).unwrap_or(u64::MAX)
    }

    fn slot(&self, offset: u64) -> usize {
        usize::try_from(offset % self.capacity()).unwrap_or_default()
    }

    /// Up to `max` bytes from `from` on, as one contiguous slice: shorter than asked where the
    /// buffer wraps, empty at `end`. `None` when `from` is before `start` or after `end`.
    pub fn read(&self, from: u64, max: usize) -> Option<&[u8]> {
        if from < self.start() || from > self.end {
            return None;
        }
        let at = self.slot(from);
        let wanted = usize::try_from(self.end - from)
            .unwrap_or(usize::MAX)
            .min(max);
        let len = wanted.min(self.bytes.len() - at);
        self.bytes.get(at..at + len)
    }

    /// Appends `bytes`, dropping the oldest held past the capacity.
    pub fn push(&mut self, bytes: &[u8]) {
        let capacity = self.bytes.len();
        let kept = bytes
            .get(bytes.len().saturating_sub(capacity)..)
            .unwrap_or_default();
        let skipped = u64::try_from(bytes.len() - kept.len()).unwrap_or(u64::MAX);
        self.end = self.end.saturating_add(skipped);
        let mut rest = kept;
        while !rest.is_empty() {
            let at = self.slot(self.end);
            let (now, later) = rest.split_at(rest.len().min(capacity - at));
            if let Some(slot) = self.bytes.get_mut(at..at + now.len()) {
                slot.copy_from_slice(now);
            }
            self.end = self
                .end
                .saturating_add(u64::try_from(now.len()).unwrap_or(u64::MAX));
            rest = later;
        }
    }
}

impl Output for Ring {
    fn write(&mut self, bytes: &[u8]) {
        self.push(bytes);
    }
}

#[cfg(test)]
mod tests {
    use proptest::prelude::*;

    use super::*;

    /// Everything a subscriber at `from` would read, a slice at a time.
    fn read_all(ring: &Ring, mut from: u64) -> Option<Vec<u8>> {
        let mut out = Vec::new();
        loop {
            let chunk = ring.read(from, 3)?;
            if chunk.is_empty() {
                return Some(out);
            }
            out.extend_from_slice(chunk);
            from += chunk.len() as u64;
        }
    }

    #[test]
    fn holds_offsets_from_zero_and_reads_from_any_it_holds() {
        let mut ring = Ring::new(8);
        ring.push(b"abcde");
        assert_eq!((ring.start(), ring.end()), (0, 5));
        assert_eq!(read_all(&ring, 2).unwrap(), b"cde");
        assert_eq!(ring.read(5, 4), Some(&b""[..]));
        assert_eq!(ring.read(6, 4), None);
    }

    #[test]
    fn forgets_the_oldest_bytes_once_full_and_says_so() {
        let mut ring = Ring::new(8);
        ring.push(b"0123456789");
        assert_eq!((ring.start(), ring.end(), ring.held()), (2, 10, 8));
        assert_eq!(ring.read(1, 4), None);
        assert_eq!(read_all(&ring, 2).unwrap(), b"23456789");
    }

    #[test]
    fn a_read_stops_where_the_buffer_wraps() {
        let mut ring = Ring::new(8);
        ring.push(b"012345");
        ring.push(b"6789");
        assert_eq!(ring.read(6, 8), Some(&b"67"[..]));
        assert_eq!(ring.read(8, 8), Some(&b"89"[..]));
    }

    proptest! {
        /// The ring holds exactly the last `capacity` bytes of everything written, in order,
        /// however the writes are cut.
        #[test]
        fn is_the_tail_of_everything_written(
            capacity in 1usize..64,
            writes in proptest::collection::vec(proptest::collection::vec(any::<u8>(), 0..100), 0..20),
            // Around the held range: up to past its start, and just past its end.
            back in 0u64..80,
            ahead in 0u64..2,
        ) {
            let mut ring = Ring::new(capacity);
            let mut all = Vec::new();
            for write in &writes {
                ring.push(write);
                all.extend_from_slice(write);
            }
            let end = all.len() as u64;
            let start = end.saturating_sub(capacity as u64);
            let from = end.saturating_sub(back) + ahead;
            prop_assert_eq!((ring.start(), ring.end()), (start, end));
            let expected = (start..=end)
                .contains(&from)
                .then(|| all[usize::try_from(from).unwrap()..].to_vec());
            prop_assert_eq!(read_all(&ring, from), expected);
        }
    }
}
