#![no_main]

use bazhen_holder_engine::{Engine, HistoryRows, Size};
use libfuzzer_sys::fuzz_target;

// Any output a program could write, read in any pieces: the engine never panics, never lets
// alacritty's scrollback fill up, which would lose a row, and keeps no more history than asked.
// The first three bytes choose the size and history limit; after that, 0xfe ends a read.
fuzz_target!(|input: &[u8]| {
    let [cols, rows, history, rest @ ..] = input else {
        return;
    };
    let size = Size {
        cols: u16::from(cols % 64),
        rows: u16::from(rows % 32),
    };
    let mut engine = Engine::new(size, HistoryRows(usize::from(*history)));
    let mut bytes = rest;
    while !bytes.is_empty() {
        let end = bytes.iter().position(|&b| b == 0xfe).unwrap_or(bytes.len());
        let (read, after) = bytes.split_at(end.max(1));
        engine.advance(read);
        bytes = after;
        let stats = engine.stats();
        assert_eq!(stats.overflows, 0);
        // The store, and the one row a drain leaves in alacritty.
        assert!(stats.history_rows <= usize::from(*history) + 1);
    }
    let mut history = String::new();
    engine.write_history(&mut history);
    engine.take_replies();
});
