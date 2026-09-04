//! Group-key confidentiality, sensor-key authenticity.
//!
//! ## Why these are two different keys
//!
//! The stream is multicast so that every device the operator owns can
//! subscribe and share responsibility for reacting to intrusions. That goal
//! is what forces the split.
//!
//! A single shared key would give confidentiality *and* authenticity -- but
//! authenticity only *to the group*. Any subscriber holding it could
//! fabricate a sensor alert that every other subscriber accepts as genuine,
//! and that risk grows with each device added. Since the entire point is to
//! add many subscribers, a shared-key-only design gets less trustworthy
//! exactly as it succeeds.
//!
//! So: the GROUP KEY (symmetric, held by every subscriber) provides
//! confidentiality, and an ED25519 SIGNATURE by the sensor provides
//! authenticity. Subscribers hold only the public half. A compromised
//! subscriber can read the stream -- unavoidable, it is a subscriber -- but
//! can never forge into it.
//!
//! Noise N was considered and rejected: it is one-way, which fits, but it is
//! POINT-TO-POINT (the sender encrypts to one recipient's static key), so it
//! cannot serve N subscribers from a single emission.

use crate::envelope::{self, Envelope, Kind, BOOT_ID_LEN, NONCE_LEN, SIG_LEN};
use crate::error::WireError;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};

/// The symmetric key every subscriber holds. Confidentiality only.
#[derive(Clone)]
pub struct GroupKey([u8; 32]);

impl GroupKey {
    pub fn from_bytes(b: [u8; 32]) -> Self {
        Self(b)
    }
}

impl std::fmt::Debug for GroupKey {
    /// Never renders the key material: this type ends up in error paths and
    /// log lines, and a group key printed once is a group key rotated.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("GroupKey(<redacted>)")
    }
}

/// The sensor side: holds the private signing key. Only the sensor has this.
pub struct Sensor {
    signing: SigningKey,
    group: GroupKey,
    boot_id: [u8; BOOT_ID_LEN],
}

impl Sensor {
    pub fn new(signing: SigningKey, group: GroupKey, boot_id: [u8; BOOT_ID_LEN]) -> Self {
        Self { signing, group, boot_id }
    }

    pub fn verifying_key(&self) -> VerifyingKey {
        self.signing.verifying_key()
    }

    pub fn boot_id(&self) -> [u8; BOOT_ID_LEN] {
        self.boot_id
    }

    /// Build one datagram. Refuses rather than fragmenting.
    pub fn seal(
        &self,
        kind: Kind,
        seq: u64,
        nonce: [u8; NONCE_LEN],
        plaintext: &[u8],
    ) -> Result<Vec<u8>, WireError> {
        if plaintext.len() > envelope::MAX_PLAINTEXT_BYTES {
            return Err(WireError::PayloadTooLarge {
                got: plaintext.len(),
                max: envelope::MAX_PLAINTEXT_BYTES,
            });
        }

        let cipher = ChaCha20Poly1305::new(Key::from_slice(&self.group.0));
        // The header is authenticated as AEAD associated data as well as being
        // covered by the signature, so kind/boot_id/seq cannot be edited even
        // by someone who somehow produced a valid signature over other bytes.
        let aad = header_aad(kind, &self.boot_id, seq, &nonce);
        let ciphertext = cipher
            .encrypt(Nonce::from_slice(&nonce), Payload { msg: plaintext, aad: &aad })
            .map_err(|_| WireError::Undecryptable)?;

        let region = envelope::signed_region(kind, &self.boot_id, seq, &nonce, &ciphertext);
        let sig = self.signing.sign(&region);

        let mut out = region;
        out.extend_from_slice(&sig.to_bytes());
        debug_assert!(out.len() <= envelope::MAX_DATAGRAM_BYTES);
        Ok(out)
    }
}

/// The subscriber side: holds only the sensor's PUBLIC key and the group key.
#[derive(Clone)]
pub struct Subscriber {
    verifying: VerifyingKey,
    group: GroupKey,
}

impl Subscriber {
    pub fn new(verifying: VerifyingKey, group: GroupKey) -> Self {
        Self { verifying, group }
    }

    /// Verify, then decrypt. In that order, deliberately -- see [`envelope`].
    pub fn open(&self, datagram: &[u8]) -> Result<(Envelope, Vec<u8>), WireError> {
        let (region, sig_bytes) = envelope::split(datagram)?;

        let mut sig_arr = [0u8; SIG_LEN];
        sig_arr.copy_from_slice(sig_bytes);
        let sig = Signature::from_bytes(&sig_arr);
        self.verifying
            .verify(region, &sig)
            .map_err(|_| WireError::BadSignature)?;

        let env = envelope::parse_verified(region)?;

        let cipher = ChaCha20Poly1305::new(Key::from_slice(&self.group.0));
        let aad = header_aad(env.kind, &env.boot_id, env.seq, &env.nonce);
        let plaintext = cipher
            .decrypt(
                Nonce::from_slice(&env.nonce),
                Payload { msg: &env.ciphertext, aad: &aad },
            )
            .map_err(|_| WireError::Undecryptable)?;

        Ok((env, plaintext))
    }
}

fn header_aad(kind: Kind, boot_id: &[u8; BOOT_ID_LEN], seq: u64, nonce: &[u8; NONCE_LEN]) -> Vec<u8> {
    envelope::signed_region(kind, boot_id, seq, nonce, &[])
}
