use std::collections::VecDeque;

/// The program's output, addressed by absolute offset from the first byte it ever wrote. Holds
/// the newest `cap` bytes.
#[derive(Debug)]
pub(crate) struct Ring {
    buf: VecDeque<u8>,
    start: u64,
    cap: usize,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Read {
    /// `from` is older than anything held; the oldest byte held is at `to`.
    Gap {
        to: u64,
    },
    Bytes(Vec<u8>),
    UpToDate,
    Ahead,
}

impl Ring {
    pub(crate) fn new(cap: usize) -> Self {
        Self {
            buf: VecDeque::with_capacity(cap.min(1 << 20)),
            start: 0,
            cap: cap.max(1),
        }
    }

    pub(crate) fn start(&self) -> u64 {
        self.start
    }

    pub(crate) fn end(&self) -> u64 {
        self.start + self.buf.len() as u64
    }

    pub(crate) fn len(&self) -> usize {
        self.buf.len()
    }

    pub(crate) fn push(&mut self, bytes: &[u8]) {
        let tail = bytes.len().saturating_sub(self.cap);
        let bytes = bytes.get(tail..).unwrap_or_default();
        let overflow = (self.buf.len() + bytes.len()).saturating_sub(self.cap);
        self.buf.drain(..overflow.min(self.buf.len()));
        self.start += (overflow + tail) as u64;
        self.buf.extend(bytes);
    }

    pub(crate) fn read(&self, from: u64, max: usize) -> Read {
        if from < self.start {
            return Read::Gap { to: self.start };
        }
        let end = self.end();
        if from == end {
            return Read::UpToDate;
        }
        if from > end {
            return Read::Ahead;
        }
        let Ok(skip) = usize::try_from(from - self.start) else {
            return Read::Ahead;
        };
        let take = (self.buf.len() - skip).min(max);
        let (a, b) = self.buf.as_slices();
        let mut out = Vec::with_capacity(take);
        if let Some(a) = a.get(skip..) {
            out.extend_from_slice(a.get(..take).unwrap_or(a));
        }
        let rest = take - out.len();
        let b_skip = skip.saturating_sub(a.len());
        if let Some(b) = b.get(b_skip..b_skip + rest) {
            out.extend_from_slice(b);
        }
        Read::Bytes(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_are_exact_by_offset_across_eviction() {
        let mut ring = Ring::new(8);
        ring.push(b"0123456");
        ring.push(b"789ab");
        assert_eq!((ring.start(), ring.end()), (4, 12));
        assert_eq!(ring.read(2, 100), Read::Gap { to: 4 });
        assert_eq!(ring.read(5, 4), Read::Bytes(b"5678".to_vec()));
        assert_eq!(ring.read(9, 100), Read::Bytes(b"9ab".to_vec()));
        assert_eq!(ring.read(12, 100), Read::UpToDate);
        assert_eq!(ring.read(13, 100), Read::Ahead);
    }

    #[test]
    fn a_push_larger_than_the_ring_keeps_its_tail() {
        let mut ring = Ring::new(4);
        ring.push(b"abcdefgh");
        assert_eq!((ring.start(), ring.end()), (4, 8));
        assert_eq!(ring.read(4, 100), Read::Bytes(b"efgh".to_vec()));
    }
}
