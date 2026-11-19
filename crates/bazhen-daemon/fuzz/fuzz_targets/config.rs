#![no_main]

use bazhen_daemon::config::{DEFAULT_PORT, parse_config, resolve_config};
use libfuzzer_sys::fuzz_target;

const FILE: &str = "/home/u/.config/bazhen/config.toml";

// Any bytes at all, as config.toml could hold them: reading them never panics, a refusal names
// the file, and what is taken resolves, with nothing set in the environment, without panicking,
// to the file's port or the default.
fuzz_target!(|bytes: &[u8]| {
    match parse_config(FILE, bytes) {
        Err(refused) => assert!(refused.0.starts_with(&format!("{FILE}: ")), "{refused}"),
        Ok(file) => {
            if let Ok(config) = resolve_config(&file, &|_| None) {
                assert_eq!(config.port, file.port.unwrap_or(DEFAULT_PORT));
            }
        }
    }
});
