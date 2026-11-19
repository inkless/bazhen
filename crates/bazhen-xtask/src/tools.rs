//! The version of each cargo tool the gates and falsify run, from `rust-tools.json`, which the
//! TypeScript rails read too. CI, the test container and the docs install these, and a test holds
//! them to this list.

use std::collections::BTreeMap;

const PINS: &str = include_str!("../rust-tools.json");

/// Each tool's pinned version, by name.
fn pins() -> BTreeMap<String, String> {
    serde_json::from_str(PINS).unwrap_or_default()
}

/// The command that installs `tools` at their pinned versions.
pub(crate) fn install_command(tools: &[&str]) -> String {
    let pins = pins();
    let each: Vec<String> = tools
        .iter()
        .map(|tool| format!("{tool}@{}", pins.get(*tool).map_or("", String::as_str)))
        .collect();
    format!("cargo install --locked {}", each.join(" "))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pins_each_tool_the_gates_and_falsify_run_to_one_version() {
        let names: Vec<String> = pins().into_keys().collect();
        assert_eq!(names, ["cargo-deny", "cargo-mutants", "cargo-nextest"]);
        assert!(
            pins().values().all(|v| v.split('.').count() == 3),
            "{:?}",
            pins()
        );
    }

    #[test]
    fn installs_the_tools_named_at_their_pins() {
        let pins = pins();
        assert_eq!(
            install_command(&["cargo-nextest", "cargo-deny"]),
            format!(
                "cargo install --locked cargo-nextest@{} cargo-deny@{}",
                pins["cargo-nextest"], pins["cargo-deny"]
            )
        );
    }
}
