//! The datagram on the wire.
//!
//! ```text
//! | magic 4 | ver 1 | kind 1 | boot_id 16 | seq 8 | nonce 12 | ciphertext .. | sig 64 |
//! \___________________________ signed _______________________________________/
//! ```
//!
//! **Encrypt-then-sign, and verify-before-decrypt.** The signature covers the
//! header *and* the ciphertext, so a subscriber rejects a forged or corrupted
//! datagram without ever feeding attacker-chosen bytes to the AEAD. The
//! reverse order (sign the plaintext, then encrypt) would force every receiver
//! to decrypt before it could judge authenticity.

use crate::error::WireError;

/// `bLAN` — present so a stray datagram on the multicast group is rejected by
/// shape before any cryptography is attempted.
pub const MAGIC: [u8; 4] = *b"bLAN";

/// Wire version. A subscriber refuses a version it does not implement rather
/// than guessing at the layout.
pub const VERSION: u8 = 1;

pub const BOOT_ID_LEN: usize = 16;
pub const NONCE_LEN: usize = 12;
pub const SIG_LEN: usize = 64;
pub const TAG_LEN: usize = 16;

/// Bytes before the ciphertext: magic + version + kind + boot id + seq + nonce.
pub const HEADER_LEN: usize = 4 + 1 + 1 + BOOT_ID_LEN + 8 + NONCE_LEN;

/// The largest datagram this contract will emit, in bytes.
///
/// Deliberately well under the 1472-byte theoretical maximum for UDP over a
/// 1500-byte Ethernet MTU. The stream is MULTICAST and crosses a tagged VLAN
/// trunk, and an IP-fragmented multicast datagram is materially worse than a
/// small one: with no feedback channel a single lost fragment discards the
/// whole datagram, so fragmentation multiplies the loss rate instead of
/// merely adding overhead. 1232 is the same conservative budget QUIC uses to
/// stay under real-world path MTUs including tunnels and VLAN tags.
pub const MAX_DATAGRAM_BYTES: usize = 1232;

/// The largest plaintext that can still fit inside `MAX_DATAGRAM_BYTES`.
pub const MAX_PLAINTEXT_BYTES: usize = MAX_DATAGRAM_BYTES - HEADER_LEN - TAG_LEN - SIG_LEN;

// COMPILE-TIME, not a test: if these ever stop holding, the crate must fail to
// build rather than fail a test run someone might not have executed. A budget
// that went negative would wrap on subtraction and silently permit an
// oversized datagram, which is the exact failure the size refusal exists to
// prevent.
const _: () = {
    assert!(
        MAX_PLAINTEXT_BYTES + HEADER_LEN + TAG_LEN + SIG_LEN == MAX_DATAGRAM_BYTES,
        "the datagram budget no longer accounts for every fixed field"
    );
    assert!(
        MAX_PLAINTEXT_BYTES > 1000,
        "the plaintext budget collapsed -- a datagram can no longer carry a useful payload"
    );
    assert!(HEADER_LEN == 42, "the header layout changed without the documentation");
};

/// What a datagram carries.
///
/// The distinction is the whole recovery story: there is no feedback channel,
/// so a subscriber that misses a [`Kind::Delta`] cannot ask for it again. It
/// waits for the next [`Kind::Snapshot`], which restates the sensor's full
/// state and needs nothing from the receiver.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum Kind {
    /// An incremental event. Losing one leaves a gap until the next snapshot.
    Delta,
    /// A complete restatement of sensor state. Self-healing: a subscriber that
    /// missed every preceding delta is whole again after receiving one.
    Snapshot,
}

impl Kind {
    pub(crate) fn to_byte(self) -> u8 {
        match self {
            Kind::Delta => 0,
            Kind::Snapshot => 1,
        }
    }

    pub(crate) fn from_byte(b: u8) -> Result<Self, WireError> {
        match b {
            0 => Ok(Kind::Delta),
            1 => Ok(Kind::Snapshot),
            other => Err(WireError::UnknownKind(other)),
        }
    }
}

/// A parsed datagram, still encrypted. Produced by [`parse`] once the shape
/// and signature are known good; the payload is decrypted separately.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Envelope {
    pub kind: Kind,
    /// Identifies one continuous run of the sensor. A change means the sensor
    /// RESTARTED -- which is why a reboot is never mistaken for a sequence gap.
    pub boot_id: [u8; BOOT_ID_LEN],
    /// Monotonic within a boot id, starting at 0.
    pub seq: u64,
    pub nonce: [u8; NONCE_LEN],
    pub ciphertext: Vec<u8>,
}

/// Serialise the signed region: everything except the trailing signature.
pub(crate) fn signed_region(
    kind: Kind,
    boot_id: &[u8; BOOT_ID_LEN],
    seq: u64,
    nonce: &[u8; NONCE_LEN],
    ciphertext: &[u8],
) -> Vec<u8> {
    let mut out = Vec::with_capacity(HEADER_LEN + ciphertext.len());
    out.extend_from_slice(&MAGIC);
    out.push(VERSION);
    out.push(kind.to_byte());
    out.extend_from_slice(boot_id);
    out.extend_from_slice(&seq.to_be_bytes());
    out.extend_from_slice(nonce);
    out.extend_from_slice(ciphertext);
    out
}

/// Split a datagram into its signed region and its signature, checking shape
/// only. No cryptography happens here.
pub(crate) fn split(datagram: &[u8]) -> Result<(&[u8], &[u8]), WireError> {
    if datagram.len() > MAX_DATAGRAM_BYTES {
        return Err(WireError::TooLarge {
            got: datagram.len(),
            max: MAX_DATAGRAM_BYTES,
        });
    }
    // A datagram must hold a header, a non-empty AEAD output (at minimum the
    // tag) and a signature. Anything shorter is truncated by definition.
    let minimum = HEADER_LEN + TAG_LEN + SIG_LEN;
    if datagram.len() < minimum {
        return Err(WireError::Truncated {
            got: datagram.len(),
            need: minimum,
        });
    }
    if datagram[0..4] != MAGIC {
        return Err(WireError::BadMagic);
    }
    if datagram[4] != VERSION {
        return Err(WireError::UnsupportedVersion(datagram[4]));
    }
    Ok(datagram.split_at(datagram.len() - SIG_LEN))
}

/// Parse the already-signature-verified region into an [`Envelope`].
pub(crate) fn parse_verified(region: &[u8]) -> Result<Envelope, WireError> {
    let kind = Kind::from_byte(region[5])?;
    let mut boot_id = [0u8; BOOT_ID_LEN];
    boot_id.copy_from_slice(&region[6..6 + BOOT_ID_LEN]);

    let seq_at = 6 + BOOT_ID_LEN;
    let mut seq_bytes = [0u8; 8];
    seq_bytes.copy_from_slice(&region[seq_at..seq_at + 8]);

    let nonce_at = seq_at + 8;
    let mut nonce = [0u8; NONCE_LEN];
    nonce.copy_from_slice(&region[nonce_at..nonce_at + NONCE_LEN]);

    Ok(Envelope {
        kind,
        boot_id,
        seq: u64::from_be_bytes(seq_bytes),
        nonce,
        ciphertext: region[HEADER_LEN..].to_vec(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kind_round_trips_through_its_byte() {
        for k in [Kind::Delta, Kind::Snapshot] {
            assert_eq!(Kind::from_byte(k.to_byte()).unwrap(), k);
        }
        assert!(matches!(Kind::from_byte(2), Err(WireError::UnknownKind(2))));
    }

    #[test]
    fn a_short_or_empty_datagram_is_truncated_not_panicking() {
        for len in [0usize, 1, HEADER_LEN, HEADER_LEN + TAG_LEN + SIG_LEN - 1] {
            let d = vec![0u8; len];
            assert!(matches!(
                split(&d),
                Err(WireError::Truncated { .. }) | Err(WireError::BadMagic)
            ));
        }
    }

    #[test]
    fn an_oversized_datagram_is_refused_before_anything_else() {
        let d = vec![0u8; MAX_DATAGRAM_BYTES + 1];
        assert!(matches!(split(&d), Err(WireError::TooLarge { .. })));
    }
}
