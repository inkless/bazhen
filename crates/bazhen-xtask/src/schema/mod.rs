//! `cargo xtask schema`: the protocol's JSON Schema, as the Rust crates emit it, and the zod
//! written from it, into `target/protocol-shadow/`. Nothing there is committed yet: the
//! TypeScript protocol in packages/protocol is still the one the daemon and clients run. With
//! `--check` it also holds schemars to the crates' own tests (`leaks`). Beside them it writes the
//! planted corpus (`corpus`), with the daemon edge's verdict on each case, and fails where the
//! edge's verdict isn't the protocol's.

mod corpus;
mod leaks;
mod zod;

pub(crate) use corpus::KNOWN_MISMATCHES;

use std::collections::BTreeSet;
use std::io::Write;

use crate::cargo_config;
use crate::cli::Exit;
use crate::gate::{self, Env, Host, Places};

/// The example that prints the schema, as cargo runs it.
const EMIT: &[&str] = &[
    "cargo",
    "run",
    "--quiet",
    "--locked",
    "-p",
    "bazhen-protocol",
    "--example",
    "emit_schema",
];

/// The cases' file, which the example reads for `verdicts`, under `SHADOW`.
const CASES: &str = "corpus/cases.json";

/// The protocol's own schemas, one file a message.
const PROTOCOL_SCHEMAS: &str = "packages/protocol/schema";

/// The protocol's fixtures, one file a message.
const FIXTURES: &str = "packages/protocol/fixtures/api";

/// Where the output goes, under the repository's root.
const SHADOW: &str = "target/protocol-shadow";

/// The checks the schema names, written by hand.
const CHECKS: &str = "packages/protocol/src/checks.ts";

/// `CHECKS` as the generated module, in `SHADOW/gen/`, imports it.
const CHECKS_FROM_SHADOW: &str = "../../../packages/protocol/src/checks.ts";

/// Writes the schema and its zod into `SHADOW`, with the corpus judged against `known`, and with
/// `check` holds schemars to the crates' tests.
pub(crate) fn run(
    check: bool,
    known: corpus::Known<'_>,
    env: Env,
    places: &Places,
    host: &mut impl Host,
    err: &mut impl Write,
) -> Exit {
    let env = gate::gate_env(env);
    let configs = cargo_config::outside_configs(&places.root, &places.cargo_home);
    let read: cargo_config::Read<'_> = &|path| host.read(path);
    let mut problems = cargo_config::config_failures(&configs, read);
    problems.extend(cargo_config::shadow_failure(&places.root, read));
    if !problems.is_empty() {
        let _ = writeln!(err, "{}", problems.join("\n"));
        return Exit::Failed;
    }
    match host.output(EMIT, &env) {
        Ok(Some(printed)) => {
            problems.extend(write_shadow(&printed, places, host));
            if problems.is_empty() {
                problems.extend(write_corpus(&printed, known, &env, places, host));
            }
        }
        Ok(None) => problems
            .push("the schema's example failed: `cargo run --example emit_schema`".to_owned()),
        Err(error) => problems.push(format!("cargo: {error}")),
    }
    if check {
        problems.extend(leaked(&env, host));
    }
    if problems.is_empty() {
        return Exit::Done;
    }
    let _ = writeln!(err, "cargo xtask schema:\n  {}", problems.join("\n  "));
    Exit::Failed
}

/// Writes the schema `printed` holds and the zod written from it.
fn write_shadow(printed: &str, places: &Places, host: &mut impl Host) -> Vec<String> {
    let document: serde_json::Value = match serde_json::from_str(printed) {
        Ok(document) => document,
        Err(error) => return vec![format!("the schema's example printed no JSON: {error}")],
    };
    let source = match zod::generate(&document, CHECKS_FROM_SHADOW) {
        Ok(source) => source,
        Err(problems) => return problems,
    };
    let mut problems = match host.read(&places.root.join(CHECKS)) {
        Ok(text) => unmatched_checks(&source.checks, text.as_deref()),
        Err(error) => vec![format!("{CHECKS}: {error}")],
    };
    let shadow = places.root.join(SHADOW);
    for (path, text) in [
        (shadow.join("schema.json"), printed),
        (shadow.join("gen/protocol.ts"), source.text.as_str()),
    ] {
        if let Err(error) = host.write(&path, text) {
            problems.push(format!("{}: {error}", path.display()));
        }
    }
    problems
}

/// Plants the corpus from the schema `printed` holds, has the example judge each case as the
/// daemon's edge does, and writes both: each disagreement outside `known` is a
/// problem.
fn write_corpus(
    printed: &str,
    known: corpus::Known<'_>,
    env: &Env,
    places: &Places,
    host: &mut impl Host,
) -> Vec<String> {
    let Some(defs) = serde_json::from_str::<serde_json::Value>(printed)
        .ok()
        .and_then(|document| document.get("$defs").and_then(|d| d.as_object()).cloned())
    else {
        return vec!["the schema's example printed no `$defs`".to_owned()];
    };
    let read = |dir: &str, name: &str| {
        let path = places.root.join(dir).join(format!("{name}.json"));
        host.read(&path)
            .ok()
            .flatten()
            .and_then(|text| serde_json::from_str(&text).ok())
    };
    let cases = match corpus::plant(&defs, &|name| read(PROTOCOL_SCHEMAS, name), &|name| {
        read(FIXTURES, name)
    }) {
        Ok(cases) => cases,
        Err(problems) => return problems,
    };
    let listed: Vec<serde_json::Value> = cases.iter().map(corpus::Case::to_json).collect();
    let shadow = places.root.join(SHADOW);
    let cases_at = shadow.join(CASES);
    if let Err(error) = host.write(
        &cases_at,
        &serde_json::Value::from(listed.clone()).to_string(),
    ) {
        return vec![format!("{}: {error}", cases_at.display())];
    }
    let Some(cases_path) = cases_at.to_str() else {
        return vec![format!("{} isn't UTF-8", cases_at.display())];
    };
    let judge: Vec<&str> = EMIT
        .iter()
        .copied()
        .chain(["--", "verdicts", cases_path])
        .collect();
    let verdicts = match host.output(&judge, env) {
        Ok(Some(printed)) => match serde_json::from_str::<Vec<serde_json::Value>>(&printed) {
            Ok(verdicts) => verdicts,
            Err(error) => return vec![format!("the example's verdicts aren't JSON: {error}")],
        },
        Ok(None) => return vec!["the example failed to judge the corpus".to_owned()],
        Err(error) => return vec![format!("cargo: {error}")],
    };
    let judged: Vec<serde_json::Value> = listed
        .into_iter()
        .zip(&verdicts)
        .map(|(mut case, verdict)| {
            if let Some(case) = case.as_object_mut() {
                case.insert("edge".to_owned(), verdict.clone());
            }
            case
        })
        .collect();
    let mut problems = corpus::mismatched(&cases, &verdicts, known);
    let written = shadow.join("corpus.json");
    let text = serde_json::to_string_pretty(&judged).unwrap_or_default() + "\n";
    if let Err(error) = host.write(&written, &text) {
        problems.push(format!("{}: {error}", written.display()));
    }
    problems
}

/// Each check the schema names that `checks.ts` doesn't export, and each it exports that no
/// schema names. With no `checks.ts`, every check named.
fn unmatched_checks(named: &BTreeSet<String>, checks: Option<&str>) -> Vec<String> {
    let exported = checks.map_or_default(exports);
    let missing = named
        .difference(&exported)
        .map(|c| format!("the schema names the check `{c}`, which {CHECKS} doesn't export"));
    let unused = exported
        .difference(named)
        .map(|c| format!("{CHECKS} exports `{c}`, which no schema names"));
    missing.chain(unused).collect()
}

/// The names a TypeScript module exports as `export function` or `export const`.
fn exports(text: &str) -> BTreeSet<String> {
    text.lines()
        .filter_map(|line| {
            let rest = line
                .strip_prefix("export function ")
                .or_else(|| line.strip_prefix("export const "))?;
            let name: String = rest
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
                .collect();
            (!name.is_empty()).then_some(name)
        })
        .collect()
}

/// Each way schemars could reach a shipped crate: in the build's tree, or turned on in a manifest.
fn leaked(env: &Env, host: &mut impl Host) -> Vec<String> {
    let mut found = match host.output(leaks::TREE, env) {
        Ok(Some(printed)) => leaks::in_tree(&printed),
        Ok(None) => {
            vec!["`cargo tree` failed, so the shipped build's crates are unknown".to_owned()]
        }
        Err(error) => vec![format!("cargo: {error}")],
    };
    match host.output(leaks::METADATA, env) {
        Ok(Some(json)) => match leaks::in_manifests(&json) {
            Ok(leaks) => found.extend(leaks),
            Err(why) => found.push(format!("cargo metadata: {why}")),
        },
        Ok(None) => found.push("`cargo metadata` failed, so the manifests are unread".to_owned()),
        Err(error) => found.push(format!("cargo: {error}")),
    }
    found
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::path::{Path, PathBuf};

    use serde_json::json;

    use super::*;
    use crate::gate::Status;

    /// A host whose commands print what it was given, and which keeps what is written.
    #[derive(Default)]
    struct Fake {
        printed: BTreeMap<String, Option<String>>,
        checks: Option<String>,
        written: BTreeMap<PathBuf, String>,
        ran: Vec<String>,
    }

    impl Host for Fake {
        fn sandboxed(&self) -> bool {
            false
        }
        fn read(&self, path: &Path) -> Result<Option<String>, String> {
            if path == Path::new("/a/repo").join(CHECKS) {
                return Ok(self.checks.clone());
            }
            Ok(None)
        }
        fn run(&mut self, _: &[&str], _: &Env, _: bool) -> std::io::Result<Status> {
            Ok(Some(1))
        }
        fn output(&mut self, argv: &[&str], _: &Env) -> std::io::Result<Option<String>> {
            let line = argv.join(" ");
            self.ran.push(line.clone());
            Ok(self.printed.get(&line).cloned().flatten())
        }
        fn write(&mut self, path: &Path, text: &str) -> std::io::Result<()> {
            self.written.insert(path.to_owned(), text.to_owned());
            Ok(())
        }
    }

    fn schema(defs: &serde_json::Value) -> String {
        json!({ "$defs": defs }).to_string()
    }

    fn metadata(packages: &serde_json::Value) -> String {
        json!({ "packages": packages }).to_string()
    }

    fn fake(defs: &serde_json::Value) -> Fake {
        let mut host = Fake::default();
        host.printed.insert(EMIT.join(" "), Some(schema(defs)));
        host.printed.insert(
            leaks::TREE.join(" "),
            Some("bazhen v0.1.0\nserde v1.0.229\n".to_owned()),
        );
        host.printed
            .insert(leaks::METADATA.join(" "), Some(metadata(&json!([]))));
        host.printed.insert(judged(), Some("[]".to_owned()));
        host
    }

    fn judged() -> String {
        format!("{} -- verdicts /a/repo/{SHADOW}/{CASES}", EMIT.join(" "))
    }

    fn ran(host: &mut Fake, check: bool) -> (Exit, String) {
        let places = Places {
            root: "/a/repo".into(),
            cargo_home: "/home/u/.cargo".into(),
        };
        let mut err = Vec::new();
        let exit = run(check, &[], Env::new(), &places, host, &mut err);
        (exit, String::from_utf8(err).unwrap())
    }

    #[test]
    fn writes_the_schema_and_its_zod_into_the_shadow_folder() {
        let mut host = fake(&json!({ "Role": { "type": "string" } }));
        assert_eq!(ran(&mut host, false), (Exit::Done, String::new()));
        let shadow = Path::new("/a/repo").join(SHADOW);
        let zod = host.written.get(&shadow.join("gen/protocol.ts")).unwrap();
        assert!(zod.contains("export const Role = z.string();"), "{zod}");
        assert_eq!(
            host.written.get(&shadow.join("schema.json")),
            Some(&schema(&json!({ "Role": { "type": "string" } })))
        );
        assert!(host.written.keys().all(|p| p.starts_with(&shadow)));
        assert_eq!(host.ran, vec![EMIT.join(" "), judged()]);
        assert_eq!(
            host.written
                .get(&shadow.join("corpus.json"))
                .map(String::as_str),
            Some("[]\n")
        );
    }

    #[test]
    fn fails_with_each_keyword_it_refuses() {
        let mut host = fake(&json!({ "Role": { "type": "string", "not": {} } }));
        let (exit, err) = ran(&mut host, false);
        assert_eq!(exit, Exit::Failed);
        assert!(
            err.contains("$defs/Role/not: is a keyword the generator doesn't read"),
            "{err}"
        );
        assert!(host.written.is_empty());
    }

    #[test]
    fn fails_when_the_example_fails_or_prints_no_json() {
        for printed in [None, Some("not json".to_owned())] {
            let mut host = fake(&json!({}));
            host.printed.insert(EMIT.join(" "), printed);
            assert_eq!(ran(&mut host, false).0, Exit::Failed);
        }
    }

    #[test]
    fn holds_the_named_checks_to_what_checks_ts_exports() {
        let defs = json!({ "A": { "type": "string", "x-bazhen-check": "is_short" } });
        let mut host = fake(&defs);
        let (exit, err) = ran(&mut host, false);
        assert_eq!(exit, Exit::Failed);
        assert!(
            err.contains(
                "names the check `is_short`, which packages/protocol/src/checks.ts doesn't export"
            ),
            "{err}"
        );
        let mut host = fake(&defs);
        host.checks =
            Some("export function is_short(s: string) {}\nexport const unused = 1;\n".to_owned());
        let (exit, err) = ran(&mut host, false);
        assert_eq!(exit, Exit::Failed);
        assert!(
            err.contains("exports `unused`, which no schema names"),
            "{err}"
        );
        let mut host = fake(&defs);
        host.checks = Some("export function is_short(s: string): boolean {\n".to_owned());
        assert_eq!(ran(&mut host, false).0, Exit::Done);
    }

    #[test]
    fn with_check_fails_on_schemars_in_the_shipped_tree_or_turned_on_in_a_manifest() {
        let defs = json!({});
        let mut host = fake(&defs);
        assert_eq!(ran(&mut host, true), (Exit::Done, String::new()));
        assert_eq!(
            host.ran,
            vec![
                EMIT.join(" "),
                judged(),
                leaks::TREE.join(" "),
                leaks::METADATA.join(" ")
            ]
        );
        let mut host = fake(&defs);
        host.printed
            .insert(leaks::TREE.join(" "), Some("schemars v1.2.3\n".to_owned()));
        let (exit, err) = ran(&mut host, true);
        assert_eq!(exit, Exit::Failed);
        assert!(
            err.contains("the shipped build reaches schemars v1.2.3"),
            "{err}"
        );
        let mut host = fake(&defs);
        let forwarding = json!([{ "name": "bazhen", "features": { "x": ["bazhen-protocol/schema"] }, "dependencies": [] }]);
        host.printed
            .insert(leaks::METADATA.join(" "), Some(metadata(&forwarding)));
        let (exit, err) = ran(&mut host, true);
        assert_eq!(exit, Exit::Failed);
        assert!(
            err.contains("bazhen's feature `x` turns on `bazhen-protocol/schema`"),
            "{err}"
        );
    }

    #[test]
    fn with_check_fails_when_cargo_tree_or_metadata_fails() {
        for failing in [leaks::TREE, leaks::METADATA] {
            let mut host = fake(&json!({}));
            host.printed.insert(failing.join(" "), None);
            assert_eq!(ran(&mut host, true).0, Exit::Failed);
        }
    }

    #[test]
    fn reads_the_names_a_module_exports() {
        let text = "export function a(s: string) {}\nexport const b_2 = 1;\nconst c = 2;\n  export function d() {}\nexport type E = 1;\n";
        assert_eq!(
            exports(text),
            BTreeSet::from(["a".to_owned(), "b_2".to_owned()])
        );
    }
}
