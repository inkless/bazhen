//! The ids a connection gives its requests, as `request-ids.ts` makes them.

/// The id after `previous`: a u32, wrapping past its maximum, and none `taken` still waits on.
pub(crate) fn next_request_id(previous: u32, taken: impl Fn(u32) -> bool) -> u32 {
    let mut id = previous;
    loop {
        id = id.wrapping_add(1);
        if !taken(id) {
            return id;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn none(_: u32) -> bool {
        false
    }

    #[test]
    fn counts_up_from_the_id_before_it() {
        assert_eq!(next_request_id(41, none), 42);
    }

    #[test]
    fn wraps_past_the_largest_u32_to_0() {
        assert_eq!(next_request_id(u32::MAX, none), 0);
    }

    #[test]
    fn skips_ids_still_waiting_for_an_answer_across_the_wrap() {
        let waiting = [u32::MAX, 0, 1];
        assert_eq!(next_request_id(u32::MAX - 1, |id| waiting.contains(&id)), 2);
    }
}
