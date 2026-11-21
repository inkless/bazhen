#![no_main]

use bazhen_host_guard::scope::{
    cgroup_of, is_terminal_scope, mem_total, memory_max_refusal, parse_probe, swap_max_refusal,
    systemd_version,
};
use libfuzzer_sys::fuzz_target;

// Any bytes, as a probe scope, `systemd-run --version`, `/proc/<pid>/cgroup` or `/proc/meminfo`
// could write them, or as a config could name a cap: no reader may panic, a reading keeps only
// what its lines say, and a cgroup it names is one of the text's own lines.
fuzz_target!(|data: &[u8]| {
    if let Some(reading) = parse_probe(data) {
        let text = std::str::from_utf8(data).unwrap();
        for value in [&reading.memory, &reading.swap, &reading.slice]
            .into_iter()
            .flatten()
        {
            assert!(!value.contains('\n'));
            assert!(text.contains(value.as_str()));
        }
    }
    let _ = systemd_version(data);
    let _ = mem_total(data);
    if let Some(cgroup) = cgroup_of(data) {
        assert!(cgroup.starts_with('/'));
        assert!(
            data.split(|b| *b == b'\n')
                .any(|line| line == [b"0::", cgroup.as_bytes()].concat())
        );
        let _ = is_terminal_scope(cgroup);
    }
    if let Ok(text) = std::str::from_utf8(data) {
        let _ = memory_max_refusal(text);
        let _ = swap_max_refusal(text);
        let _ = is_terminal_scope(text);
    }
});
