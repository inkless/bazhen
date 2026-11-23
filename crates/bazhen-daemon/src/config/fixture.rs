//! The config against what `moon run :schema` records of the TypeScript daemon's
//! (packages/protocol/fixtures/config/): every case's file and environment, read to the same
//! settings or refused with the same words. A case that sets a LAN listener's key, or reaches the
//! LAN listener, is refused here instead: this daemon serves loopback only.

use std::collections::BTreeMap;

use serde_json::{Value, json};

use toml::de::{DeTable, DeValue};

use super::{Config, LOOPBACK_ONLY, OriginsFrom, parse_config, resolve_config};

fn fixture() -> Value {
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/protocol/fixtures/config/typescript.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// The config as the fixture writes the TypeScript one.
fn as_json(config: &Config) -> Value {
    json!({
        "port": config.port,
        "bank": config.bank,
        "loginShell": config.login_shell,
        "envRules": { "deny": config.env_rules.deny, "passthrough": config.env_rules.passthrough },
        "desktopNotifications": config.desktop_notifications,
        "retypeLastCommand": config.retype_last_command,
        "launchLimits": {
            "maxLaunched": config.launch_limits.max_launched,
            "maxDepth": config.launch_limits.max_depth,
        },
        "startDeadlineMs": config.start_deadline_ms,
        "maxOpenTerminals": config.max_open_terminals,
        "historyLines": config.history_lines,
        "defaultRuntime": config.default_runtime.as_str(),
        "terminalCaps": {
            "terminal": config.terminal_caps.terminal,
            "total": config.terminal_caps.total,
            "swap": config.terminal_caps.swap,
        },
        "externalOrigins": config.external_origins,
        "externalOriginsFrom": config.external_origins_from.map(OriginsFrom::as_str),
        "allowInsecureOrigins": config.allow_insecure_origins,
        "pairing": config.pairing.as_str(),
        "pairingRequired": config.pairing_required,
    })
}

/// What this daemon makes of a case: its config, or its message.
fn outcome(file: &str, case: &Value) -> Result<Value, String> {
    let toml = case["toml"].as_str().unwrap();
    let env: BTreeMap<String, String> = serde_json::from_value(case["env"].clone()).unwrap();
    let parsed = parse_config(file, toml.as_bytes()).map_err(|e| e.0)?;
    resolve_config(&parsed, &|name| env.get(name).cloned())
        .map(|config| as_json(&config))
        .map_err(|e| e.0)
}

/// The first of `web.lan_port` and `web.lan_allow` a case's file sets, however it writes `web`.
fn lan_key(case: &Value) -> Option<&'static str> {
    let toml = case["toml"].as_str().unwrap();
    let (root, _) = DeTable::parse_recoverable(toml);
    let Some(DeValue::Table(web)) = root.get_ref().get("web").map(toml::Spanned::get_ref) else {
        return None;
    };
    ["lan_port", "lan_allow"]
        .into_iter()
        .find(|key| web.contains_key(*key))
}

/// The cases that set a LAN listener's key in `[web]`, counted so that a change to which cases
/// this takes for one shows.
const LAN_KEY_CASES: usize = 109;

#[test]
fn reads_every_case_as_the_typescript_daemon_does() {
    let fixture = fixture();
    let file = fixture["file"].as_str().unwrap();
    let cases = fixture["cases"].as_array().unwrap();
    assert!(cases.len() > 500, "{} cases", cases.len());
    let mut wrong = Vec::new();
    let mut lan_key_cases = 0;
    for case in cases {
        let got = outcome(file, case);
        let ts = &case["outcome"];
        let right = if ts["syntax"] == true {
            // A TOML parser's own words differ past what it says the file is.
            got.as_ref().is_err_and(|message| {
                message.starts_with(&format!("{file}: Invalid TOML document: "))
            })
        } else if let Some(key) = lan_key(case) {
            lan_key_cases += 1;
            got == Err(format!("{file}: web.{key}: {LOOPBACK_ONLY}"))
        } else if case["lan"] == true {
            got == Err(format!("web.listen: {LOOPBACK_ONLY}"))
        } else if let Some(message) = ts["error"].as_str() {
            got == Err(message.to_owned())
        } else {
            got.as_ref() == Ok(&ts["config"])
        };
        if !right {
            wrong.push(format!("{}: got {got:?}, expected {ts}", case["name"]));
        }
    }
    assert!(
        wrong.is_empty(),
        "{} wrong:\n{}",
        wrong.len(),
        wrong.join("\n")
    );
    assert_eq!(lan_key_cases, LAN_KEY_CASES);
}

#[test]
fn the_fixture_reaches_the_lan_and_the_file_s_syntax() {
    let fixture = fixture();
    let cases = fixture["cases"].as_array().unwrap();
    assert!(cases.iter().any(|c| c["lan"] == true));
    assert!(cases.iter().any(|c| c["outcome"]["syntax"] == true));
}
