//! Whether schemars can reach a crate the workspace ships. The protocol crates derive their
//! schemas under a `schema` feature that only their own tests turn on, by a dev-dependency on
//! themselves; a normal or build dependency that turned it on would build schemars into every
//! binary, since a whole-workspace `cargo build` unifies features across its members.

use serde_json::Value;

/// The crates that may declare `schema`.
pub(crate) const DECLARERS: [&str; 2] = ["bazhen-protocol", "bazhen-holder-proto"];

/// The feature that turns the derives on.
const FEATURE: &str = "schema";

/// Every package the shipped build reaches, one per line as `<name> v<version>`: dev edges are
/// left out, being where `schema` is turned on.
pub(crate) const TREE: &[&str] = &[
    "cargo",
    "tree",
    "--workspace",
    "-e",
    "normal,build",
    "--locked",
    "--prefix",
    "none",
    "--format",
    "{p}",
];

/// The members' manifests as cargo reads them.
pub(crate) const METADATA: &[&str] = &[
    "cargo",
    "metadata",
    "--no-deps",
    "--format-version",
    "1",
    "--locked",
];

/// Each line of what `TREE` printed that is schemars.
pub(crate) fn in_tree(printed: &str) -> Vec<String> {
    printed
        .lines()
        .filter(|line| line.starts_with("schemars "))
        .map(|line| format!("the shipped build reaches {line}"))
        .collect()
}

/// Each way a member's manifest, as `METADATA` printed it, could turn `schema` on outside the
/// declaring crates' own tests: a feature of that name elsewhere, a feature of any member that
/// forwards to one, a declarer's feature other than `schema` that turns it or schemars on, which
/// a dependency could then name, or a normal or build dependency that names it. A
/// default-features tree misses all but the last, so they are read from the manifests.
pub(crate) fn in_manifests(json: &str) -> Result<Vec<String>, String> {
    let metadata: Value = serde_json::from_str(json).map_err(|e| e.to_string())?;
    let packages = metadata
        .get("packages")
        .and_then(Value::as_array)
        .ok_or("no `packages` list")?;
    let mut found = Vec::new();
    for package in packages {
        let name = package
            .get("name")
            .and_then(Value::as_str)
            .ok_or("a package with no name")?;
        let features = package
            .get("features")
            .and_then(Value::as_object)
            .ok_or_else(|| format!("{name}: no `features` object"))?;
        if features.contains_key(FEATURE) && !DECLARERS.contains(&name) {
            found.push(format!(
                "{name} declares a `{FEATURE}` feature, which only {} may",
                DECLARERS.join(" and ")
            ));
        }
        for (feature, enables) in features {
            let enables = enables
                .as_array()
                .ok_or_else(|| format!("{name}: feature `{feature}` lists nothing"))?;
            let own = DECLARERS.contains(&name) && feature == FEATURE;
            for enabled in enables.iter().filter_map(Value::as_str) {
                let aliases = enabled == FEATURE && DECLARERS.contains(&name);
                if forwards(enabled) || (!own && (aliases || schemars(enabled))) {
                    found.push(format!("{name}'s feature `{feature}` turns on `{enabled}`"));
                }
            }
        }
        let dependencies = package
            .get("dependencies")
            .and_then(Value::as_array)
            .ok_or_else(|| format!("{name}: no `dependencies` list"))?;
        for dependency in dependencies {
            let kind = dependency.get("kind").and_then(Value::as_str);
            let named = dependency
                .get("features")
                .and_then(Value::as_array)
                .is_some_and(|f| f.contains(&Value::from(FEATURE)));
            if named && kind != Some("dev") {
                let on = dependency
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                found.push(format!(
                    "{name} turns on {on}'s `{FEATURE}` in a {} dependency",
                    kind.unwrap_or("normal")
                ));
            }
        }
    }
    Ok(found)
}

/// Whether a feature's entry turns schemars on: as the optional dependency, by its implicit
/// feature, or by one of its own features.
fn schemars(enabled: &str) -> bool {
    let crate_name = enabled.split_once('/').map_or(enabled, |(name, _)| name);
    let crate_name = crate_name.strip_prefix("dep:").unwrap_or(crate_name);
    crate_name.trim_end_matches('?') == "schemars"
}

/// Whether a feature's entry turns on another crate's `schema`: `<crate>/schema` or
/// `<crate>?/schema`.
fn forwards(enabled: &str) -> bool {
    enabled
        .split_once('/')
        .is_some_and(|(_, feature)| feature == FEATURE)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn member(name: &str, features: &Value, dependencies: &Value) -> Value {
        json!({ "name": name, "features": features, "dependencies": dependencies })
    }

    fn clean() -> Vec<Value> {
        vec![
            member(
                "bazhen-protocol",
                &json!({ "schema": ["dep:schemars"] }),
                &json!([
                    { "name": "schemars", "kind": null, "features": [] },
                    { "name": "bazhen-protocol", "kind": "dev", "features": ["schema"] },
                ]),
            ),
            member(
                "bazhen",
                &json!({}),
                &json!([{ "name": "bazhen-protocol", "kind": null, "features": [] }]),
            ),
        ]
    }

    fn found(packages: &[Value]) -> Vec<String> {
        in_manifests(&json!({ "packages": packages }).to_string()).unwrap()
    }

    #[test]
    fn finds_schemars_in_the_shipped_tree_only_by_its_own_name() {
        let tree = "bazhen v0.1.0 (/r/crates/bazhen)\nserde v1.0.229\nschemars_derive v1.2.3\n";
        assert_eq!(in_tree(tree), Vec::<String>::new());
        assert_eq!(
            in_tree(&format!("{tree}schemars v1.2.3\n")),
            vec!["the shipped build reaches schemars v1.2.3".to_owned()]
        );
    }

    #[test]
    fn passes_the_protocol_crates_turning_schema_on_for_their_own_tests() {
        assert_eq!(found(&clean()), Vec::<String>::new());
    }

    #[test]
    fn finds_a_feature_of_any_member_that_forwards_to_schema() {
        for forward in ["bazhen-protocol/schema", "bazhen-protocol?/schema"] {
            let mut packages = clean();
            packages.push(member("bazhen-cli", &json!({ "x": [forward] }), &json!([])));
            assert_eq!(
                found(&packages),
                vec![format!("bazhen-cli's feature `x` turns on `{forward}`")]
            );
        }
    }

    #[test]
    fn finds_a_normal_or_build_dependency_that_turns_schema_on() {
        for kind in [Value::Null, json!("build")] {
            let mut packages = clean();
            packages.push(member(
                "bazhen-daemon",
                &json!({}),
                &json!([{ "name": "bazhen-protocol", "kind": kind, "features": ["schema"] }]),
            ));
            let kind = kind.as_str().unwrap_or("normal").to_owned();
            assert_eq!(
                found(&packages),
                vec![format!(
                    "bazhen-daemon turns on bazhen-protocol's `schema` in a {kind} dependency"
                )]
            );
        }
    }

    #[test]
    fn finds_a_schema_feature_declared_outside_the_protocol_crates() {
        let mut packages = clean();
        packages.push(member("bazhen-core", &json!({ "schema": [] }), &json!([])));
        assert_eq!(
            found(&packages),
            vec![
                "bazhen-core declares a `schema` feature, which only bazhen-protocol and \
                 bazhen-holder-proto may"
                    .to_owned()
            ]
        );
    }

    #[test]
    fn finds_a_feature_besides_schema_that_turns_it_or_schemars_on() {
        for (declarer, enabled) in [
            (true, "schema"),
            (true, "dep:schemars"),
            (true, "schemars"),
            (true, "schemars/derive"),
            (false, "dep:schemars"),
            (false, "schemars?/preserve_order"),
        ] {
            let mut packages = clean();
            let name = if declarer {
                "bazhen-holder-proto"
            } else {
                "bazhen-cli"
            };
            packages.push(member(name, &json!({ "x": [enabled] }), &json!([])));
            assert_eq!(
                found(&packages),
                vec![format!("{name}'s feature `x` turns on `{enabled}`")],
                "{name}: {enabled}"
            );
        }
        let mut packages = clean();
        packages.push(member(
            "bazhen-cli",
            &json!({ "schema-ish": ["serde"] }),
            &json!([]),
        ));
        assert_eq!(found(&packages), Vec::<String>::new());
    }

    #[test]
    fn refuses_metadata_it_cannot_read() {
        assert!(in_manifests("{").is_err());
        assert!(in_manifests("{}").is_err());
        assert!(in_manifests(&json!({ "packages": [{ "name": "a" }] }).to_string()).is_err());
    }
}
