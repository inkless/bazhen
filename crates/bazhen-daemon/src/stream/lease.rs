//! Input authority over one terminal, as `packages/core/src/lease.ts` keeps it: which view drives,
//! and the epoch its input is typed under. The epoch survives a release, so every grant gets a
//! higher epoch than any before it on that terminal.

use bazhen_protocol::ids::AttachmentId;
use bazhen_protocol::stream::AttachmentMode;

/// The number a lease is granted under. A view's input carries the epoch it was typed under, so
/// a key typed before the view heard of a takeover is told apart from one typed after.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default)]
pub(crate) struct Epoch(u64);

impl Epoch {
    #[must_use]
    pub(crate) const fn new(epoch: u64) -> Self {
        Self(epoch)
    }

    #[must_use]
    pub(crate) const fn get(self) -> u64 {
        self.0
    }
}

/// Who drives a terminal, if anyone, and the epoch of its last grant.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(crate) struct Lease {
    holder: Option<AttachmentId>,
    epoch: Epoch,
}

impl Lease {
    /// No holder, at `epoch`: a terminal's lease as its last grant left it.
    #[must_use]
    pub(crate) const fn released_at(epoch: Epoch) -> Self {
        Self {
            holder: None,
            epoch,
        }
    }

    #[must_use]
    pub(crate) const fn holder(&self) -> Option<&AttachmentId> {
        self.holder.as_ref()
    }

    #[must_use]
    pub(crate) const fn epoch(&self) -> Epoch {
        self.epoch
    }

    /// An engaged interactive view takes the lease at once; an observer never holds it, and the
    /// driver engaging again keeps the epoch it has.
    #[must_use]
    pub(crate) fn engage(&self, by: &AttachmentId, mode: AttachmentMode) -> Self {
        if mode == AttachmentMode::Observe || self.holder.as_ref() == Some(by) {
            return self.clone();
        }
        Self {
            holder: Some(by.clone()),
            epoch: Epoch(self.epoch.0.saturating_add(1)),
        }
    }

    /// The lease ends with its attachment; there is no time-based expiry.
    #[must_use]
    pub(crate) fn release(&self, attachment: &AttachmentId) -> Self {
        if self.holder.as_ref() == Some(attachment) {
            Self::released_at(self.epoch)
        } else {
            self.clone()
        }
    }

    /// Input is applied only from the driver, at the epoch it was granted; anything else is
    /// dropped.
    #[must_use]
    pub(crate) fn accepts_input(&self, from: &AttachmentId, epoch: Epoch) -> bool {
        self.holder.as_ref() == Some(from) && self.epoch == epoch
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn laptop() -> AttachmentId {
        AttachmentId::mint(1, [1; 16])
    }

    fn phone() -> AttachmentId {
        AttachmentId::mint(1, [2; 16])
    }

    #[test]
    fn moves_to_the_view_the_user_engages_and_raises_the_epoch() {
        let driving = Lease::default().engage(&laptop(), AttachmentMode::Interactive);
        let taken = driving.engage(&phone(), AttachmentMode::Interactive);
        assert_eq!(
            (taken.holder(), taken.epoch()),
            (Some(&phone()), Epoch::new(driving.epoch().get() + 1))
        );
    }

    #[test]
    fn never_goes_to_an_observer() {
        assert_eq!(
            Lease::default().engage(&phone(), AttachmentMode::Observe),
            Lease::default()
        );
    }

    #[test]
    fn keeps_the_epoch_when_the_driver_engages_again() {
        let driving = Lease::default().engage(&laptop(), AttachmentMode::Interactive);
        assert_eq!(
            driving.engage(&laptop(), AttachmentMode::Interactive),
            driving
        );
    }

    #[test]
    fn drops_input_from_a_former_driver_even_at_the_epoch_it_once_held() {
        let first = Lease::default().engage(&laptop(), AttachmentMode::Interactive);
        let taken = first.engage(&phone(), AttachmentMode::Interactive);
        assert_eq!(
            (
                taken.accepts_input(&laptop(), first.epoch()),
                taken.accepts_input(&phone(), taken.epoch())
            ),
            (false, true)
        );
    }

    #[test]
    fn drops_input_sent_under_an_older_epoch_by_the_same_view() {
        let first = Lease::default().engage(&laptop(), AttachmentMode::Interactive);
        let regained = first
            .release(&laptop())
            .engage(&laptop(), AttachmentMode::Interactive);
        assert!(!regained.accepts_input(&laptop(), first.epoch()));
    }

    #[test]
    fn is_released_only_by_its_own_holder() {
        let driving = Lease::default().engage(&laptop(), AttachmentMode::Interactive);
        assert_eq!(driving.release(&phone()), driving);
        assert_eq!(
            driving.release(&laptop()),
            Lease::released_at(driving.epoch())
        );
    }
}
