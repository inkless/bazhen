//! `bazhen-holder-replay <cols> <rows> <history-rows> <engines> <recording>` feeds a recording
//! to that many engines, 64 KiB at a time as a PTY read would, and writes one JSON line: the
//! engines' stats and how fast they took it. It then waits for stdin to close, so whoever runs it
//! can read its memory while the engines are alive. `scripts/engine-replay.ts` drives it.

use std::fs::File;
use std::io::{self, Read as _, Write as _};
use std::process::ExitCode;
use std::time::Instant;

use bazhen_holder_engine::{Engine, HistoryRows, Size, Stats};

const READ: usize = 64 * 1024;

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            // Nothing reads stderr but the person running the bench.
            let _ = writeln!(io::stderr(), "bazhen-holder-replay: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [cols, rows, history, engines, recording] = args.as_slice() else {
        return Err("usage: <cols> <rows> <history-rows> <engines> <recording>".into());
    };
    let number = |text: &String| text.parse::<usize>().map_err(|e| format!("{text}: {e}"));
    let size = Size {
        cols: u16::try_from(number(cols)?).map_err(|e| e.to_string())?,
        rows: u16::try_from(number(rows)?).map_err(|e| e.to_string())?,
    };
    let mut fed = 0;
    let mut kept = Vec::new();
    let start = Instant::now();
    for _ in 0..number(engines)? {
        let mut engine = Engine::new(size, HistoryRows(number(history)?));
        fed += replay(&mut engine, recording)?;
        kept.push(engine);
    }
    let seconds = start.elapsed().as_secs_f64();
    let report = report(kept.first().map(Engine::stats), fed, seconds);
    writeln!(io::stdout(), "{report}").map_err(|e| e.to_string())?;
    let mut rest = Vec::new();
    io::stdin()
        .read_to_end(&mut rest)
        .map_err(|e| e.to_string())?;
    drop(kept);
    Ok(())
}

/// Feeds the recording at `path` to `engine` and returns how many bytes it was.
fn replay(engine: &mut Engine, path: &str) -> Result<usize, String> {
    let mut file = File::open(path).map_err(|e| format!("{path}: {e}"))?;
    let mut buffer = vec![0; READ];
    let mut total = 0;
    loop {
        let read = file.read(&mut buffer).map_err(|e| format!("{path}: {e}"))?;
        let Some(bytes) = buffer.get(..read).filter(|b| !b.is_empty()) else {
            return Ok(total);
        };
        engine.advance(bytes);
        engine.take_replies();
        total += read;
    }
}

fn report(stats: Option<Stats>, fed: usize, seconds: f64) -> String {
    let stats = stats.unwrap_or(Stats {
        engine_bytes: 0,
        history_bytes: 0,
        history_rows: 0,
        overflows: 0,
    });
    // In KiB, which an f64 holds exactly for any count a run could feed.
    let megabytes = f64::from(u32::try_from(fed / 1024).unwrap_or(u32::MAX)) / 1024.0;
    format!(
        "{{\"engineBytes\":{},\"historyBytes\":{},\"historyRows\":{},\"overflows\":{},\"fedBytes\":{fed},\"seconds\":{seconds:.3},\"mbPerSecond\":{:.1}}}",
        stats.engine_bytes,
        stats.history_bytes,
        stats.history_rows,
        stats.overflows,
        megabytes / seconds.max(1e-9),
    )
}
