//! A mandatory, non-zero expiry duration.

use std::fmt;
use std::time::Duration;

/// A time-to-live. Always non-zero: "forever" is not a valid `Ttl`, which is
/// what makes a non-expiring Tier 1 action unrepresentable -- there is no
/// `Ttl` value that means "does not expire". A caller wanting a very long
/// window still has to say how long.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, serde::Serialize, serde::Deserialize,
)]
pub struct Ttl(Duration);

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum TtlError {
    #[error("a Ttl must be non-zero: an expiry of zero is indistinguishable from never expiring")]
    Zero,
}

impl Ttl {
    pub fn new(duration: Duration) -> Result<Self, TtlError> {
        if duration.is_zero() {
            Err(TtlError::Zero)
        } else {
            Ok(Self(duration))
        }
    }

    pub fn from_secs(secs: u64) -> Result<Self, TtlError> {
        Self::new(Duration::from_secs(secs))
    }

    pub fn from_mins(mins: u64) -> Result<Self, TtlError> {
        Self::new(Duration::from_secs(mins.saturating_mul(60)))
    }

    pub fn duration(&self) -> Duration {
        self.0
    }
}

impl fmt::Display for Ttl {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:?}", self.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_is_rejected() {
        assert_eq!(Ttl::from_secs(0), Err(TtlError::Zero));
        assert_eq!(Ttl::new(Duration::ZERO), Err(TtlError::Zero));
    }

    #[test]
    fn nonzero_is_accepted() {
        assert!(Ttl::from_secs(1).is_ok());
        assert!(Ttl::from_mins(30).is_ok());
    }
}
