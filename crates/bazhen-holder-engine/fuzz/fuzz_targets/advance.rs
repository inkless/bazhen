#![no_main]

use bazhen_holder_engine::{
    Colours, Engine, HistoryRows, MOST_REPLY_BYTES, Rgb, Size, replies_are_whole,
};
use libfuzzer_sys::fuzz_target;

// Any output a program could write, read in any pieces and with resizes between them: the
// engine never panics, never lets alacritty's scrollback fill up, which would lose a row, and
// keeps no more history than asked; and the modes it ends in, given to a fresh engine of its
// size, are the modes that engine holds. Its replies, taken after each read, are within their cap
// and whole sequences. The first three bytes choose the size and history limit, and the first's
// top bit whether the engine is given colours to answer with; after that, 0xff and two bytes is a
// resize, and 0xfe ends a read.
fuzz_target!(|input: &[u8]| {
    let [cols, rows, history, rest @ ..] = input else {
        return;
    };
    let size = |cols: u8, rows: u8| Size {
        cols: u16::from(cols % 64),
        rows: u16::from(rows % 32),
    };
    let mut engine = Engine::new(size(*cols, *rows), HistoryRows(usize::from(*history)));
    if cols & 0x80 != 0 {
        let grey = |v| Rgb { r: v, g: v, b: v };
        engine.set_colours(Some(Colours {
            text: grey(*rows),
            background: grey(*history),
        }));
    }
    let mut now = size(*cols, *rows);
    let mut bytes = rest;
    while !bytes.is_empty() {
        match bytes {
            [0xff, cols, rows, after @ ..] => {
                now = size(*cols, *rows);
                engine.resize(now);
                bytes = after;
            }
            _ => {
                let end = bytes
                    .iter()
                    .position(|&b| b == 0xfe || b == 0xff)
                    .unwrap_or(bytes.len());
                let (read, after) = bytes.split_at(end.max(1));
                engine.advance(read);
                bytes = after;
            }
        }
        let replies = engine.take_replies();
        assert!(replies.len() <= MOST_REPLY_BYTES, "{}", replies.len());
        assert!(
            replies_are_whole(&replies),
            "{:?}",
            String::from_utf8_lossy(&replies)
        );
        let stats = engine.stats();
        assert_eq!(stats.overflows, 0);
        assert!(stats.history_rows <= usize::from(*history));
    }
    let limit = usize::from(*history);
    let mut history = String::new();
    engine.write_history(&mut history);
    engine.take_replies();
    let modes = engine.modes();
    let mut fresh = Engine::new(now, HistoryRows(0));
    let mut restore = String::new();
    modes.write_for_engine(&mut restore);
    fresh.advance(restore.as_bytes());
    assert_eq!(fresh.modes(), modes);
    // A snapshot gives a fresh engine of the size the same modes and title, asks it nothing, and
    // changes nothing a second one would show; under a budget it fits, or writes nothing.
    let mut whole = String::new();
    assert!(engine.snapshot_for_engine(usize::MAX, &mut whole).is_ok());
    let mut again = String::new();
    assert!(engine.snapshot_for_engine(usize::MAX, &mut again).is_ok());
    assert_eq!(whole, again);
    let mut restored = Engine::new(now, HistoryRows(limit));
    restored.advance(whole.as_bytes());
    assert_eq!(restored.modes(), modes);
    let shown = |title: Option<&str>| {
        title.map(|t| t.chars().filter(|c| !c.is_control()).collect::<String>())
    };
    assert_eq!(shown(restored.title()), shown(engine.title()));
    assert!(restored.take_replies().is_empty());
    let most = whole.len() / 2;
    let mut cut = String::new();
    match engine.snapshot(most, &mut cut) {
        Ok(_) => assert!(cut.len() <= most, "{} past {most}", cut.len()),
        Err(_) => assert!(cut.is_empty()),
    }
});
