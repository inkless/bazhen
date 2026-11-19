//! An address range, as `web.lan_allow` lists one (`apps/daemon/src/config/cidr.ts`): IPv4 or
//! IPv6, held as a number and a length. A link-local range is on one interface, its zone: the same
//! addresses exist on every link.

/// A range `web.lan_allow` admits.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cidr {
    pub v6: bool,
    /// The network: the address with every bit past `bits` cleared.
    pub base: u128,
    pub bits: u8,
    /// The interface a link-local range is on; none for any other.
    pub zone: Option<String>,
}

/// An IPv4 address in dotted decimal, each part without a leading zero.
fn ipv4(text: &str) -> Option<u128> {
    let parts: Vec<&str> = text.split('.').collect();
    if parts.len() != 4 {
        return None;
    }
    parts.iter().try_fold(0u128, |value, part| {
        let canonical = (1..=3).contains(&part.len())
            && part.bytes().all(|b| b.is_ascii_digit())
            && (*part == "0" || !part.starts_with('0'));
        let byte = part.parse::<u8>().ok().filter(|_| canonical)?;
        Some((value << 8) | u128::from(byte))
    })
}

/// The 16-bit groups of one side of an IPv6 address's `::`. A trailing IPv4 part counts as two,
/// and only where it ends the whole address.
fn groups(half: &str, ends_address: bool) -> Option<Vec<u128>> {
    if half.is_empty() {
        return Some(Vec::new());
    }
    let parts: Vec<&str> = half.split(':').collect();
    let mut out = Vec::new();
    for (i, part) in parts.iter().enumerate() {
        if ends_address && i + 1 == parts.len() && part.contains('.') {
            let v4 = ipv4(part)?;
            out.extend([v4 >> 16, v4 & 0xffff]);
        } else if (1..=4).contains(&part.len()) && part.bytes().all(|b| b.is_ascii_hexdigit()) {
            out.push(u128::from_str_radix(part, 16).ok()?);
        } else {
            return None;
        }
    }
    Some(out)
}

fn ipv6(text: &str) -> Option<u128> {
    let halves: Vec<&str> = text.split("::").collect();
    let (head, tail) = match halves.as_slice() {
        [whole] => (groups(whole, true)?, None),
        [first, second] => (groups(first, false)?, Some(groups(second, true)?)),
        _ => return None,
    };
    let given = head.len() + tail.as_ref().map_or(0, Vec::len);
    let zeros = match tail {
        None if given == 8 => 0,
        Some(_) if given < 8 => 8 - given,
        _ => return None,
    };
    let all = head
        .into_iter()
        .chain(std::iter::repeat_n(0, zeros))
        .chain(tail.unwrap_or_default());
    Some(all.fold(0, |value, group| (value << 16) | group))
}

/// The bits a range of `bits` keeps of an address.
fn mask(v6: bool, bits: u8) -> u128 {
    let width: u32 = if v6 { 128 } else { 32 };
    let ones = |n: u32| {
        u128::MAX
            .checked_shr(128 - n)
            .filter(|_| n > 0)
            .unwrap_or(0)
    };
    ones(width) ^ ones(width.saturating_sub(u32::from(bits)))
}

const LINK_LOCAL_BASE: u128 = 0xfe80 << 112;
const LINK_LOCAL_BITS: u8 = 10;

fn is_link_local(v6: bool, value: u128) -> bool {
    v6 && value & mask(true, LINK_LOCAL_BITS) == LINK_LOCAL_BASE
}

fn is_mapped(v6: bool, value: u128) -> bool {
    v6 && value >> 32 == 0xffff
}

/// The address, length and zone of `address/bits[%zone]`, each as the text spells it.
fn split(text: &str) -> Option<(&str, &str, Option<&str>)> {
    let (address, rest) = text.split_once('/')?;
    let (bits, zone) = match rest.split_once('%') {
        Some((bits, zone)) => (bits, Some(zone)),
        None => (rest, None),
    };
    let bits_ok = bits == "0"
        || ((1..=3).contains(&bits.len())
            && bits.bytes().all(|b| b.is_ascii_digit())
            && !bits.starts_with('0'));
    let zone_ok = zone.is_none_or(|zone| {
        !zone.is_empty()
            && zone
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
    });
    (!address.is_empty() && !address.contains('%') && bits_ok && zone_ok)
        .then_some((address, bits, zone))
}

/// A range like `192.168.1.0/24`, `fdeb:9f4b:2183:4c5b::/64` or `fe80::/10%eno1`.
///
/// # Errors
///
/// Why it can't be one `web.lan_allow` admits, in the words of `parseRange`, to follow the text.
pub fn parse_range(text: &str) -> Result<Cidr, &'static str> {
    let parsed = split(text).and_then(|(address, bits, zone)| {
        let v6 = address.contains(':');
        let value = if v6 { ipv6(address) } else { ipv4(address) }?;
        Some((v6, value, bits.parse::<u16>().ok()?, zone))
    });
    let Some((v6, value, bits, zone)) = parsed else {
        return Err("is not a range, such as 192.168.1.0/24");
    };
    let Some(bits) = u8::try_from(bits)
        .ok()
        .filter(|&b| b <= if v6 { 128 } else { 32 })
    else {
        return Err("is longer than an address");
    };
    if bits == 0 {
        return Err("admits every address; list your own network's range");
    }
    let base = value & mask(v6, bits);
    if is_mapped(v6, base) && bits >= 96 {
        return Err("is IPv4 written as IPv6, which no peer is compared as; list the IPv4 range");
    }
    if v6 && bits < LINK_LOCAL_BITS && LINK_LOCAL_BASE & mask(true, bits) == base {
        return Err("covers link-local addresses on every interface");
    }
    let range = |zone: Option<&str>| Cidr {
        v6,
        base,
        bits,
        zone: zone.map(str::to_owned),
    };
    if is_link_local(v6, base) {
        return match zone {
            None => Err("is link-local, so it needs its interface, such as fe80::/10%eno1"),
            // A peer's zone is reported by interface name, so a numeric zone would never match one.
            Some(zone) if zone.bytes().all(|b| b.is_ascii_digit()) => {
                Err("names its interface by number; use its name, such as eno1")
            }
            Some(zone) => Ok(range(Some(zone))),
        };
    }
    if zone.is_some() {
        return Err("names an interface, which only link-local takes");
    }
    Ok(range(None))
}

#[cfg(test)]
mod tests {
    use super::{Cidr, parse_range};

    #[test]
    fn keeps_a_ranges_network_its_length_and_a_link_local_zone() {
        assert_eq!(
            parse_range("192.168.1.7/24"),
            Ok(Cidr {
                v6: false,
                base: 0xc0a8_0100,
                bits: 24,
                zone: None
            })
        );
        assert_eq!(
            parse_range("fdeb:9f4b::1/32"),
            Ok(Cidr {
                v6: true,
                base: 0xfdeb_9f4b << 96,
                bits: 32,
                zone: None
            })
        );
        assert_eq!(
            parse_range("::1.2.3.4/128"),
            Ok(Cidr {
                v6: true,
                base: 0x0102_0304,
                bits: 128,
                zone: None
            })
        );
        assert_eq!(
            parse_range("fe80::1/64%eno1"),
            Ok(Cidr {
                v6: true,
                base: 0xfe80 << 112,
                bits: 64,
                zone: Some("eno1".to_owned())
            })
        );
    }
}
