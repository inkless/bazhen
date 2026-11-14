//! Holds this crate to the fixtures the TypeScript codec writes, for every version kept in
//! `packages/protocol/fixtures/holder/`. The current version's outcomes must match exactly. For
//! an older one, what was valid must still decode to the same type and binary fields: a newer
//! build may add fields to what it re-encodes, and accept what an older one refused.

use std::fs;
use std::path::{Path, PathBuf};

use bazhen_holder_proto::body::{
    DEFAULT_HISTORY_LINES, ERROR_CODES, MAX_COLS, MAX_HISTORY_LINES, MAX_ROWS, RESERVED_ENV_NAMES,
    RESERVED_TAG_NAMES, TAG_NAME_MAX_BYTES, TAG_VALUE_MAX_BYTES, VERSION_MAX_BYTES,
};
use bazhen_holder_proto::{
    MAX_REPLY_BYTES, MAX_REQUEST_BYTES, PROTOCOL_VERSION, SpawnSpecError, decode_spawn_spec,
    negotiate, reply_code, reply_decoder, request_code, request_decoder,
};
use serde_json::{Value, json};

type Result<T> = std::result::Result<T, String>;

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/protocol/fixtures/holder")
}

fn versions() -> Result<Vec<String>> {
    let mut versions = fs::read_dir(root())
        .map_err(|e| e.to_string())?
        .map(|entry| entry.map(|e| e.file_name().to_string_lossy().into_owned()))
        .collect::<std::io::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    versions.sort();
    Ok(versions)
}

fn read(version: &str, name: &str) -> Result<Value> {
    let text = fs::read_to_string(root().join(version).join(name)).map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

fn entries(version: &str, name: &str) -> Result<Vec<Value>> {
    match read(version, name)? {
        Value::Array(entries) => Ok(entries),
        _ => Err(format!("{version}/{name} is not an array")),
    }
}

fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("no {key} in {value}"))
}

fn unhex(text: &str) -> Result<Vec<u8>> {
    (0..text.len())
        .step_by(2)
        .map(|at| {
            text.get(at..at + 2)
                .and_then(|pair| u8::from_str_radix(pair, 16).ok())
                .ok_or_else(|| format!("bad hex at {at}"))
        })
        .collect()
}

/// What this crate makes of a fixture's bytes, in the fixtures' own terms.
#[derive(Debug, PartialEq)]
enum Outcome {
    /// The frame re-encoded: its length-checked bytes after the header.
    Canonical(Vec<u8>),
    Unknown {
        code: u8,
        id: Option<u32>,
    },
    Malformed,
}

fn decode(direction: &str, bytes: &[u8]) -> Result<Outcome> {
    let encoded = match direction {
        "request" => {
            let mut decoder = request_decoder();
            decoder.push(bytes);
            match decoder.next_frame() {
                Err(_) => return Ok(Outcome::Malformed),
                Ok(None) => return Err("decoded no frame".to_owned()),
                Ok(Some(bazhen_holder_proto::Request::Unknown { code, id })) => {
                    return Ok(Outcome::Unknown {
                        code,
                        id: Some(id.0),
                    });
                }
                Ok(Some(frame)) => frame.encode().map_err(|e| e.to_string())?,
            }
        }
        "reply" => {
            let mut decoder = reply_decoder();
            decoder.push(bytes);
            match decoder.next_frame() {
                Err(_) => return Ok(Outcome::Malformed),
                Ok(None) => return Err("decoded no frame".to_owned()),
                Ok(Some(bazhen_holder_proto::Reply::Unknown { code, id })) => {
                    return Ok(Outcome::Unknown {
                        code,
                        id: id.map(|id| id.0),
                    });
                }
                Ok(Some(frame)) => frame.encode().map_err(|e| e.to_string())?,
            }
        }
        other => return Err(format!("no direction {other}")),
    };
    let (length, rest) = encoded
        .split_first_chunk::<4>()
        .ok_or("encoded no header")?;
    if usize::try_from(u32::from_be_bytes(*length)).ok() != Some(rest.len()) {
        return Err("encoded a length that isn't the frame's".to_owned());
    }
    Ok(Outcome::Canonical(rest.to_vec()))
}

/// Whether `encoded` is the canonical form a fixture records: the head byte for byte, then the
/// body as a JSON value or as raw bytes.
fn matches_canonical(encoded: &[u8], canonical: &Value) -> Result<bool> {
    let head = unhex(text(canonical, "head")?)?;
    let Some((ours, body)) = encoded.split_at_checked(head.len()) else {
        return Ok(false);
    };
    if ours != head.as_slice() {
        return Ok(false);
    }
    match (
        canonical.get("json"),
        canonical.get("bytes").and_then(Value::as_str),
    ) {
        (Some(json), _) => Ok(serde_json::from_slice::<Value>(body).ok().as_ref() == Some(json)),
        (None, Some(bytes)) => Ok(body == unhex(bytes)?.as_slice()),
        (None, None) => Err(format!("canonical form with no body: {canonical}")),
    }
}

/// Whether this crate's outcome is the fixture's. `exact` for the current version; otherwise only
/// what was valid is held to, by its type and binary fields, and what was skipped must still not
/// be refused, as a newer build may add fields, know new types and accept what was refused.
fn agrees(ours: &Outcome, outcome: &Value, exact: bool) -> Result<bool> {
    if let Some(canonical) = outcome.get("canonical") {
        let Outcome::Canonical(encoded) = ours else {
            return Ok(false);
        };
        return if exact {
            matches_canonical(encoded, canonical)
        } else {
            Ok(encoded.starts_with(&unhex(text(canonical, "head")?)?))
        };
    }
    if let Some(unknown) = outcome.get("unknown") {
        return Ok(match ours {
            Outcome::Unknown { code, id: Some(id) } => {
                !exact || *unknown == json!({ "code": code, "id": id })
            }
            Outcome::Unknown { code, id: None } => !exact || *unknown == json!({ "code": code }),
            Outcome::Canonical(_) => !exact,
            Outcome::Malformed => false,
        });
    }
    Ok(!exact || *ours == Outcome::Malformed)
}

/// Each frame fixture of `version` this crate disagrees with, by name.
fn frame_mismatches(version: &str, exact: bool) -> Result<Vec<String>> {
    let mut mismatches = Vec::new();
    for fixture in entries(version, "frames.json")? {
        let direction = text(&fixture, "direction")?;
        let name = format!("{version} {direction} {}", text(&fixture, "name")?);
        let ours = decode(direction, &unhex(text(&fixture, "hex")?)?)
            .map_err(|e| format!("{name}: {e}"))?;
        let outcome = fixture
            .get("outcome")
            .ok_or(format!("{name}: no outcome"))?;
        if !agrees(&ours, outcome, exact)? {
            mismatches.push(format!(
                "{name}: decoded to {ours:?}, the fixture says {outcome}"
            ));
        }
    }
    Ok(mismatches)
}

#[test]
fn fixtures_are_kept_for_this_version() {
    assert!(versions().unwrap().iter().any(|v| v == PROTOCOL_VERSION));
}

#[test]
fn every_frame_of_this_version_decodes_and_re_encodes_as_the_typescript_codec_does() {
    assert_eq!(
        frame_mismatches(PROTOCOL_VERSION, true).unwrap(),
        Vec::<String>::new()
    );
}

/// Every version kept, this one included, so the rule runs before there is an older one.
#[test]
fn every_frame_valid_in_any_version_still_decodes_to_its_type_id_and_offset() {
    for version in versions().unwrap() {
        assert_eq!(
            frame_mismatches(&version, false).unwrap(),
            Vec::<String>::new()
        );
    }
}

#[test]
fn an_unknown_event_is_skipped_by_length_its_payload_unread() {
    let fixtures = entries(PROTOCOL_VERSION, "frames.json").unwrap();
    let fixture = fixtures
        .iter()
        .find(|f| {
            f["name"] == "an unknown event, its payload unread though it has a lone surrogate"
        })
        .unwrap();
    let frame = unhex(fixture["hex"].as_str().unwrap()).unwrap();
    let mut decoder = reply_decoder();
    decoder.push(&[frame.as_slice(), &[0, 0, 0, 1, reply_code::DATA]].concat());
    assert_eq!(
        decoder.next_frame().unwrap(),
        Some(bazhen_holder_proto::Reply::Unknown {
            code: 0xc7,
            id: None
        })
    );
    // The frame after it is read from where its length says it ends.
    assert!(
        decoder
            .next_frame()
            .is_err_and(|e| e.reason().contains("offset"))
    );
}

fn spawn_spec_mismatches(version: &str, exact: bool) -> Result<Vec<String>> {
    let mut mismatches = Vec::new();
    for fixture in entries(version, "spawn-specs.json")? {
        let name = format!("{version} {}", text(&fixture, "name")?);
        let ours = decode_spawn_spec(text(&fixture, "json")?.as_bytes());
        let outcome = fixture
            .get("outcome")
            .ok_or(format!("{name}: no outcome"))?;
        let agrees = match (&ours, outcome.get("canonical")) {
            (Ok(spec), Some(canonical)) => {
                !exact || serde_json::to_value(spec).map_err(|e| e.to_string())? == *canonical
            }
            (Err(_), Some(_)) => false,
            (Err(SpawnSpecError::NoSharedVersion { .. }), None) => {
                !exact || outcome.get("noSharedVersion").is_some()
            }
            (Err(SpawnSpecError::Invalid(_)), None) => !exact || outcome.get("invalid").is_some(),
            (Ok(_), None) => !exact,
        };
        if !agrees {
            mismatches.push(format!(
                "{name}: read as {ours:?}, the fixture says {outcome}"
            ));
        }
    }
    Ok(mismatches)
}

#[test]
fn every_spawn_spec_of_this_version_reads_as_the_typescript_reader_does() {
    assert_eq!(
        spawn_spec_mismatches(PROTOCOL_VERSION, true).unwrap(),
        Vec::<String>::new()
    );
}

/// Every version kept, this one included, so the rule runs before there is an older one.
#[test]
fn every_spawn_spec_valid_in_any_version_still_reads() {
    for version in versions().unwrap() {
        assert_eq!(
            spawn_spec_mismatches(&version, false).unwrap(),
            Vec::<String>::new()
        );
    }
}

#[test]
fn every_negotiation_agrees_with_the_typescript_one() {
    for fixture in entries(PROTOCOL_VERSION, "negotiation.json").unwrap() {
        let list = |key: &str| -> Vec<String> {
            fixture[key]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_str().unwrap().to_owned())
                .collect()
        };
        let ours = negotiate(&list("ours"), &list("theirs")).map(|v| v.to_string());
        assert_eq!(ours.as_deref(), fixture["agreed"].as_str(), "{fixture}");
    }
}

#[test]
fn every_constant_is_the_typescript_one() {
    let request_codes = [
        ("hello", request_code::HELLO),
        ("snapshot", request_code::SNAPSHOT),
        ("stats", request_code::STATS),
        ("foreground", request_code::FOREGROUND),
        ("subscribe", request_code::SUBSCRIBE),
        ("input", request_code::INPUT),
        ("resize", request_code::RESIZE),
        ("close", request_code::CLOSE),
        ("signal", request_code::SIGNAL),
        ("respawn", request_code::RESPAWN),
        ("set-tags", request_code::SET_TAGS),
        ("set-theme", request_code::SET_THEME),
    ];
    let reply_codes = [
        ("hello", reply_code::HELLO),
        ("snapshot", reply_code::SNAPSHOT),
        ("stats", reply_code::STATS),
        ("foreground", reply_code::FOREGROUND),
        ("data", reply_code::DATA),
        ("gap", reply_code::GAP),
        ("resized", reply_code::RESIZED),
        ("title", reply_code::TITLE),
        ("alternate", reply_code::ALTERNATE),
        ("exited", reply_code::EXITED),
        ("respawned", reply_code::RESPAWNED),
        ("ok", reply_code::OK),
        ("error", reply_code::ERROR),
    ];
    let codes = |table: &[(&str, u8)]| {
        Value::Object(
            table
                .iter()
                .map(|(name, code)| ((*name).to_owned(), json!(code)))
                .collect(),
        )
    };
    assert_eq!(
        read(PROTOCOL_VERSION, "constants.json").unwrap(),
        json!({
            "HOLDER_PROTOCOL_VERSION": PROTOCOL_VERSION,
            "HOLDER_VERSION_MAX_BYTES": VERSION_MAX_BYTES,
            "HOLDER_TAG_NAME_MAX_BYTES": TAG_NAME_MAX_BYTES,
            "HOLDER_TAG_VALUE_MAX_BYTES": TAG_VALUE_MAX_BYTES,
            "HOLDER_RESERVED_TAG_NAMES": RESERVED_TAG_NAMES,
            "HOLDER_RESERVED_ENV_NAMES": RESERVED_ENV_NAMES,
            "HOLDER_MAX_COLS": MAX_COLS,
            "HOLDER_MAX_ROWS": MAX_ROWS,
            "HOLDER_MAX_HISTORY_LINES": MAX_HISTORY_LINES,
            "HOLDER_DEFAULT_HISTORY_LINES": DEFAULT_HISTORY_LINES,
            "HOLDER_MAX_REQUEST_BYTES": MAX_REQUEST_BYTES,
            "HOLDER_MAX_REPLY_BYTES": MAX_REPLY_BYTES,
            "HOLDER_REQUEST_CODES": codes(&request_codes),
            "HOLDER_REPLY_CODES": codes(&reply_codes),
            "HOLDER_ERROR_CODES": ERROR_CODES,
        })
    );
}
