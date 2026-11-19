//! Who may reach the daemon over HTTP: the Host and Origin allowlists (`http/guard.ts`), and when
//! a request must come from a paired device (`auth/devices.ts`'s `mustPair`, over
//! `auth/forwarded.ts`). Pure: the HTTP layers apply them.

use bazhen_protocol::text::{is_js_space, trim};

/// The daemon's own loopback name; it never listens anywhere else.
pub(crate) const LOOPBACK: &str = "127.0.0.1";

/// What a request may name as its Host, and the origins a browser may act from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Allowlists {
    /// Host header values accepted; anything else is refused as a DNS-rebinding defence.
    pub(crate) hosts: Vec<String>,
    pub(crate) origins: Vec<String>,
}

fn loopback(port: &str) -> [String; 2] {
    [format!("{LOOPBACK}:{port}"), format!("localhost:{port}")]
}

/// Who may reach the daemon: its own loopback address; the web dev server's pages, which keep
/// their origin through its proxy, when the dev scripts name its port; and each external origin
/// the user configured, as a host and as an origin.
pub(crate) fn allowlists(port: u16, web_port: Option<&str>, external: &[String]) -> Allowlists {
    let own = loopback(&port.to_string());
    let web = web_port.map_or_else(Vec::new, |p| loopback(p).to_vec());
    // An external origin is canonical (the config checks it), so its host is what follows the
    // scheme, its port included where it isn't the scheme's own.
    let external_hosts = external.iter().map(|origin| {
        origin
            .split_once("://")
            .map_or(origin.as_str(), |(_, host)| host)
            .to_owned()
    });
    Allowlists {
        hosts: own.iter().cloned().chain(external_hosts).collect(),
        origins: own
            .iter()
            .chain(web.iter())
            .map(|host| format!("http://{host}"))
            .chain(external.iter().cloned())
            .collect(),
    }
}

/// A request as the guard sees it.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Arrival<'a> {
    pub(crate) host: Option<&'a str>,
    pub(crate) origin: Option<&'a str>,
    /// It changes state or opens a socket, rather than only reading.
    pub(crate) acting: bool,
}

/// Why the guard refused a request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Refusal {
    HostNotAllowed,
    OriginNotAllowed,
}

/// Why a request is refused, or `None` to admit it. A browser always sends Origin when it acts,
/// so a page elsewhere can't act through the user's browser; a request without one comes from a
/// local process, which the Host check and pairing govern.
pub(crate) fn refusal(allow: &Allowlists, arrival: Arrival<'_>) -> Option<Refusal> {
    let host = arrival.host.unwrap_or_default();
    if !allow.hosts.iter().any(|h| h == host) {
        return Some(Refusal::HostNotAllowed);
    }
    match arrival.origin {
        Some(origin) if arrival.acting && !allow.origins.iter().any(|o| o == origin) => {
            Some(Refusal::OriginNotAllowed)
        }
        _ => None,
    }
}

/// Whether a request must come from a paired device: always, under the configured mode, or when
/// a proxy says it came from another machine, whatever the mode.
pub(crate) fn must_pair(
    always: bool,
    x_forwarded_for: Option<&str>,
    forwarded: Option<&str>,
) -> bool {
    always || forwarded_from_elsewhere(x_forwarded_for, forwarded)
}

/// Whether a proxy says the request came from another machine: any address in its
/// `X-Forwarded-For` or `Forwarded` chain that isn't loopback. A local process can forge the
/// chain, but it is on loopback already; it can't erase a hop a proxy added.
pub(crate) fn forwarded_from_elsewhere(
    x_forwarded_for: Option<&str>,
    forwarded: Option<&str>,
) -> bool {
    let from_xff = x_forwarded_for.unwrap_or_default().split(',');
    let from_forwarded = forwarded_for(forwarded.unwrap_or_default());
    from_xff
        .chain(from_forwarded)
        .map(bare_address)
        .any(|address| !address.is_empty() && !is_loopback(&address))
}

/// Each `for=` value in a `Forwarded` header, as `/for=("[^"]*"|[^;,\s]*)/gi` finds them: a
/// quoted string whole, or what runs up to the next `;`, `,` or white space as JavaScript's `\s`
/// takes it, which isn't U+0085.
fn forwarded_for(header: &str) -> impl Iterator<Item = &str> {
    let lower = header.to_ascii_lowercase();
    let mut values = Vec::new();
    let mut from = 0;
    while let Some(at) = lower.get(from..).and_then(|rest| rest.find("for=")) {
        let start = from + at + "for=".len();
        let rest = header.get(start..).unwrap_or_default();
        let quoted = rest
            .strip_prefix('"')
            .and_then(|inner| inner.find('"'))
            .map(|close| close + 2);
        let len = quoted.unwrap_or_else(|| {
            rest.find(|c: char| c == ';' || c == ',' || is_js_space(c))
                .unwrap_or(rest.len())
        });
        values.push(rest.get(..len).unwrap_or_default());
        from = start + len;
    }
    values.into_iter()
}

/// An address without the white space JavaScript's `trim` takes off, and the quotes, brackets and
/// port a header may wrap it in.
fn bare_address(raw: &str) -> String {
    let trimmed = trim(raw);
    let unquoted = trimmed.strip_prefix('"').unwrap_or(trimmed);
    let unquoted = unquoted.strip_suffix('"').unwrap_or(unquoted);
    if let Some(inner) = bracketed(unquoted) {
        return inner.to_ascii_lowercase();
    }
    v4_without_port(unquoted)
        .unwrap_or(unquoted)
        .to_ascii_lowercase()
}

/// `[address]` or `[address]:port`: the address.
fn bracketed(text: &str) -> Option<&str> {
    let (inner, after) = text.strip_prefix('[')?.split_once(']')?;
    let port_ok = after.is_empty()
        || after
            .strip_prefix(':')
            .is_some_and(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()));
    (!inner.is_empty() && port_ok).then_some(inner)
}

/// `a.b.c.d:port`, each part digits: the address.
fn v4_without_port(text: &str) -> Option<&str> {
    let (address, port) = text.rsplit_once(':')?;
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    (digits(port) && is_dotted_digits(address)).then_some(address)
}

/// Four dot-separated runs of digits, of any length, as `\d+\.\d+\.\d+\.\d+` matches.
fn is_dotted_digits(text: &str) -> bool {
    let parts: Vec<&str> = text.split('.').collect();
    parts.len() == 4
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
}

fn is_loopback(address: &str) -> bool {
    if address == "::1" || address == "localhost" {
        return true;
    }
    let v4 = address.strip_prefix("::ffff:").unwrap_or(address);
    v4.strip_prefix("127.").is_some() && is_dotted_digits(v4)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn allow() -> Allowlists {
        Allowlists {
            hosts: vec!["127.0.0.1:7900".into()],
            origins: vec!["http://127.0.0.1:7900".into()],
        }
    }

    const HOST: Option<&str> = Some("127.0.0.1:7900");

    fn arrival<'a>(host: Option<&'a str>, origin: Option<&'a str>, acting: bool) -> Arrival<'a> {
        Arrival {
            host,
            origin,
            acting,
        }
    }

    #[test]
    fn admits_a_read_from_any_page_and_an_action_from_the_daemons_own_origin() {
        assert_eq!(
            [
                refusal(&allow(), arrival(HOST, Some("https://evil.example"), false)),
                refusal(&allow(), arrival(HOST, Some("http://127.0.0.1:7900"), true)),
            ],
            [None, None]
        );
    }

    #[test]
    fn refuses_an_action_from_another_origin_and_any_request_to_another_host() {
        assert_eq!(
            [
                refusal(&allow(), arrival(HOST, Some("https://evil.example"), true)),
                refusal(&allow(), arrival(Some("evil.example"), None, false)),
                refusal(&allow(), arrival(None, None, false)),
            ],
            [
                Some(Refusal::OriginNotAllowed),
                Some(Refusal::HostNotAllowed),
                Some(Refusal::HostNotAllowed)
            ]
        );
    }

    #[test]
    fn admits_an_action_from_a_local_process_that_sends_no_origin() {
        assert_eq!(refusal(&allow(), arrival(HOST, None, true)), None);
    }

    #[test]
    fn admits_the_daemons_own_loopback_address_and_nothing_else_by_default() {
        assert_eq!(
            allowlists(7900, None, &[]),
            Allowlists {
                hosts: vec!["127.0.0.1:7900".into(), "localhost:7900".into()],
                origins: vec![
                    "http://127.0.0.1:7900".into(),
                    "http://localhost:7900".into()
                ],
            }
        );
    }

    #[test]
    fn lets_the_web_dev_servers_pages_act_through_its_proxy() {
        assert_eq!(
            allowlists(7900, Some("7901"), &[]).origins,
            [
                "http://127.0.0.1:7900",
                "http://localhost:7900",
                "http://127.0.0.1:7901",
                "http://localhost:7901"
            ]
        );
    }

    #[test]
    fn admits_an_external_origin_as_a_host_and_as_an_origin_exactly_as_configured() {
        let external = allowlists(
            7900,
            None,
            &[
                "https://bazhen.example.com".into(),
                "http://box.ts.net:8080".into(),
            ],
        );
        let host = Some("bazhen.example.com");
        assert_eq!(
            [
                refusal(
                    &external,
                    arrival(host, Some("https://bazhen.example.com"), true)
                ),
                refusal(
                    &external,
                    arrival(host, Some("http://bazhen.example.com"), true)
                ),
                refusal(&external, arrival(Some("other.example.com"), None, false)),
                refusal(&external, arrival(Some("box.ts.net:8080"), None, false)),
            ],
            [
                None,
                Some(Refusal::OriginNotAllowed),
                Some(Refusal::HostNotAllowed),
                None
            ]
        );
    }

    fn via(xff: Option<&str>, forwarded: Option<&str>) -> bool {
        forwarded_from_elsewhere(xff, forwarded)
    }

    #[test]
    fn not_forwarded_when_no_proxy_did_or_it_only_crossed_loopback() {
        assert_eq!(
            [
                via(None, None),
                via(Some("127.0.0.1"), None),
                via(Some("127.0.0.1, ::1"), None),
                via(None, Some("for=127.0.0.1")),
            ],
            [false; 4]
        );
    }

    #[test]
    fn forwarded_once_any_hop_names_another_machine_wherever_it_is_in_the_chain() {
        assert_eq!(
            [
                via(Some("192.168.1.30"), None),
                via(Some("192.168.1.30, 127.0.0.1"), None),
                via(Some("127.0.0.1, 2001:db8::5"), None),
                via(None, Some("for=\"[2001:db8::5]:4711\";proto=https")),
                via(None, Some("for=192.168.1.30:51000, for=127.0.0.1")),
                via(None, Some("For=10.0.0.1")),
            ],
            [true; 6]
        );
    }

    #[test]
    fn doesnt_take_a_mapped_or_bracketed_loopback_address_for_another_machine() {
        assert_eq!(
            [
                via(Some("::ffff:127.0.0.1"), None),
                via(None, Some("for=\"[::1]:80\"")),
                via(Some("127.0.0.1:8080"), None),
            ],
            [false; 3]
        );
    }

    #[test]
    fn takes_a_hop_it_cant_read_as_another_machine_since_only_a_proxy_writes_one() {
        assert!(via(None, Some("for=unknown")));
    }

    #[test]
    fn must_pair_when_configured_or_forwarded_from_elsewhere() {
        assert_eq!(
            [
                must_pair(true, None, None),
                must_pair(false, Some("192.168.1.30"), None),
                must_pair(false, Some("127.0.0.1"), None),
            ],
            [true, true, false]
        );
    }
}
