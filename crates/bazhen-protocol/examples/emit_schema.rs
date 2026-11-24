//! Prints the protocol's JSON Schema: every API message and holder body, with each type they
//! name, under `$defs`. `cargo xtask schema` writes the TypeScript protocol from it.

use std::io::Write;
use std::process::ExitCode;

fn main() -> ExitCode {
    let mut generator = bazhen_protocol::schema::generator();
    bazhen_protocol::schema::add_messages(&mut generator);
    bazhen_holder_proto::schema::add_bodies(&mut generator);
    let document = serde_json::json!({
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$defs": generator.take_definitions(true),
    });
    let printed = serde_json::to_string_pretty(&document).map(|text| text + "\n");
    match printed.map(|text| std::io::stdout().lock().write_all(text.as_bytes())) {
        Ok(Ok(())) => ExitCode::SUCCESS,
        Ok(Err(error)) => {
            let _ = writeln!(std::io::stderr(), "emit_schema: {error}");
            ExitCode::FAILURE
        }
        Err(error) => {
            let _ = writeln!(std::io::stderr(), "emit_schema: {error}");
            ExitCode::FAILURE
        }
    }
}
