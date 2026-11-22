//! The one live pairing code, held as its hash, and the attempt windows that guard it
//! (`auth/pairing.ts`). Nothing here is persisted: a restarted daemon has no code until
//! `bazhen devices pair` asks for one.

use std::collections::HashMap;
use std::io::Read as _;

/// How long a code works.
pub(crate) const CODE_LIFETIME_MS: i64 = 5 * 60 * 1000;
pub(crate) const ATTEMPTS_PER_ORIGIN: u32 = 5;
/// Origin is the client's to choose, so the window across all of them is bounded too.
pub(crate) const ATTEMPTS_OVERALL: u32 = 10;
/// Failures, from anywhere, that burn the live code; `bazhen devices pair` must then issue
/// another. Enough that a client faking an allowed Origin can't easily keep everyone from
/// pairing, still nothing against 40 bits.
pub(crate) const FAILURES_PER_CODE: u32 = 20;
const WINDOW_MS: i64 = 60 * 1000;
/// The code's letters: base32's, so each random byte's low five bits pick one without bias.
const ALPHABET: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const CODE_LENGTH: usize = 8;

/// What an attempt came to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Attempt {
    Paired,
    Failed,
    RateLimited { retry_after_seconds: i64 },
}

/// Where an attempt came from. Only loopback attempts reach this daemon, which serves no LAN
/// listener; the buckets stay apart so one can't spend or burn the other's.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum Bucket {
    Loopback,
}

impl Bucket {
    fn as_str(self) -> &'static str {
        match self {
            Self::Loopback => "loopback",
        }
    }
}

#[derive(Debug)]
struct LiveCode {
    /// The code's SHA-256, as hex.
    hash: String,
    expires_at: i64,
    failures: HashMap<Bucket, u32>,
}

#[derive(Debug, Clone, Copy, Default)]
struct Window {
    start: i64,
    count: u32,
}

#[derive(Debug, Default)]
struct Limits {
    overall: Window,
    per_key: HashMap<String, Window>,
}

/// The live code and its attempt windows. Times are milliseconds on a clock that only runs
/// forward, given by the caller, so stepping the wall clock stretches neither.
#[derive(Debug, Default)]
pub(crate) struct PairingCodes {
    live: Option<LiveCode>,
    limits: HashMap<Bucket, Limits>,
}

fn digest(code: &str) -> String {
    crate::devices::hash_token(code)
}

/// Equal in time whatever the text, for two hashes of one length: the comparison says nothing of
/// where they differ.
fn same(a: &str, b: &str) -> bool {
    a.len() == b.len()
        && a.bytes()
            .zip(b.bytes())
            .fold(0u8, |diff, (x, y)| diff | (x ^ y))
            == 0
}

/// What a person might type for a code: any case, with spaces or dashes between the groups. The
/// spaces are JavaScript's `\s`, which is Unicode's white space and the BOM.
pub(crate) fn normalize_code(typed: &str) -> String {
    typed
        .chars()
        .filter(|&c| c != '-' && !c.is_whitespace() && c != '\u{feff}')
        .flat_map(char::to_uppercase)
        .collect()
}

/// A fresh code, from `random`'s bytes.
fn code_from(random: [u8; CODE_LENGTH]) -> String {
    random
        .iter()
        .filter_map(|&b| ALPHABET.get(usize::from(b & 31)).copied().map(char::from))
        .collect()
}

pub(crate) fn random_bytes<const N: usize>() -> std::io::Result<[u8; N]> {
    let mut bytes = [0u8; N];
    std::fs::File::open("/dev/urandom")?.read_exact(&mut bytes)?;
    Ok(bytes)
}

impl PairingCodes {
    /// A new code, replacing any earlier one.
    pub(crate) fn issue(&mut self, now: i64) -> std::io::Result<String> {
        Ok(self.issue_from(now, random_bytes()?))
    }

    fn issue_from(&mut self, now: i64, random: [u8; CODE_LENGTH]) -> String {
        let code = code_from(random);
        self.live = Some(LiveCode {
            hash: digest(&code),
            expires_at: now + CODE_LIFETIME_MS,
            failures: HashMap::new(),
        });
        code
    }

    /// Tries `typed` against the live code; a match uses it up. `key` is what attempts are
    /// limited by: the Origin on loopback.
    pub(crate) fn attempt(&mut self, typed: &str, key: &str, bucket: Bucket, now: i64) -> Attempt {
        if let Some(wait) = count(now, key, self.limits.entry(bucket).or_default()) {
            return Attempt::RateLimited {
                retry_after_seconds: wait,
            };
        }
        // Hashing both sides gives equal lengths, so the comparison's time says nothing of the
        // code.
        let typed = digest(&normalize_code(typed));
        let Some(live) = self.live.as_mut() else {
            return Attempt::Failed;
        };
        if now >= live.expires_at {
            self.live = None;
            return Attempt::Failed;
        }
        let failures = live.failures.entry(bucket).or_default();
        if *failures >= FAILURES_PER_CODE {
            return Attempt::Failed;
        }
        if same(&typed, &live.hash) {
            self.live = None;
            return Attempt::Paired;
        }
        *failures += 1;
        if *failures >= FAILURES_PER_CODE {
            tracing::info!(
                "pairing: the code was burned for {} after {FAILURES_PER_CODE} failed attempts",
                bucket.as_str()
            );
        }
        Attempt::Failed
    }

    /// How many attempt keys a bucket holds. A key is recorded only for an attempt the overall
    /// window allowed, so a client minting origins adds at most [`ATTEMPTS_OVERALL`] a minute,
    /// and they expire with their windows.
    #[cfg(test)]
    fn keys_held(&self, bucket: Bucket) -> usize {
        self.limits.get(&bucket).map_or(0, |l| l.per_key.len())
    }
}

/// Counts an attempt, or answers how many seconds until one is allowed again.
fn count(now: i64, key: &str, limits: &mut Limits) -> Option<i64> {
    limits.per_key.retain(|_, w| now - w.start < WINDOW_MS);
    if now - limits.overall.start >= WINDOW_MS {
        limits.overall = Window {
            start: now,
            count: 0,
        };
    }
    let mine = limits.per_key.get(key).copied().unwrap_or(Window {
        start: now,
        count: 0,
    });
    let mut wait = None::<i64>;
    if mine.count >= ATTEMPTS_PER_ORIGIN {
        wait = Some(mine.start + WINDOW_MS - now);
    }
    if limits.overall.count >= ATTEMPTS_OVERALL {
        let overall = limits.overall.start + WINDOW_MS - now;
        wait = Some(wait.map_or(overall, |w| w.max(overall)));
    }
    if let Some(wait) = wait {
        // Seconds rounded up, as `Math.ceil` does.
        return Some((wait + 999).div_euclid(1000));
    }
    limits.per_key.insert(
        key.to_owned(),
        Window {
            start: mine.start,
            count: mine.count + 1,
        },
    );
    limits.overall.count += 1;
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    const ORIGIN: &str = "http://127.0.0.1:7900";
    const T0: i64 = 1_800_000_000_000;

    fn issued() -> (PairingCodes, String) {
        let mut codes = PairingCodes::default();
        let code = codes.issue_from(T0, [0, 1, 2, 3, 28, 29, 30, 31]);
        (codes, code)
    }

    #[test]
    fn a_code_is_eight_letters_of_base32_read_from_each_bytes_low_bits() {
        assert_eq!(
            (
                code_from([0, 1, 2, 3, 28, 29, 30, 31]),
                code_from([32, 255, 64, 96, 0, 0, 0, 0])
            ),
            ("ABCD4567".to_owned(), "A7AAAAAA".to_owned())
        );
    }

    #[test]
    fn a_code_works_once_and_lives_five_minutes() {
        let (mut codes, code) = issued();
        let once = codes.attempt(&code, ORIGIN, Bucket::Loopback, T0);
        let twice = codes.attempt(&code, ORIGIN, Bucket::Loopback, T0 + 1);
        let late = {
            let mut codes = PairingCodes::default();
            let code = codes.issue_from(T0, [5; 8]);
            let at_end = codes.attempt(&code, "a", Bucket::Loopback, T0 + CODE_LIFETIME_MS);
            let just_before = {
                let mut codes = PairingCodes::default();
                let code = codes.issue_from(T0, [5; 8]);
                codes.attempt(&code, "a", Bucket::Loopback, T0 + CODE_LIFETIME_MS - 1)
            };
            (at_end, just_before)
        };
        assert_eq!(
            (once, twice, late),
            (
                Attempt::Paired,
                Attempt::Failed,
                (Attempt::Failed, Attempt::Paired)
            )
        );
    }

    #[test]
    fn a_code_is_read_in_any_case_with_spaces_or_dashes_between_its_groups() {
        let (mut codes, _) = issued();
        assert_eq!(
            (
                normalize_code(" abcd-45\u{a0}67\t"),
                codes.attempt("abcd-4567", ORIGIN, Bucket::Loopback, T0),
            ),
            ("ABCD4567".to_owned(), Attempt::Paired)
        );
    }

    #[test]
    fn a_new_code_replaces_the_old_one() {
        let (mut codes, old) = issued();
        let new = codes.issue_from(T0, [9; 8]);
        assert_eq!(
            (
                codes.attempt(&old, ORIGIN, Bucket::Loopback, T0),
                codes.attempt(&new, ORIGIN, Bucket::Loopback, T0)
            ),
            (Attempt::Failed, Attempt::Paired)
        );
    }

    #[test]
    fn no_code_issued_fails_every_attempt() {
        let mut codes = PairingCodes::default();
        assert_eq!(
            codes.attempt("AAAAAAAA", ORIGIN, Bucket::Loopback, T0),
            Attempt::Failed
        );
    }

    #[test]
    fn an_origin_gets_five_attempts_a_minute_and_is_told_when_to_try_again() {
        let (mut codes, code) = issued();
        let tries: Vec<_> = (0..5)
            .map(|i| codes.attempt("WRONGONE", ORIGIN, Bucket::Loopback, T0 + i))
            .collect();
        let sixth = codes.attempt(&code, ORIGIN, Bucket::Loopback, T0 + 10_500);
        let another = codes.attempt(
            &code,
            "http://localhost:7900",
            Bucket::Loopback,
            T0 + 10_500,
        );
        assert_eq!(
            (tries, sixth, another),
            (
                vec![Attempt::Failed; 5],
                Attempt::RateLimited {
                    retry_after_seconds: 50
                },
                Attempt::Paired
            )
        );
    }

    #[test]
    fn its_window_reopens_a_minute_after_its_first_attempt() {
        let (mut codes, code) = issued();
        for i in 0..5 {
            codes.attempt("WRONGONE", ORIGIN, Bucket::Loopback, T0 + i);
        }
        assert_eq!(
            (
                codes.attempt(&code, ORIGIN, Bucket::Loopback, T0 + WINDOW_MS - 1),
                codes.attempt(&code, ORIGIN, Bucket::Loopback, T0 + WINDOW_MS)
            ),
            (
                Attempt::RateLimited {
                    retry_after_seconds: 1
                },
                Attempt::Paired
            )
        );
    }

    #[test]
    fn ten_attempts_a_minute_across_every_origin_and_no_more_keys_than_that() {
        let (mut codes, code) = issued();
        for i in 0..10 {
            codes.attempt("WRONGONE", &format!("o{i}"), Bucket::Loopback, T0);
        }
        let eleventh = codes.attempt(&code, "fresh", Bucket::Loopback, T0 + 30_000);
        assert_eq!(
            (eleventh, codes.keys_held(Bucket::Loopback)),
            (
                Attempt::RateLimited {
                    retry_after_seconds: 30
                },
                10
            )
        );
    }

    /// `failures` wrong attempts, ten a minute from fresh origins so no window stops them, then
    /// the right code, all within the code's five minutes.
    fn after_failures(failures: u32) -> Attempt {
        let (mut codes, code) = issued();
        for i in 0..failures {
            let at = T0 + i64::from(i / ATTEMPTS_OVERALL) * WINDOW_MS;
            codes.attempt("WRONGONE", &format!("o{i}"), Bucket::Loopback, at);
        }
        codes.attempt(&code, ORIGIN, Bucket::Loopback, T0 + 2 * WINDOW_MS)
    }

    #[test]
    fn twenty_failures_burn_the_code_even_for_the_right_one() {
        assert_eq!(
            (
                after_failures(FAILURES_PER_CODE),
                after_failures(FAILURES_PER_CODE - 1)
            ),
            (Attempt::Failed, Attempt::Paired)
        );
    }

    #[test]
    fn hashes_compare_equal_only_when_every_byte_does() {
        let a = digest("A");
        let mut b = a.clone();
        b.replace_range(63.., if a.ends_with('0') { "1" } else { "0" });
        assert_eq!(
            (
                same(&a, &a),
                same(&a, &b),
                same(&a, a.get(1..).unwrap_or_default())
            ),
            (true, false, false)
        );
    }
}
