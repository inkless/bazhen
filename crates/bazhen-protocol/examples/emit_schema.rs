//! Prints the protocol's JSON Schema: every API message and holder body, with each type they
//! name, under `$defs`, and each event type's entity and payloads under `x-bazhen-events`. `cargo xtask schema` writes the TypeScript protocol from it.
//!
//! `emit_schema verdicts <cases>` instead prints the edge's verdict on each case the file lists,
//! as `{ "schema", "body" }`, in order: `{ "taken": <value> }`, `{ "refused": <rule> }`, or null
//! for a message the edge doesn't read.

use std::io::Write;
use std::process::ExitCode;

use serde_json::{Value, json};

fn schema() -> Value {
    let mut generator = bazhen_protocol::schema::generator();
    bazhen_protocol::schema::add_messages(&mut generator);
    bazhen_holder_proto::schema::add_bodies(&mut generator);
    let events = bazhen_protocol::events::typed::registry(&mut generator);
    json!({
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$defs": generator.take_definitions(true),
        "x-bazhen-events": events,
    })
}

fn verdicts(cases: &str) -> Result<Value, String> {
    let text = std::fs::read_to_string(cases).map_err(|err| format!("{cases}: {err}"))?;
    let cases: Vec<Value> = serde_json::from_str(&text).map_err(|err| format!("{cases}: {err}"))?;
    let judged = cases.iter().map(|case| {
        let name = case.get("schema").and_then(Value::as_str);
        let body = case.get("body").and_then(Value::as_str).unwrap_or_default();
        let verdict = name.and_then(|name| bazhen_protocol::schema::verdict(name, body.as_bytes()));
        verdict.map_or(Value::Null, |verdict| match verdict {
            Ok(taken) => json!({ "taken": taken }),
            Err(rule) => json!({ "refused": rule }),
        })
    });
    Ok(Value::Array(judged.collect()))
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let printed = match args.as_slice() {
        [] => Ok(schema()),
        [mode, cases] if mode == "verdicts" => verdicts(cases),
        _ => Err("usage: emit_schema [verdicts <cases>]".to_owned()),
    }
    .and_then(|value| serde_json::to_string_pretty(&value).map_err(|err| err.to_string()));
    let written = printed.and_then(|text| {
        std::io::stdout()
            .lock()
            .write_all((text + "\n").as_bytes())
            .map_err(|err| err.to_string())
    });
    match written {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            let _ = writeln!(std::io::stderr(), "emit_schema: {error}");
            ExitCode::FAILURE
        }
    }
}
