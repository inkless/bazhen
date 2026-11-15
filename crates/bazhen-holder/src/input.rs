//! The writer's input, on its way to the child: a bounded queue the master is written from as the
//! child reads. A program that stops reading costs at most `INPUT_CAP`, and the writer is told,
//! never dropped from silently.

use std::collections::VecDeque;
use std::io;
use std::os::fd::BorrowedFd;

use bazhen_holder_proto::MAX_REQUEST_BYTES;

/// The most input held for a child that isn't reading: a request's cap, so the largest `input`
/// frame always fits an empty queue.
pub const INPUT_CAP: usize = MAX_REQUEST_BYTES;
/// The most input written to the master in one turn.
const INPUT_PER_TURN: usize = 256 << 10;

/// Input taken whole or refused whole. Once one frame is refused, every later one is too until
/// the child has read all that is queued: a small frame taken after a refused large one would
/// reach the program ahead of it. The queue and its refusal are the terminal's, not a writer's:
/// they carry over to whichever connection holds the slot next.
#[derive(Debug, Default)]
pub struct InputQueue {
    bytes: VecDeque<u8>,
    refusing: bool,
}

/// The input was refused, and nothing of it queued.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InputFull;

impl InputQueue {
    pub fn is_empty(&self) -> bool {
        self.bytes.is_empty()
    }

    pub fn len(&self) -> usize {
        self.bytes.len()
    }

    /// Queues all of `bytes`, or none of them.
    ///
    /// # Errors
    ///
    /// `InputFull` when they don't fit under `INPUT_CAP`, or an earlier frame was refused and the
    /// queue hasn't drained since.
    pub fn offer(&mut self, bytes: &[u8]) -> Result<(), InputFull> {
        if self.refusing || self.bytes.len().saturating_add(bytes.len()) > INPUT_CAP {
            self.refusing = true;
            return Err(InputFull);
        }
        self.bytes.extend(bytes);
        Ok(())
    }

    /// Drops what is queued: the child it was for is gone.
    pub fn clear(&mut self) {
        self.bytes = VecDeque::new();
        self.refusing = false;
    }

    /// Writes what is queued to `master`, up to `INPUT_PER_TURN`, until it would block.
    ///
    /// # Errors
    ///
    /// When a write fails for any reason but a full buffer or a signal, as EIO once nothing holds
    /// the terminal open. The queue is left as it was.
    pub fn write_to(&mut self, master: BorrowedFd<'_>) -> io::Result<()> {
        let mut written = 0;
        while written < INPUT_PER_TURN {
            let (front, _) = self.bytes.as_slices();
            let Some(chunk) = front
                .get(..front.len().min(INPUT_PER_TURN - written))
                .filter(|chunk| !chunk.is_empty())
            else {
                break;
            };
            match rustix::io::write(master, chunk) {
                Ok(0) | Err(rustix::io::Errno::AGAIN) => break,
                Ok(n) => {
                    self.bytes.drain(..n);
                    written += n;
                }
                Err(rustix::io::Errno::INTR) => {}
                Err(e) => return Err(e.into()),
            }
        }
        if self.bytes.is_empty() {
            self.clear();
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::os::fd::AsFd as _;
    use std::os::unix::net::UnixStream;

    use super::*;

    #[test]
    fn takes_a_frame_up_to_the_cap_and_refuses_one_past_it_whole() {
        let mut queue = InputQueue::default();
        assert_eq!(queue.offer(&vec![b'a'; INPUT_CAP - 1]), Ok(()));
        assert_eq!(queue.offer(b"bc"), Err(InputFull));
        assert_eq!(queue.len(), INPUT_CAP - 1);
    }

    #[test]
    fn refuses_a_small_frame_after_a_refused_one_until_the_queue_drains() {
        let (ours, mut peer) = UnixStream::pair().unwrap();
        ours.set_nonblocking(true).unwrap();
        let mut queue = InputQueue::default();
        queue.offer(&vec![b'a'; INPUT_CAP - 10]).unwrap();
        assert_eq!(queue.offer(&[b'b'; 20]), Err(InputFull));
        assert_eq!(queue.offer(b"c"), Err(InputFull));
        let mut read = Vec::new();
        let mut chunk = vec![0; 1 << 16];
        while !queue.is_empty() {
            assert_eq!(queue.offer(b"c"), Err(InputFull), "taken before the drain");
            queue.write_to(ours.as_fd()).unwrap();
            let n = std::io::Read::read(&mut peer, &mut chunk).unwrap();
            read.extend_from_slice(&chunk[..n]);
        }
        assert_eq!(queue.offer(b"c"), Ok(()));
        queue.write_to(ours.as_fd()).unwrap();
        while read.len() < INPUT_CAP - 9 {
            let n = std::io::Read::read(&mut peer, &mut chunk).unwrap();
            read.extend_from_slice(&chunk[..n]);
        }
        let (taken, after) = read.split_at(INPUT_CAP - 10);
        assert!(taken.iter().all(|&b| b == b'a'));
        assert_eq!(after, b"c");
    }

    #[test]
    fn writes_in_order_across_partial_writes() {
        let (ours, mut peer) = UnixStream::pair().unwrap();
        ours.set_nonblocking(true).unwrap();
        let mut queue = InputQueue::default();
        let sent: Vec<u8> = (0..600_000u32).map(|i| (i % 251) as u8).collect();
        for frame in sent.chunks(70_000) {
            queue.offer(frame).unwrap();
        }
        let mut read = Vec::new();
        let mut chunk = vec![0; 1 << 16];
        while read.len() < sent.len() {
            queue.write_to(ours.as_fd()).unwrap();
            let n = std::io::Read::read(&mut peer, &mut chunk).unwrap();
            read.extend_from_slice(&chunk[..n]);
        }
        assert_eq!(read, sent);
    }

    #[test]
    fn a_write_that_fails_leaves_the_queue_and_says_so() {
        let (ours, peer) = UnixStream::pair().unwrap();
        drop(peer);
        let mut queue = InputQueue::default();
        queue.offer(b"lost").unwrap();
        assert!(queue.write_to(ours.as_fd()).is_err());
        assert_eq!(queue.len(), 4);
    }
}
