#![no_main]

use bazhen_hook::shell_report::{MAX_LINE, micros, report_body};
use libfuzzer_sys::fuzz_target;

// The line is whatever the shell's stdin carried, and the time whatever the shell passed. The body
// must be one line of text with no raw control character, a line kept or sent as null whole,
// never cut, and the time must come back as the microseconds its digits say, or not at all.
fuzz_target!(|input: (&[u8], &str)| {
    let (line, time) = input;
    let body = report_body(line, 1, "token").expect("a token needing no escape gives a body");
    let text = std::str::from_utf8(&body).expect("the body is UTF-8");
    assert!(!text.bytes().any(|b| b < 0x20 || b == 0x7f), "{text:?}");
    let command = text
        .strip_prefix("{\"token\":\"token\",\"at\":1,\"command\":")
        .and_then(|rest| rest.strip_suffix('}'))
        .expect("the fixed keys around the command");
    let keepable = line.len() <= MAX_LINE && std::str::from_utf8(line).is_ok();
    assert_eq!(command == "null", !keepable, "{command:?}");
    if keepable {
        let unescaped = command
            .strip_prefix('"')
            .and_then(|c| c.strip_suffix('"'))
            .expect("a JSON string");
        assert_eq!(unescape(unescaped).as_bytes(), line);
    }
    if let Some(at) = micros(time) {
        assert!(at <= (1 << 53) - 1);
        let (seconds, _) = time.split_once(['.', ',']).unwrap_or((time, ""));
        assert_eq!(
            at / 1_000_000,
            seconds.parse::<u64>().expect("whole seconds")
        );
    }
});

/// The escapes report_body writes: `\"`, `\\` and `\u00XX`.
fn unescape(s: &str) -> String {
    let mut out = String::new();
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('u') => {
                let hex: String = chars.by_ref().take(4).collect();
                let code = u32::from_str_radix(&hex, 16).expect("four hex digits");
                out.push(char::from_u32(code).expect("a control character"));
            }
            Some(other) => out.push(other),
            None => panic!("a lone backslash"),
        }
    }
    out
}
