//! What the hub sends one view, queued for the task that writes it to the view's socket. axum's
//! `WebSocket` has no `bufferedAmount`, so the queue counts what it was given and the writer has
//! not finished sending, and the hub reads that as how far behind the view is.

use std::future::Future;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use bazhen_protocol::stream::StreamServerFrame;
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::{CancellationToken, DropGuard};

/// The most output a view may have unsent before more is refused. Above the 4 MiB a view may
/// lag by, with room for the 1 MiB piece of a snapshot in flight.
pub(crate) const MOST_UNSENT: usize = 5 << 20;

/// A view's queue: the hub's end and the writer's.
#[must_use]
pub(crate) fn queue(most_unsent: usize) -> (Outbox, Inbox) {
    let (tx, rx) = mpsc::unbounded_channel();
    let unsent = Arc::new(AtomicUsize::new(0));
    let released = CancellationToken::new();
    let quiet = Arc::new(AtomicBool::new(false));
    (
        Outbox {
            tx,
            unsent: Arc::clone(&unsent),
            most_unsent,
            quiet: Arc::clone(&quiet),
            _released: released.clone().drop_guard(),
        },
        Inbox {
            rx,
            unsent: Unsent(unsent),
            released,
            quiet: Quiet(quiet),
        },
    )
}

/// The view is further behind than its queue holds: it is to be ended, never sent a stream with
/// a hole in it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("the view is too far behind its terminal's output")]
pub(crate) struct Behind;

/// The hub's end of a view's queue. Dropping it ends the view's stream once what it holds is
/// written.
#[derive(Debug)]
pub(crate) struct Outbox {
    tx: mpsc::UnboundedSender<Out>,
    unsent: Arc<AtomicUsize>,
    most_unsent: usize,
    /// Set once the view's socket stopped answering.
    quiet: Arc<AtomicBool>,
    /// Tells the writer's end the moment the hub lets go of the view, before what it holds is
    /// written.
    _released: DropGuard,
}

impl Outbox {
    /// Output for the view, refused once its unsent output would pass the most it may hold.
    pub(crate) fn send(&self, output: Vec<u8>) -> Result<(), Behind> {
        self.queue(output, None)
    }

    /// A piece of a snapshot; what it returns hears once the piece is written, or the view's
    /// writer has gone.
    pub(crate) fn send_piece(&self, piece: Vec<u8>) -> Result<oneshot::Receiver<()>, Behind> {
        let (written, heard) = oneshot::channel();
        self.queue(piece, Some(written)).map(|()| heard)
    }

    fn queue(&self, output: Vec<u8>, written: Option<oneshot::Sender<()>>) -> Result<(), Behind> {
        let len = output.len();
        let fits = self
            .unsent
            .try_update(Ordering::AcqRel, Ordering::Acquire, |unsent| {
                unsent
                    .checked_add(len)
                    .filter(|&total| total <= self.most_unsent)
            });
        if fits.is_err() {
            return Err(Behind);
        }
        let sent = Sent {
            len,
            unsent: Arc::clone(&self.unsent),
            written,
        };
        // A writer that has gone drops what it was sent, which counts it as sent.
        let _ = self.tx.send(Out::Output(Output { output, sent }));
        Ok(())
    }

    /// A frame, never refused, so a view is always told why it ends. It counts unsent by the
    /// JSON it goes out as until it is sent, as a browser's `bufferedAmount` counts it.
    pub(crate) fn notify(&self, frame: StreamServerFrame) {
        let len = serde_json::to_string(&frame).map_or(0, |text| text.len());
        self.unsent.fetch_add(len, Ordering::AcqRel);
        let sent = Sent {
            len,
            unsent: Arc::clone(&self.unsent),
            written: None,
        };
        let _ = self.tx.send(Out::Frame { frame, sent });
    }

    /// What was given to the view, output and frames, that its writer has not finished sending.
    #[must_use]
    pub(crate) fn unsent(&self) -> usize {
        self.unsent.load(Ordering::Acquire)
    }

    /// Whether the view's socket stopped answering, so it ends as timed out, not as closed.
    #[must_use]
    pub(crate) fn timed_out(&self) -> bool {
        self.quiet.load(Ordering::Acquire)
    }
}

/// The writer's end of a view's queue.
#[derive(Debug)]
pub(crate) struct Inbox {
    rx: mpsc::UnboundedReceiver<Out>,
    unsent: Unsent,
    released: CancellationToken,
    quiet: Quiet,
}

impl Inbox {
    /// What the view was given and has yet to be sent, read as the writer goes.
    pub(crate) fn unsent(&self) -> Unsent {
        self.unsent.clone()
    }

    /// Cancelled once the hub has let go of the view, which then closes as soon as what it was
    /// given is written.
    pub(crate) fn released(&self) -> CancellationToken {
        self.released.clone()
    }

    /// What says the view's socket stopped answering, for the hub to read as the view ends.
    pub(crate) fn timed_out(&self) -> Quiet {
        self.quiet.clone()
    }

    /// What to send next, in the order the hub queued it; `None` once the hub is done with the
    /// view and everything before has been taken.
    pub(crate) async fn recv(&mut self) -> Option<Out> {
        self.rx.recv().await
    }

    /// What is queued to send next, if anything is yet.
    pub(crate) fn try_recv(&mut self) -> Option<Out> {
        self.rx.try_recv().ok()
    }
}

/// How much a view was given that its writer has not finished sending.
#[derive(Debug, Clone, Default)]
pub(crate) struct Unsent(Arc<AtomicUsize>);

impl Unsent {
    pub(crate) fn get(&self) -> usize {
        self.0.load(Ordering::Acquire)
    }
}

/// Says a view's socket stopped answering.
#[derive(Debug, Clone)]
pub(crate) struct Quiet(Arc<AtomicBool>);

impl Quiet {
    pub(crate) fn timed_out(&self) {
        self.0.store(true, Ordering::Release);
    }
}

/// One thing for a view's socket: output as a binary message, or a frame as a text one. Each
/// counts unsent until its [`Sent`] is dropped.
#[derive(Debug)]
pub(crate) enum Out {
    Output(Output),
    Frame {
        frame: StreamServerFrame,
        sent: Sent,
    },
}

/// Output for a view, counted unsent until what [`Output::into_parts`] gives with it is dropped.
#[derive(Debug)]
pub(crate) struct Output {
    output: Vec<u8>,
    sent: Sent,
}

impl Output {
    /// The output, and what to drop once the send of it has finished.
    #[must_use]
    pub(crate) fn into_parts(self) -> (Vec<u8>, Sent) {
        (self.output, self.sent)
    }
}

/// Counts its output sent when dropped, and tells whoever waits for it to be written.
#[derive(Debug)]
pub(crate) struct Sent {
    len: usize,
    unsent: Arc<AtomicUsize>,
    written: Option<oneshot::Sender<()>>,
}

impl Drop for Sent {
    fn drop(&mut self) {
        self.unsent.fetch_sub(self.len, Ordering::AcqRel);
        if let Some(written) = self.written.take() {
            let _ = written.send(());
        }
    }
}

/// A view's socket, as its writer sends to it.
pub(crate) trait ViewSocket: Send {
    type Error: Send;

    fn output(&mut self, output: Vec<u8>) -> impl Future<Output = Result<(), Self::Error>> + Send;

    fn frame(
        &mut self,
        frame: &StreamServerFrame,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send;
}

/// Writes everything the hub queues for a view to its socket, each output counted sent only once
/// its send has finished, until the hub is done with the view or the socket fails.
///
/// # Errors
///
/// The socket's, the first time a send fails.
#[cfg(test)]
pub(crate) async fn write_to<S: ViewSocket>(
    mut inbox: Inbox,
    socket: &mut S,
) -> Result<(), S::Error> {
    while let Some(out) = inbox.recv().await {
        write_one(out, socket).await?;
    }
    Ok(())
}

/// Writes one thing the hub queued for a view to its socket, counted sent once its send has
/// finished.
///
/// # Errors
///
/// The socket's, if the send fails.
pub(crate) async fn write_one<S: ViewSocket>(out: Out, socket: &mut S) -> Result<(), S::Error> {
    match out {
        Out::Frame { frame, sent } => {
            socket.frame(&frame).await?;
            drop(sent);
        }
        Out::Output(output) => {
            let (output, sent) = output.into_parts();
            socket.output(output).await?;
            drop(sent);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::pin::pin;
    use std::sync::Mutex;
    use std::task::Poll;

    use super::*;
    use crate::testing::runtime;

    /// A socket whose sends of output, and of frames, finish only once the test lets each go.
    #[derive(Default)]
    struct Socket {
        sent: Arc<Mutex<Vec<String>>>,
        let_go: Option<Arc<tokio::sync::Semaphore>>,
        lets_frames_go: Option<Arc<tokio::sync::Semaphore>>,
    }

    impl ViewSocket for Socket {
        type Error = ();

        async fn output(&mut self, output: Vec<u8>) -> Result<(), ()> {
            if let Some(gate) = &self.let_go {
                gate.acquire().await.unwrap().forget();
            }
            self.sent
                .lock()
                .unwrap()
                .push(String::from_utf8(output).unwrap());
            Ok(())
        }

        async fn frame(&mut self, frame: &StreamServerFrame) -> Result<(), ()> {
            if let Some(gate) = &self.lets_frames_go {
                gate.acquire().await.unwrap().forget();
            }
            self.sent.lock().unwrap().push(format!("{frame:?}"));
            Ok(())
        }
    }

    /// Runs `fut` until it can go no further, returning its output if it finished.
    async fn as_far_as_it_goes<F: Future>(fut: std::pin::Pin<&mut F>) -> Option<F::Output> {
        let mut fut = fut;
        for _ in 0..8 {
            let polled = std::future::poll_fn(|cx| Poll::Ready(fut.as_mut().poll(cx))).await;
            if let Poll::Ready(out) = polled {
                return Some(out);
            }
            tokio::task::yield_now().await;
        }
        None
    }

    #[test]
    fn counts_output_unsent_until_its_send_has_finished() {
        runtime().block_on(async {
            let (outbox, inbox) = queue(MOST_UNSENT);
            let gate = Arc::new(tokio::sync::Semaphore::new(0));
            let mut socket = Socket {
                let_go: Some(Arc::clone(&gate)),
                ..Socket::default()
            };
            outbox.send(b"four".to_vec()).unwrap();
            let mut writing = pin!(write_to(inbox, &mut socket));
            assert!(as_far_as_it_goes(writing.as_mut()).await.is_none());
            let while_sending = outbox.unsent();
            gate.add_permits(1);
            assert!(as_far_as_it_goes(writing.as_mut()).await.is_none());
            assert_eq!((while_sending, outbox.unsent()), (4, 0));
        });
    }

    #[test]
    fn counts_a_frame_unsent_until_its_send_has_finished() {
        runtime().block_on(async {
            let (outbox, inbox) = queue(MOST_UNSENT);
            let gate = Arc::new(tokio::sync::Semaphore::new(0));
            let mut socket = Socket {
                lets_frames_go: Some(Arc::clone(&gate)),
                ..Socket::default()
            };
            let frame = StreamServerFrame::SnapshotEnd;
            let encoded = serde_json::to_string(&frame).unwrap().len();
            outbox.notify(frame);
            let mut writing = pin!(write_to(inbox, &mut socket));
            assert!(as_far_as_it_goes(writing.as_mut()).await.is_none());
            let while_sending = outbox.unsent();
            gate.add_permits(1);
            assert!(as_far_as_it_goes(writing.as_mut()).await.is_none());
            assert_eq!((while_sending, outbox.unsent()), (encoded, 0));
        });
    }

    #[test]
    fn refuses_output_past_the_most_a_view_may_have_unsent_but_never_a_frame() {
        let (outbox, mut inbox) = queue(5);
        let first = outbox.send(b"abc".to_vec());
        let second = outbox.send(b"def".to_vec());
        outbox.notify(StreamServerFrame::SnapshotEnd);
        drop(outbox);
        let mut queued = vec![];
        while let Ok(out) = inbox.rx.try_recv() {
            queued.push(match out {
                Out::Output(output) => String::from_utf8(output.into_parts().0).unwrap(),
                Out::Frame { frame, .. } => format!("{frame:?}"),
            });
        }
        assert_eq!(
            (first, second, queued),
            (
                Ok(()),
                Err(Behind),
                vec!["abc".to_owned(), "SnapshotEnd".to_owned()]
            )
        );
    }

    #[test]
    fn counts_a_frame_unsent_by_its_encoding_until_it_is_sent_but_never_refuses_one() {
        runtime().block_on(async {
            let frame = StreamServerFrame::Notice {
                message: "resize failed: writer lost".to_owned(),
            };
            let encoded = serde_json::to_string(&frame).unwrap().len();
            let (outbox, inbox) = queue(encoded);
            outbox.notify(frame.clone());
            outbox.notify(frame);
            let queued = outbox.unsent();
            let refused = outbox.send(b"x".to_vec());
            let mut socket = Socket::default();
            let mut writing = pin!(write_to(inbox, &mut socket));
            assert!(as_far_as_it_goes(writing.as_mut()).await.is_none());
            assert_eq!(
                (queued, refused, outbox.unsent(), outbox.send(b"x".to_vec())),
                (2 * encoded, Err(Behind), 0, Ok(()))
            );
        });
    }

    #[test]
    fn tells_a_piece_s_sender_once_it_is_written_or_its_writer_has_gone() {
        runtime().block_on(async {
            let (outbox, mut inbox) = queue(MOST_UNSENT);
            let mut written = outbox.send_piece(b"piece".to_vec()).unwrap();
            let before = written.try_recv().is_ok();
            let Some(Out::Output(output)) = inbox.recv().await else {
                panic!("the piece was not queued");
            };
            drop(output.into_parts().1);
            let lost = outbox.send_piece(b"lost".to_vec()).unwrap();
            drop(inbox);
            assert_eq!(
                (
                    before,
                    written.await.is_ok(),
                    lost.await.is_ok(),
                    outbox.unsent()
                ),
                (false, true, true, 0)
            );
        });
    }

    #[test]
    fn writes_everything_queued_in_order_and_ends_once_the_hub_is_done_with_the_view() {
        runtime().block_on(async {
            let (outbox, inbox) = queue(MOST_UNSENT);
            let mut socket = Socket::default();
            outbox.notify(StreamServerFrame::SnapshotStart {
                history_lines: Some(3),
            });
            outbox.send(b"drawn".to_vec()).unwrap();
            outbox.notify(StreamServerFrame::Closed);
            drop(outbox);
            write_to(inbox, &mut socket).await.unwrap();
            assert_eq!(
                *socket.sent.lock().unwrap(),
                [
                    "SnapshotStart { history_lines: Some(3) }",
                    "drawn",
                    "Closed"
                ]
            );
        });
    }
}
