//! `bz-replay <recording> <lines-per-second>` plays a recording to stdout at a steady pace, a
//! line at a time, looping forever: the stand-in for a busy agent.

use std::io::{self, Write as _};
use std::process::ExitCode;
use std::thread::sleep;
use std::time::{Duration, Instant};

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    let Some(path) = args.get(1) else {
        return ExitCode::FAILURE;
    };
    let rate: f64 = args.get(2).and_then(|r| r.parse().ok()).unwrap_or(50.0);
    let Ok(recording) = std::fs::read(path) else {
        return ExitCode::FAILURE;
    };
    let lines: Vec<&[u8]> = recording.split_inclusive(|&b| b == b'\n').collect();
    if lines.is_empty() {
        return ExitCode::FAILURE;
    }
    let period = Duration::from_secs_f64(1.0 / rate.max(0.1));
    let mut stdout = io::stdout();
    let mut next = Instant::now();
    loop {
        for line in &lines {
            if stdout
                .write_all(line)
                .and_then(|()| stdout.flush())
                .is_err()
            {
                return ExitCode::SUCCESS;
            }
            next += period;
            sleep(next.saturating_duration_since(Instant::now()));
        }
    }
}
