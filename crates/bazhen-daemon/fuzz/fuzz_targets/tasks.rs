#![no_main]

use bazhen_daemon::tasks::asked;
use libfuzzer_sys::fuzz_target;

// Any bytes at all, as a body POST /v1/tasks could be sent: reading them never panics, and a task
// taken holds to the rules, its title trimmed, and is kept as JSON that names the human as its
// caller.
fuzz_target!(|bytes: &[u8]| {
    if let Ok((task, _)) = asked(bytes) {
        assert!((1..=200).contains(&task.key.chars().count()));
        assert!((1..=200).contains(&task.title.chars().count()));
        assert_eq!(task.title.trim(), task.title);
        let kept: serde_json::Value = serde_json::from_str(&task.request_text().unwrap()).unwrap();
        assert_eq!(kept["caller"], serde_json::Value::Null);
    }
});
