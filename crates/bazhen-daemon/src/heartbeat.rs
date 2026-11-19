//! Whether a WebSocket peer is still there, judged once a beat, so a phone that slept or lost its
//! network gives up its connection instead of holding it until TCP times it out.

use std::time::Duration;

/// How often a route pings its peers, and how many beats one with output queued may leave
/// unanswered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Heartbeat {
    pub(crate) every: Duration,
    pub(crate) patience: u32,
}

/// Every 15 s; two minutes for a phone on a slow link working through a burst of output.
pub(crate) const HEARTBEAT: Heartbeat = Heartbeat {
    every: Duration::from_secs(15),
    patience: 8,
};

impl Heartbeat {
    /// How long a close may take to go out: one beat past the longest the heartbeat keeps a peer,
    /// so the heartbeat ends a silent peer, closing or not.
    pub(crate) fn close_within(self) -> Duration {
        self.every.saturating_mul(self.patience.saturating_add(2))
    }
}

/// What a beat finds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Beat {
    Ping,
    Gone,
}

/// A peer that answered neither the last ping nor sent anything since is gone, unless output was
/// queued for it since: a ping then waits behind that output, so it gets `patience` beats. That
/// holds after the queue empties too, since the last of it and the ping are still on their way.
#[derive(Debug)]
pub(crate) struct Pulse {
    unanswered: u32,
    draining: bool,
    patience: u32,
}

impl Pulse {
    pub(crate) fn new(patience: u32) -> Self {
        Self {
            unanswered: 0,
            draining: false,
            patience,
        }
    }

    /// The peer answered a ping, or sent a frame.
    pub(crate) fn heard(&mut self) {
        self.unanswered = 0;
        self.draining = false;
    }

    /// A beat, with `unsent` frames still queued for the peer.
    pub(crate) fn beat(&mut self, unsent: usize) -> Beat {
        self.draining |= unsent > 0;
        if self.unanswered >= (if self.draining { self.patience } else { 1 }) {
            return Beat::Gone;
        }
        self.unanswered += 1;
        Beat::Ping
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn beats(pulse: &mut Pulse, unsent: &[usize]) -> Vec<Beat> {
        unsent.iter().map(|&n| pulse.beat(n)).collect()
    }

    #[test]
    fn calls_a_peer_gone_once_a_ping_goes_unanswered_with_nothing_queued_for_it() {
        assert_eq!(beats(&mut Pulse::new(3), &[0, 0]), [Beat::Ping, Beat::Gone]);
    }

    #[test]
    fn keeps_a_peer_that_answers_each_ping() {
        let mut pulse = Pulse::new(3);
        for _ in 0..5 {
            assert_eq!(pulse.beat(0), Beat::Ping);
            pulse.heard();
        }
    }

    #[test]
    fn waits_its_patience_out_for_a_peer_with_output_still_queued_and_no_longer() {
        assert_eq!(
            beats(&mut Pulse::new(3), &[1, 1, 1, 1]),
            [Beat::Ping, Beat::Ping, Beat::Ping, Beat::Gone]
        );
    }

    #[test]
    fn stays_patient_once_the_queue_empties_while_the_last_of_it_is_on_its_way() {
        assert_eq!(
            beats(&mut Pulse::new(3), &[1, 0, 0, 0]),
            [Beat::Ping, Beat::Ping, Beat::Ping, Beat::Gone]
        );
    }

    #[test]
    fn is_impatient_again_once_the_peer_answers() {
        let mut pulse = Pulse::new(3);
        assert_eq!(beats(&mut pulse, &[1, 0]), [Beat::Ping, Beat::Ping]);
        pulse.heard();
        assert_eq!(beats(&mut pulse, &[0, 0]), [Beat::Ping, Beat::Gone]);
    }

    #[test]
    fn closes_within_a_beat_past_its_patience() {
        assert_eq!(HEARTBEAT.close_within(), Duration::from_secs(150));
    }
}
