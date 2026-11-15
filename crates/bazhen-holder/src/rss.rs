//! How much memory the holder has resident, for `stats`: read where the OS says, and `None`
//! where it doesn't.

/// The holder's resident set in bytes, from `/proc/self/statm`; `None` where that can't be read.
pub fn resident_bytes() -> Option<u64> {
    let statm = std::fs::read("/proc/self/statm").ok()?;
    let page = u64::try_from(rustix::param::page_size()).ok()?;
    resident_pages(&statm)?.checked_mul(page)
}

/// Field 2 of `/proc/<pid>/statm`, the resident set in pages: `size resident shared …`.
pub fn resident_pages(statm: &[u8]) -> Option<u64> {
    let field = statm
        .split(u8::is_ascii_whitespace)
        .filter(|token| !token.is_empty())
        .nth(1)?;
    std::str::from_utf8(field).ok()?.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_resident_pages_and_nothing_from_a_file_that_says_nothing() {
        assert_eq!(resident_pages(b"6400 2048 512 30 0 900 0\n"), Some(2048));
        assert_eq!(resident_pages(b"6400\n"), None);
        assert_eq!(resident_pages(b"6400 -3 512"), None);
        assert_eq!(resident_pages(b""), None);
    }

    #[test]
    fn the_holders_own_is_its_resident_set_where_the_os_says() {
        if std::path::Path::new("/proc/self/statm").exists() {
            let bytes = resident_bytes().unwrap();
            assert!(bytes > 1 << 20, "{bytes} bytes resident");
        } else {
            assert_eq!(resident_bytes(), None);
        }
    }
}
