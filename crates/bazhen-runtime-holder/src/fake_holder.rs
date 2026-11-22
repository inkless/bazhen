//! The holder's end of one connection, knowing nothing of what a holder does, as
//! `testing/fake-holder.ts` is: the test reads the requests in order and writes the answers and
//! events. It reads only when the test asks it to, so between reads it is a holder that has
//! stopped reading.

use std::future::Future as _;
use std::io;
use std::path::Path;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::task::{Context, Poll};

use bazhen_holder_proto::body::{
    Count, Generation, HelloReply, HelloRequest, Offset, Pid, ProtocolVersion, Size, StartTime,
    Tags, TerminalId, Versions,
};
use bazhen_holder_proto::{FrameDecoder, PROTOCOL_VERSION, Reply, Request, request_decoder};
use futures_util::future::join;
use tokio::io::{AsyncRead, AsyncReadExt as _, AsyncWrite, AsyncWriteExt as _, ReadBuf};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::oneshot;

use crate::client::{ClientOptions, HolderClient, HolderEvents, connect, open};

/// What a fake holder answers `hello` with, before a test's changes.
pub(crate) fn fake_hello() -> HelloReply {
    HelloReply {
        version: ProtocolVersion::new(PROTOCOL_VERSION).unwrap(),
        protocol: Versions::spoken(),
        terminal_id: TerminalId::new("fake").unwrap(),
        tags: Tags::default(),
        generation: Generation::new(0).unwrap(),
        holder_pid: Pid::new(4242).unwrap(),
        holder_start: StartTime::new(1_700_000_000).unwrap(),
        child_pid: Pid::new(4243).unwrap(),
        child_start: StartTime::new(1_700_000_000).unwrap(),
        exit: None,
        size: Size {
            cols: 80.try_into().unwrap(),
            rows: 24.try_into().unwrap(),
        },
        offset: Offset::new(0).unwrap(),
        title: String::new(),
        alternate: false,
        history_lines: Count::new(10_000).unwrap(),
        writer: false,
        engine: None,
    }
}

#[derive(Debug)]
pub(crate) struct FakeHolder {
    stream: UnixStream,
    decoder: FrameDecoder<Request>,
    chunk: Vec<u8>,
}

/// A client past `hello` with a fake holder at the far end of its socket pair.
#[derive(Debug)]
pub(crate) struct Connected {
    pub(crate) client: HolderClient,
    pub(crate) events: HolderEvents,
    pub(crate) holder: FakeHolder,
    /// What the client said hello with.
    pub(crate) hello: HelloRequest,
    /// The client's writes so far, `hello` the first.
    pub(crate) writes: Arc<AtomicUsize>,
}

impl FakeHolder {
    /// A client on a socket pair, opened with the default options, its `hello` answered.
    pub(crate) async fn client() -> Connected {
        Self::client_with(ClientOptions::default()).await
    }

    /// A client on a socket pair, opened with `options`, its `hello` answered.
    pub(crate) async fn client_with(options: ClientOptions) -> Connected {
        let (near, far) = UnixStream::pair().unwrap();
        let (read, write) = near.into_split();
        let (write, writes) = Counted::new(write);
        let mut holder = Self::new(far);
        let (opened, hello) = join(open(read, write, &options), holder.answer_hello()).await;
        let (client, events) = opened.unwrap();
        Connected {
            client,
            events,
            holder,
            hello,
            writes,
        }
    }

    /// A client `connect`ed, with the default options, to a socket this fake binds at `path`,
    /// its `hello` answered with `fake_hello` changed by `edit`.
    pub(crate) async fn client_at(
        path: &Path,
        edit: impl FnOnce(&mut HelloReply),
    ) -> (HolderClient, HolderEvents, Self) {
        let listener = UnixListener::bind(path).unwrap();
        let holder_side = async {
            let (stream, _) = listener.accept().await.unwrap();
            let mut holder = Self::new(stream);
            holder.answer_hello_with(edit).await;
            holder
        };
        let (connected, holder) = join(connect(path, &ClientOptions::default()), holder_side).await;
        let (client, events) = connected.unwrap();
        (client, events, holder)
    }

    pub(crate) fn new(stream: UnixStream) -> Self {
        Self {
            stream,
            decoder: request_decoder(),
            chunk: vec![0; 64 << 10],
        }
    }

    /// The next request the client sent, `hello` included.
    pub(crate) async fn request(&mut self) -> Request {
        self.next()
            .await
            .expect("the client hung up while the test waited for a request")
    }

    /// The next request, or `None` once the client has hung up.
    pub(crate) async fn next(&mut self) -> Option<Request> {
        loop {
            if let Some(request) = self.decoder.next_frame().unwrap() {
                return Some(request);
            }
            match self.stream.read(&mut self.chunk).await {
                Ok(0) | Err(_) => return None,
                Ok(n) => self.decoder.push(&self.chunk[..n]),
            }
        }
    }

    /// Reads `hello` and answers it with `fake_hello`, changed by `edit`, the writer slot given
    /// when asked for.
    pub(crate) async fn answer_hello_with(
        &mut self,
        edit: impl FnOnce(&mut HelloReply),
    ) -> HelloRequest {
        let Request::Hello { id, body } = self.request().await else {
            panic!("the client didn't say hello first");
        };
        let mut hello = fake_hello();
        hello.writer = body.writer.unwrap_or(false);
        edit(&mut hello);
        self.send(&[Reply::Hello { id, body: hello }]).await;
        body
    }

    pub(crate) async fn answer_hello(&mut self) -> HelloRequest {
        self.answer_hello_with(|_| {}).await
    }

    /// Writes the replies and events in one write.
    pub(crate) async fn send(&mut self, replies: &[Reply]) {
        let bytes: Vec<u8> = replies
            .iter()
            .flat_map(|reply| reply.encode().unwrap())
            .collect();
        self.send_raw(&bytes).await;
    }

    pub(crate) async fn send_raw(&mut self, bytes: &[u8]) {
        self.stream.write_all(bytes).await.unwrap();
    }

    /// Ends this side's writing, leaving its reading open: a half-close.
    pub(crate) async fn half_close(&mut self) {
        self.stream.shutdown().await.unwrap();
    }

    /// Every request until the client hangs up.
    pub(crate) async fn until_eof(&mut self) -> Vec<Request> {
        let mut requests = Vec::new();
        while let Some(request) = self.next().await {
            requests.push(request);
        }
        requests
    }
}

/// A client's write half that counts its writes, as the TS fake counts the chunks it reads: a
/// batch of frames is one.
#[derive(Debug)]
pub(crate) struct Counted<W> {
    inner: W,
    writes: Arc<AtomicUsize>,
}

impl<W> Counted<W> {
    pub(crate) fn new(inner: W) -> (Self, Arc<AtomicUsize>) {
        let writes = Arc::new(AtomicUsize::new(0));
        let counted = Self {
            inner,
            writes: Arc::clone(&writes),
        };
        (counted, writes)
    }
}

impl<W: AsyncWrite + Unpin> AsyncWrite for Counted<W> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        let written = Pin::new(&mut self.inner).poll_write(cx, bytes);
        if let Poll::Ready(Ok(n)) = written
            && n > 0
        {
            self.writes.fetch_add(1, Ordering::Relaxed);
        }
        written
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

/// A client's read half that fails, as a socket does on EPIPE, once its sender is used.
#[derive(Debug)]
pub(crate) struct Breakable<R> {
    inner: R,
    broken: Option<oneshot::Receiver<()>>,
}

impl<R> Breakable<R> {
    pub(crate) fn new(inner: R) -> (Self, oneshot::Sender<()>) {
        let (breaks, broken) = oneshot::channel();
        let breakable = Self {
            inner,
            broken: Some(broken),
        };
        (breakable, breaks)
    }
}

impl<R: AsyncRead + Unpin> AsyncRead for Breakable<R> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if let Some(broken) = self.broken.as_mut()
            && let Poll::Ready(said) = Pin::new(broken).poll(cx)
        {
            self.broken = None;
            if said.is_ok() {
                return Poll::Ready(Err(io::Error::new(io::ErrorKind::BrokenPipe, "EPIPE")));
            }
        }
        Pin::new(&mut self.inner).poll_read(cx, buf)
    }
}
