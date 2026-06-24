//! Noise IK end-to-end crypto for the tunnel (#1300). The desktop is the **responder** and
//! holds a static keypair; the mobile is the **initiator** and learns the desktop static public
//! key out-of-band (the QR) — mutual auth + forward secrecy + MITM resistance vs a malicious relay.

use snow::{Builder, HandshakeState, Keypair};

/// Noise pattern: IK (initiator knows responder's static key up front),
/// X25519 DH, ChaChaPoly AEAD, BLAKE2s hash.
pub const PARAMS: &str = "Noise_IK_25519_ChaChaPoly_BLAKE2s";

/// Generate a fresh static keypair (the desktop's long-lived identity).
pub fn generate_keypair() -> Result<Keypair, snow::Error> {
    Builder::new(PARAMS.parse().expect("valid noise params")).generate_keypair()
}

/// Build the responder handshake (desktop side) from its static private key. It
/// does NOT pre-know the initiator's static key — IK reveals it during the handshake.
#[allow(dead_code)] // wired into the relay transport in #242b
pub fn responder(static_priv: &[u8]) -> Result<HandshakeState, snow::Error> {
    Builder::new(PARAMS.parse().expect("valid noise params"))
        .local_private_key(static_priv)?
        .build_responder()
}

/// Build the initiator handshake (mobile side) from its static private key plus the
/// responder's static public key (learned from the QR). Used by the mobile client
/// and the crypto tests here.
#[allow(dead_code)] // mirrors the mobile initiator; exercised by tests + #242b
pub fn initiator(static_priv: &[u8], remote_pub: &[u8]) -> Result<HandshakeState, snow::Error> {
    Builder::new(PARAMS.parse().expect("valid noise params"))
        .local_private_key(static_priv)?
        .remote_public_key(remote_pub)?
        .build_initiator()
}
