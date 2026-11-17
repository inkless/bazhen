//! What the CLI prints: the answer on stdout, diagnostics on stderr, each a line at a time. A
//! closed stdout, as a pipe into `head` leaves, ends the printing quietly, never in an error.

use std::io::{self, Write};

#[derive(Debug, Default)]
pub(crate) struct Out {
    closed: bool,
    err_closed: bool,
}

impl Out {
    /// `text` and a newline on stdout.
    pub(crate) fn line(&mut self, text: &str) {
        if !self.closed && writeln!(io::stdout().lock(), "{text}").is_err() {
            self.closed = true;
        }
    }

    /// Whether stdout was found closed: no one reads what is printed now.
    pub(crate) fn closed(&self) -> bool {
        self.closed
    }

    /// `text` and a newline on stderr; a stderr no one reads is no reason to fail either.
    pub(crate) fn err(&mut self, text: &str) {
        if !self.err_closed && writeln!(io::stderr().lock(), "{text}").is_err() {
            self.err_closed = true;
        }
    }
}
