//! A launch's body, as `POST /v1/agents` reads it: its schema's shape, then the rules it has beyond
//! its shape. Any bytes at all can arrive, so its fuzz target reads them.

use bazhen_protocol::agents::LaunchAgentRequest;

/// The most UTF-16 units an idempotency key has.
const KEY_MAX_UNITS: usize = 200;
/// The compaction windows a launch may ask for, in tokens.
const COMPACT_WINDOW: std::ops::RangeInclusive<u32> = 100_000..=10_000_000;

/// `body` as a launch, held to the rules its schema has beyond its shape.
///
/// # Errors
///
/// Why the body is not a launch, or which rule it breaks, as the 400's message.
pub fn launch_request(body: &[u8]) -> Result<LaunchAgentRequest, String> {
    let req: LaunchAgentRequest = serde_json::from_slice(body)
        .map_err(|err| format!("the body is not an agent to launch: {err}"))?;
    if !(1..=KEY_MAX_UNITS).contains(&req.idempotency_key.encode_utf16().count()) {
        return Err("idempotencyKey is 1 to 200 characters".to_owned());
    }
    if req.cwd.is_empty() {
        return Err("cwd is a path".to_owned());
    }
    if req.project.as_deref() == Some("") {
        return Err("project is a name".to_owned());
    }
    if req
        .compact_window_tokens
        .is_some_and(|tokens| !COMPACT_WINDOW.contains(&tokens))
    {
        return Err("compactWindowTokens is from 100000 to 10000000".to_owned());
    }
    Ok(req)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body(extra: &str) -> Vec<u8> {
        format!(r#"{{"idempotencyKey":"k","harness":"claude-code","cwd":"~/repo"{extra}}}"#)
            .into_bytes()
    }

    #[test]
    fn holds_a_launch_to_its_schemas_bounds() {
        let refused = |extra: &str| launch_request(&body(extra)).err();
        assert_eq!(
            [
                refused(""),
                refused(r#","project":"p","compactWindowTokens":100000"#),
                refused(r#","compactWindowTokens":10000000"#),
                refused(r#","compactWindowTokens":99999"#),
                refused(r#","compactWindowTokens":10000001"#),
                refused(r#","project":"""#),
            ],
            [
                None,
                None,
                None,
                Some("compactWindowTokens is from 100000 to 10000000".to_owned()),
                Some("compactWindowTokens is from 100000 to 10000000".to_owned()),
                Some("project is a name".to_owned()),
            ]
        );
    }

    #[test]
    fn refuses_a_key_past_its_bounds_an_empty_directory_and_a_body_that_isnt_a_launch() {
        let refused = |text: &str| launch_request(text.as_bytes()).err();
        let keyed = |key: &str| {
            format!(r#"{{"idempotencyKey":"{key}","harness":"claude-code","cwd":"/"}}"#)
        };
        let key = "é".repeat(200);
        assert_eq!(refused(&keyed(&key)), None);
        assert_eq!(
            [
                refused(&keyed(&format!("{key}k"))),
                refused(r#"{"idempotencyKey":"","harness":"claude-code","cwd":"/"}"#),
                refused(r#"{"idempotencyKey":"k","harness":"claude-code","cwd":""}"#),
            ],
            [
                Some("idempotencyKey is 1 to 200 characters".to_owned()),
                Some("idempotencyKey is 1 to 200 characters".to_owned()),
                Some("cwd is a path".to_owned()),
            ]
        );
        assert!(
            refused(r#"{"idempotencyKey":"k","harness":"vim","cwd":"/"}"#)
                .is_some_and(|e| e.starts_with("the body is not an agent to launch: "))
        );
    }

    /// The fuzz target's seeds start it where they say: one launch of the fewest fields, one of
    /// every field, and one a rule refuses.
    #[test]
    fn takes_the_fuzz_seeds_as_they_are_named() {
        let least = launch_request(include_bytes!("../fuzz/seeds/agent_launch/least")).unwrap();
        let every =
            launch_request(include_bytes!("../fuzz/seeds/agent_launch/every-field")).unwrap();
        assert_eq!(
            (least.project, every.project, every.compact_window_tokens),
            (None, Some("bazhen".to_owned()), Some(200_000))
        );
        assert!(every.theme.is_some() && every.name.is_some() && every.role.is_some());
        assert_eq!(
            launch_request(include_bytes!("../fuzz/seeds/agent_launch/window-below")).err(),
            Some("compactWindowTokens is from 100000 to 10000000".to_owned())
        );
    }
}
