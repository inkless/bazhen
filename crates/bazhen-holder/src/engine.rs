//! The terminal engine inside the holder, behind a wall: every call into it runs under
//! `catch_unwind`, so a panic in the engine never ends the holder, its child or its connections.
//! After one, the engine is dropped whole and a fresh one, empty, takes its place; past
//! `MOST_ENGINE_RESETS` the holder goes on without one. Nothing else is behind the wall: a panic
//! anywhere outside it is a bug in the holder.

use std::fmt;
use std::panic::{AssertUnwindSafe, catch_unwind};

use bazhen_holder_engine::{Colours, Engine, HistoryRows, Rgb, Size, Stats, TooLarge};
use bazhen_holder_proto::body::Theme;

use crate::holder::Output;
use crate::ring::Ring;

/// How many times a failed engine is replaced in a holder's life. One that fails again after
/// that is left failed: the terminal runs on without answers to its queries or a screen to
/// snapshot, rather than rebuild an engine some output keeps breaking.
pub const MOST_ENGINE_RESETS: u32 = 3;

/// What the holder asks of its engine: `Engine`'s calls, so a test can stand a failing one in.
pub trait Vt: fmt::Debug {
    fn advance(&mut self, bytes: &[u8]);
    fn take_replies(&mut self) -> Vec<u8>;
    fn resize(&mut self, size: Size);
    fn set_colours(&mut self, colours: Option<Colours>);
    fn respawned(&mut self);
    /// # Errors
    ///
    /// As [`Engine::snapshot`].
    fn snapshot(&mut self, most: usize, out: &mut String) -> Result<usize, TooLarge>;
    /// # Errors
    ///
    /// As [`Engine::text`].
    fn text(&mut self, history: usize, most: usize, out: &mut String) -> Result<usize, TooLarge>;
    fn stats(&self) -> Stats;
    fn title(&self) -> Option<&str>;
    fn alternate(&self) -> bool;
    /// Whether the program has bracketed paste (`?2004`) on.
    fn bracketed_paste(&self) -> bool;
}

impl Vt for Engine {
    fn advance(&mut self, bytes: &[u8]) {
        Self::advance(self, bytes);
    }

    fn take_replies(&mut self) -> Vec<u8> {
        Self::take_replies(self)
    }

    fn resize(&mut self, size: Size) {
        Self::resize(self, size);
    }

    fn set_colours(&mut self, colours: Option<Colours>) {
        Self::set_colours(self, colours);
    }

    fn respawned(&mut self) {
        Self::respawned(self);
    }

    fn snapshot(&mut self, most: usize, out: &mut String) -> Result<usize, TooLarge> {
        Self::snapshot(self, most, out)
    }

    fn text(&mut self, history: usize, most: usize, out: &mut String) -> Result<usize, TooLarge> {
        Self::text(self, history, most, out)
    }

    fn stats(&self) -> Stats {
        Self::stats(self)
    }

    fn title(&self) -> Option<&str> {
        Self::title(self)
    }

    fn alternate(&self) -> bool {
        Self::alternate(self)
    }

    fn bracketed_paste(&self) -> bool {
        Self::modes(self).bracketed_paste
    }
}

/// Makes an engine for a terminal of a size, keeping so many rows of history.
pub type MakeVt = fn(Size, HistoryRows) -> Box<dyn Vt>;

/// The holder's own engine.
pub fn engine(size: Size, history: HistoryRows) -> Box<dyn Vt> {
    Box::new(Engine::new(size, history))
}

/// The text and background a program in `theme` is told it is drawn in; dark with no theme.
pub fn colours(theme: Option<Theme>) -> Colours {
    let colours = theme.unwrap_or(Theme::Dark).colours();
    let rgb = |[r, g, b]: [u8; 3]| Rgb { r, g, b };
    Colours {
        text: rgb(colours.text),
        background: rgb(colours.background),
    }
}

/// The engine, and what it takes to build its replacement.
///
/// A panic can leave the engine, its parser, its mode tracker and a partial line in any state, so
/// all of them, which `Vt` holds together, are dropped together and never called again. The new
/// engine is built at the terminal's size, history depth and colours now, and never fed the ring:
/// output that broke one engine could break the next, so the screen is lost, and what follows
/// draws on an empty one. Replies the failed engine had not handed over go with it.
#[derive(Debug)]
pub struct Walled {
    vt: Option<Box<dyn Vt>>,
    make: MakeVt,
    size: Size,
    history: HistoryRows,
    colours: Colours,
    resets: u32,
}

impl Walled {
    pub fn new(make: MakeVt, size: Size, history: HistoryRows, theme: Option<Theme>) -> Self {
        let mut walled = Self {
            vt: None,
            make,
            size,
            history,
            colours: colours(theme),
            resets: 0,
        };
        walled.vt = walled.build();
        if walled.vt.is_none() {
            walled.replace();
        }
        walled
    }

    /// Whether an engine serves the terminal, or the holder has given up on one.
    pub fn alive(&self) -> bool {
        self.vt.is_some()
    }

    /// How many attempts there have been to replace a failed engine, one that failed to build
    /// counted too: at most `MOST_ENGINE_RESETS`. Giving up is `alive` turning false.
    pub const fn resets(&self) -> u32 {
        self.resets
    }

    pub fn advance(&mut self, bytes: &[u8]) {
        self.call("advance", |vt| vt.advance(bytes));
    }

    /// The engine's replies since the last take; none when it failed meanwhile.
    pub fn take_replies(&mut self) -> Vec<u8> {
        self.call("take_replies", |vt| vt.take_replies())
            .unwrap_or_default()
    }

    pub fn resize(&mut self, size: Size) {
        self.size = size;
        self.call("resize", |vt| vt.resize(size));
    }

    /// Starts a new generation's output (`Engine::respawned`), drawn in `theme`'s colours.
    pub fn respawned(&mut self, theme: Option<Theme>) {
        self.call("respawned", |vt| vt.respawned());
        self.set_theme(theme);
    }

    /// Tells programs that ask they are drawn in `theme`'s colours, dark with none.
    pub fn set_theme(&mut self, theme: Option<Theme>) {
        let colours = colours(theme);
        self.colours = colours;
        self.call("set_colours", |vt| vt.set_colours(Some(colours)));
    }

    /// The engine's snapshot (`Engine::snapshot`); `None` with no engine, or when it failed
    /// writing one, and `out` is then as it was.
    pub fn snapshot(&mut self, most: usize, out: &mut String) -> Option<Result<usize, TooLarge>> {
        let start = out.len();
        let written = self.call("snapshot", |vt| vt.snapshot(most, out));
        if written.is_none() {
            out.truncate(start);
        }
        written
    }

    /// The engine's plain text (`Engine::text`); `None` with no engine, or when it failed
    /// writing it, and `out` is then as it was.
    pub fn text(
        &mut self,
        history: usize,
        most: usize,
        out: &mut String,
    ) -> Option<Result<usize, TooLarge>> {
        let start = out.len();
        let written = self.call("text", |vt| vt.text(history, most, out));
        if written.is_none() {
            out.truncate(start);
        }
        written
    }

    pub fn stats(&mut self) -> Option<Stats> {
        self.call("stats", |vt| vt.stats())
    }

    /// The title the program set, empty if none or with no engine.
    pub fn title(&mut self) -> String {
        self.call("title", |vt| vt.title().map(str::to_owned))
            .flatten()
            .unwrap_or_default()
    }

    /// Whether the alternate screen is up; false with no engine.
    pub fn alternate(&mut self) -> bool {
        self.call("alternate", |vt| vt.alternate()).unwrap_or(false)
    }

    /// Whether the program has bracketed paste on; `None` with no engine, or when it failed
    /// answering.
    pub fn bracketed_paste(&mut self) -> Option<bool> {
        self.call("bracketed_paste", |vt| vt.bracketed_paste())
    }

    /// Runs `call` on the engine, if there is one; a panic in it replaces the engine.
    fn call<R>(&mut self, what: &'static str, call: impl FnOnce(&mut dyn Vt) -> R) -> Option<R> {
        let vt = self.vt.as_deref_mut()?;
        if let Ok(done) = catch_unwind(AssertUnwindSafe(|| call(vt))) {
            return Some(done);
        }
        tracing::error!(call = what, "the terminal engine failed");
        let failed = self.vt.take();
        // Dropping a broken engine runs its code too.
        if catch_unwind(AssertUnwindSafe(|| drop(failed))).is_err() {
            tracing::error!("the failed terminal engine failed again as it was dropped");
        }
        self.replace();
        None
    }

    /// Builds a fresh engine in place of the failed one, while resets are left: a build that
    /// fails counts as another.
    fn replace(&mut self) {
        while self.vt.is_none() && self.resets < MOST_ENGINE_RESETS {
            self.resets += 1;
            self.vt = self.build();
            if self.vt.is_some() {
                tracing::warn!(
                    resets = self.resets,
                    "replaced the terminal engine with an empty one"
                );
            }
        }
        if self.vt.is_none() {
            self.resets = MOST_ENGINE_RESETS;
            tracing::error!(
                resets = self.resets,
                "the terminal engine keeps failing; the terminal runs on without one"
            );
        }
    }

    fn build(&self) -> Option<Box<dyn Vt>> {
        let (make, size, history, colours) = (self.make, self.size, self.history, self.colours);
        catch_unwind(move || {
            let mut vt = make(size, history);
            vt.set_colours(Some(colours));
            vt
        })
        .ok()
    }
}

/// Where the holder writes the child's output: the ring and the engine, together, so the engine
/// has always parsed exactly the output up to the ring's end, and a snapshot is exact as of it.
#[derive(Debug)]
pub struct Screen {
    ring: Ring,
    engine: Walled,
}

impl Screen {
    pub const fn new(ring: Ring, engine: Walled) -> Self {
        Self { ring, engine }
    }

    pub const fn ring(&self) -> &Ring {
        &self.ring
    }

    pub const fn engine(&self) -> &Walled {
        &self.engine
    }

    pub const fn engine_mut(&mut self) -> &mut Walled {
        &mut self.engine
    }
}

impl Output for Screen {
    fn write(&mut self, bytes: &[u8]) {
        self.ring.push(bytes);
        self.engine.advance(bytes);
    }

    fn take_replies(&mut self) -> Vec<u8> {
        self.engine.take_replies()
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use std::cell::RefCell;

    use super::*;

    /// What an engine fails on: a test writes it into the output.
    pub(crate) const FAIL: &[u8] = b"<fail>";

    thread_local! {
        /// Each `Failing` built on this thread, by the order it was built in: what it was fed.
        static FED: RefCell<Vec<Vec<u8>>> = const { RefCell::new(Vec::new()) };
        /// Builds to fail from here on, on this thread.
        static FAIL_BUILDS: RefCell<u32> = const { RefCell::new(0) };
        /// Snapshots to fail from here on, on this thread.
        static FAIL_SNAPSHOTS: RefCell<u32> = const { RefCell::new(0) };
    }

    /// Makes the next `count` snapshots on this thread panic.
    pub(crate) fn fail_snapshots(count: u32) {
        FAIL_SNAPSHOTS.with_borrow_mut(|left| *left = count);
    }

    fn fed() -> Vec<Vec<u8>> {
        FED.with_borrow(Clone::clone)
    }

    /// A real engine that panics on `FAIL`, and refuses any call after a panic but a take of its
    /// replies.
    #[derive(Debug)]
    pub(crate) struct Failing {
        engine: Engine,
        built: usize,
        failed: bool,
    }

    impl Failing {
        fn check(&self) {
            assert!(!self.failed, "a failed engine was called again");
        }
    }

    impl Vt for Failing {
        fn advance(&mut self, bytes: &[u8]) {
            self.check();
            FED.with_borrow_mut(|fed| fed[self.built].extend_from_slice(bytes));
            self.engine.advance(bytes);
            if bytes.windows(FAIL.len()).any(|window| window == FAIL) {
                self.failed = true;
                panic!("an engine failing on cue");
            }
        }

        /// Unchecked, so a holder that took a failed engine's replies would get them.
        fn take_replies(&mut self) -> Vec<u8> {
            self.engine.take_replies()
        }

        fn resize(&mut self, size: Size) {
            self.check();
            self.engine.resize(size);
        }

        fn set_colours(&mut self, colours: Option<Colours>) {
            self.check();
            self.engine.set_colours(colours);
        }

        fn respawned(&mut self) {
            self.check();
            self.engine.respawned();
        }

        fn snapshot(&mut self, most: usize, out: &mut String) -> Result<usize, TooLarge> {
            self.check();
            let fail = FAIL_SNAPSHOTS.with_borrow_mut(|left| {
                let fail = *left > 0;
                *left = left.saturating_sub(1);
                fail
            });
            let written = self.engine.snapshot(most, out);
            if fail {
                self.failed = true;
                panic!("a snapshot failing on cue");
            }
            written
        }

        fn text(
            &mut self,
            history: usize,
            most: usize,
            out: &mut String,
        ) -> Result<usize, TooLarge> {
            self.check();
            self.engine.text(history, most, out)
        }

        fn stats(&self) -> Stats {
            self.check();
            self.engine.stats()
        }

        fn title(&self) -> Option<&str> {
            self.check();
            self.engine.title()
        }

        fn alternate(&self) -> bool {
            self.check();
            self.engine.alternate()
        }

        fn bracketed_paste(&self) -> bool {
            self.check();
            self.engine.modes().bracketed_paste
        }
    }

    pub(crate) fn failing(size: Size, history: HistoryRows) -> Box<dyn Vt> {
        let fail = FAIL_BUILDS.with_borrow_mut(|left| {
            let fail = *left > 0;
            *left = left.saturating_sub(1);
            fail
        });
        assert!(!fail, "a build failing on cue");
        let built = FED.with_borrow_mut(|fed| {
            fed.push(Vec::new());
            fed.len() - 1
        });
        Box::new(Failing {
            engine: Engine::new(size, history),
            built,
            failed: false,
        })
    }

    const SIZE: Size = Size { cols: 80, rows: 24 };

    fn walled() -> Walled {
        Walled::new(failing, SIZE, HistoryRows(100), None)
    }

    fn failure() -> Vec<u8> {
        [b"before ".as_slice(), FAIL, b"\x1b[6n"].concat()
    }

    #[test]
    fn a_failed_engine_is_replaced_by_an_empty_one_never_fed_what_came_before() {
        let mut walled = walled();
        walled.advance(b"\x1b]2;kept?\x07first ");
        walled.advance(&failure());
        walled.advance(b"after");
        assert!(walled.alive());
        assert_eq!(walled.resets(), 1);
        assert_eq!(fed()[1], b"after");
        assert_eq!(
            walled.title(),
            "",
            "the new engine took the old one's title"
        );
    }

    /// The tests above wall a failing engine in; the holder walls this one.
    #[test]
    fn the_holders_engine_hands_over_its_replies() {
        let mut walled = Walled::new(engine, SIZE, HistoryRows(100), None);
        walled.advance(b"\x1b[c");
        assert!(
            !walled.take_replies().is_empty(),
            "the control has no reply"
        );
        assert_eq!(walled.take_replies(), b"", "a reply handed over twice");
    }

    #[test]
    fn the_holders_engine_reports_its_title_screen_and_size_and_a_respawn_resets_them() {
        let mut walled = Walled::new(engine, SIZE, HistoryRows(100), None);
        assert!(walled.stats().is_some());
        walled.advance(b"\x1b]2;named\x07\x1b[?1049h");
        assert_eq!(walled.title(), "named");
        assert!(walled.alternate());
        walled.respawned(None);
        assert_eq!(walled.title(), "", "a respawned terminal kept its title");
        assert!(
            !walled.alternate(),
            "a respawned terminal kept its alternate screen"
        );
        walled.resize(Size { cols: 10, rows: 5 });
        walled.advance(b"0123456789ab\x1b[6n");
        assert_eq!(
            walled.take_replies(),
            b"\x1b[2;3R",
            "not wrapped at the new width"
        );
    }

    #[test]
    fn the_holders_engine_answers_a_colour_query_in_its_theme() {
        let mut walled = Walled::new(engine, SIZE, HistoryRows(100), Some(Theme::Light));
        walled.advance(b"\x1b]11;?\x07");
        let [r, g, b] = Theme::Light.colours().background;
        assert_eq!(
            String::from_utf8_lossy(&walled.take_replies()),
            format!("\x1b]11;rgb:{r:02x}{r:02x}/{g:02x}{g:02x}/{b:02x}{b:02x}\x07")
        );
    }

    #[test]
    fn the_failed_calls_replies_go_with_its_engine() {
        let mut walled = walled();
        walled.advance(b"\x1b[c");
        assert!(
            !walled.take_replies().is_empty(),
            "the control has no reply"
        );
        walled.advance(&failure());
        assert_eq!(walled.take_replies(), b"");
    }

    #[test]
    fn the_new_engine_takes_the_size_and_colours_the_terminal_has_now() {
        let mut walled = walled();
        walled.set_theme(Some(Theme::Light));
        walled.resize(Size {
            cols: 100,
            rows: 30,
        });
        walled.advance(&failure());
        walled.advance(b"\x1b]11;?\x07\x1b[999;999H\x1b[6n");
        let replies = String::from_utf8(walled.take_replies()).unwrap();
        assert_eq!(replies, "\x1b]11;rgb:fdfd/fdfd/fdfd\x07\x1b[30;100R");
    }

    #[test]
    fn past_the_most_resets_the_holder_runs_on_without_an_engine() {
        let mut walled = walled();
        for _ in 0..MOST_ENGINE_RESETS {
            walled.advance(&failure());
            assert!(walled.alive());
        }
        walled.advance(&failure());
        assert!(!walled.alive());
        assert_eq!(walled.resets(), MOST_ENGINE_RESETS);
        assert_eq!(
            fed().len(),
            1 + usize::try_from(MOST_ENGINE_RESETS).unwrap()
        );
        walled.advance(b"\x1b[c");
        walled.resize(Size { cols: 10, rows: 5 });
        assert_eq!(walled.take_replies(), b"");
        assert_eq!(walled.snapshot(1 << 20, &mut String::new()), None);
        assert_eq!(walled.stats(), None);
        assert!(!walled.alternate());
    }

    #[test]
    fn a_replacement_that_fails_to_build_counts_as_a_reset() {
        let mut walled = walled();
        FAIL_BUILDS.with_borrow_mut(|left| *left = 1);
        walled.advance(&failure());
        assert!(walled.alive());
        assert_eq!(walled.resets(), 2);
    }

    #[test]
    fn with_no_theme_a_program_is_told_dark() {
        let mut walled = walled();
        walled.advance(b"\x1b]10;?\x07\x1b]11;?\x07");
        assert_eq!(
            String::from_utf8(walled.take_replies()).unwrap(),
            "\x1b]10;rgb:eaea/ebeb/eeee\x07\x1b]11;rgb:0f0f/0f0f/1010\x07"
        );
        walled.set_theme(Some(Theme::Light));
        walled.set_theme(None);
        walled.advance(b"\x1b]11;?\x07");
        assert_eq!(walled.take_replies(), b"\x1b]11;rgb:0f0f/0f0f/1010\x07");
    }

    #[test]
    fn the_screen_feeds_the_ring_and_the_engine_the_same_bytes() {
        let mut screen = Screen::new(Ring::new(1 << 10), walled());
        screen.write(b"one ");
        screen.write(b"two");
        assert_eq!(screen.ring().read(0, 100), Some(b"one two".as_slice()));
        assert_eq!(fed()[0], b"one two");
    }
}
