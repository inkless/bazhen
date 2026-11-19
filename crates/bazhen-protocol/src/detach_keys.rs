//! The keys that detach `bazhen terminals attach`, as `--detach-keys` and `attach.detach_keys` in
//! `config.toml` write them: keys separated by commas, each `ctrl-` and a letter or one of
//! `@ [ \ ] ^ _`, or one printable character. `packages/protocol/src/detach-keys.ts` reads the
//! same text for the daemon, and `checks.json` holds the two to the same verdicts.

use std::fmt;

/// `Ctrl-] Ctrl-]`: no common multiplexer binds `Ctrl-]`, and it is the key telnet and
/// `virsh console` already escape with.
const DEFAULT: [u8; 2] = [0x1d, 0x1d];

/// The most keys a sequence has: every key but the last is held back while it may be the start.
pub const DETACH_KEYS_MAX: usize = 8;

const ESCAPE: u8 = 0x1b;

/// The keys that, typed in a row, detach.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DetachKeys(Vec<u8>);

/// Text that names no sequence of keys to detach on; it says why, in the protocol's words.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotDetachKeys(String);

impl fmt::Display for NotDetachKeys {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for NotDetachKeys {}

impl Default for DetachKeys {
    fn default() -> Self {
        Self(DEFAULT.to_vec())
    }
}

impl DetachKeys {
    /// # Errors
    ///
    /// `NotDetachKeys`, saying why, when `text` names no key, a key that isn't one, more than
    /// `DETACH_KEYS_MAX`, or starts with Escape, which every arrow key starts with.
    pub fn parse(text: &str) -> Result<Self, NotDetachKeys> {
        let refuse = |why: String| Err(NotDetachKeys(why));
        if text.is_empty() {
            return refuse("name at least one key".to_owned());
        }
        let mut keys = Vec::new();
        for name in text.split(',') {
            if name.is_empty() {
                return refuse("a key between commas is missing".to_owned());
            }
            let Some(key) = key(name) else {
                return refuse(format!(
                    "\"{name}\" isn't a key: name ctrl- with a letter or one of @ [ \\ ] ^ _, or one \
                     printable character other than a comma"
                ));
            };
            keys.push(key);
        }
        if keys.len() > DETACH_KEYS_MAX {
            return refuse(format!("name at most {DETACH_KEYS_MAX} keys"));
        }
        if keys.first() == Some(&ESCAPE) {
            return refuse(
                "can't start with ctrl-[: that is Escape, which every arrow key starts with"
                    .to_owned(),
            );
        }
        Ok(Self(keys))
    }

    /// The bytes the keys send, in order.
    #[must_use]
    pub fn bytes(&self) -> &[u8] {
        &self.0
    }
}

/// The byte the key `name` sends.
fn key(name: &str) -> Option<u8> {
    let ctrl = name.get(..5).filter(|p| p.eq_ignore_ascii_case("ctrl-"));
    match (ctrl, name.as_bytes()) {
        (Some(_), [_, _, _, _, _, c]) => match c.to_ascii_lowercase() {
            c @ b'a'..=b'z' => Some(c - b'a' + 1),
            c @ (b'@' | b'[' | b'\\' | b']' | b'^' | b'_') => Some(c - b'@'),
            _ => None,
        },
        (_, &[c]) if c.is_ascii_graphic() && c != b',' => Some(c),
        _ => None,
    }
}

/// The keys as a person reads them: `Ctrl-] Ctrl-]`.
impl fmt::Display for DetachKeys {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        for (i, &key) in self.0.iter().enumerate() {
            if i > 0 {
                f.write_str(" ")?;
            }
            if key < 0x20 {
                write!(f, "Ctrl-{}", char::from(key + b'@'))?;
            } else {
                write!(f, "{}", char::from(key))?;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_is_ctrl_close_bracket_twice() {
        assert_eq!(
            (
                DetachKeys::default().to_string(),
                DetachKeys::parse("ctrl-],ctrl-]")
            ),
            ("Ctrl-] Ctrl-]".to_owned(), Ok(DetachKeys::default()))
        );
    }
}
