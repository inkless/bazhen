//! A terminal's live views, as `apps/daemon/src/stream` keeps them: one stream from the terminal's
//! holder shared by every view on it, each view opened on a snapshot seamed to the output that
//! follows, the lease over who drives, and the size the driver's window sets.

pub mod hub;
pub mod lease;
pub mod screen;
pub mod seam;
pub mod view;
