//! The ear's DURABLE tunnel identity — the thing that lets a phone stay paired.
//!
//! # Why the app's identity is not good enough here
//!
//! The desktop app mints a fresh Noise identity at every launch: `TunnelState::new` calls
//! `noise::generate_keypair()`, and `tunnel_start` mints a new room id and psk on every dial. The
//! phone stores its pairing in `expo-secure-store` and PINS `hostPubKey` as the Noise IK remote
//! static key, so restarting the desktop invalidates an existing pairing.
//!
//! That is tolerable for the app, where pairing is an explicit act performed at the machine. It is
//! NOT tolerable for the ear, whose entire job is to be always listening — re-scanning a QR after
//! every reboot or `bsc ear stop` / `start` would make the pairing useless. So the ear generates its
//! identity ONCE and loads it from storage thereafter.
//!
//! # Where it lives, and why that is one blob
//!
//! In the OS keychain, through [`bsc_secret::vault::Vault`] — the same trait and the same keychain
//! namespace the credential store uses, so there is no second secret store on this machine. The
//! private key, the psk, the room id and the public key are stored TOGETHER as one JSON value under
//! one account: they are one pairing, and splitting the secret half from the public half would let a
//! stored public key describe a private key that had been replaced, which is exactly the silent
//! mismatch this module exists to prevent.
//!
//! # What is deliberately not here
//!
//! No relay client, no websocket, no async runtime. This module answers *who the ear is* and
//! *what the phone must be told*; dialing the relay is a separate crate's job.

use bsc_secret::vault::Vault;
use serde::{Deserialize, Serialize};

/// The keychain account the identity is stored under — the MACHINE's, shared with the desktop app.
///
/// IT USED TO BE THE EAR'S OWN (`ear-tunnel-identity`), and that was the bug that stopped the stream
/// working. The app held a different keypair and a different seed, so a phone scanning the app's QR
/// derived `room("ear")` from the APP's seed while `bsc ear room` hosted `room("ear")` derived from
/// the EAR's — different seeds name different rooms, and the phone joined one nobody was hosting.
/// The B2 QR also carries exactly ONE host public key, which two processes with two keypairs cannot
/// both be authenticated by. One pairing reaching every room therefore requires ONE identity.
///
/// The old account is still read and PROMOTED on first load, so an ear that was already paired stays
/// paired — see [`bsc_secret::vault::load_or_create_machine_identity`].
pub const IDENTITY_ID: &str = bsc_secret::vault::MACHINE_IDENTITY_ID;

/// The environment variable consulted when `--relay` is not given and none has been remembered.
pub const RELAY_ENV: &str = "BSC_RELAY_URL";

/// The ear's long-lived pairing identity.
///
/// Every field is private: the only way out of this type is an accessor, and there is deliberately
/// no accessor for the psk or the private key. A caller can therefore render a pairing payload (the
/// one place a secret is meant to be shown) and cannot accidentally print either secret anywhere
/// else. [`std::fmt::Debug`] is hand-written for the same reason.
/// THE FIELDS MOVED, NOT THE MEANING. The stored shape is now
/// [`bsc_secret::vault::MachineIdentity`] — the same camelCase keys this struct used to declare
/// itself, so an entry written by either version deserializes through the other. It is `transparent`
/// for exactly that reason: the wrapper adds the EAR's reading of a shared value (derive for
/// `FEATURE_EAR`), and must add nothing to the JSON.
///
/// What used to live here and now does not: the validator, the writer, the read-back guard and the
/// minting. All four are the SAME in the app and in the ear, and keeping two copies is how the two
/// hosts drifted onto two identities in the first place.
#[derive(Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(transparent)]
pub struct Identity(bsc_secret::vault::MachineIdentity);

impl std::fmt::Debug for Identity {
    /// DELEGATES, deliberately. `MachineIdentity`'s own `Debug` redacts the private key, the seed and
    /// the psk while showing the public half; re-stating that here would be a second place for a
    /// redaction to be forgotten — and the seed is the widest secret of the three, since every
    /// feature's psk derives from it.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        std::fmt::Debug::fmt(&self.0, f)
    }
}

impl Identity {
    /// The relay room id this ear hosts.
    ///
    /// Returns an owned `String` rather than a borrow because the value is DERIVED when a seed is
    /// present — there is no stored field to lend out. Nothing outside this module's own tests
    /// calls it, so that signature change ripples nowhere: `cli.rs` and `room.rs` both reach the
    /// room through [`Identity::pairing`].
    ///
    /// The feature is always [`FEATURE_EAR`]: this identity IS the ear's, and deriving the console's
    /// room here would hand a phone the app's room while the ear hosted nothing — the precise
    /// confusion `one-pairing-assigns-every-room` exists to remove.
    pub fn room(&self) -> String {
        match self.seed_bytes() {
            Some(seed) => bsc_tunnel::relay::derive_room(&seed, bsc_tunnel::relay::FEATURE_EAR),
            // A pre-seed identity is pinned to the ONE room it was minted with, and that is the whole
            // of what it can reach. `unwrap_or_default` cannot be hit in practice: an identity with
            // neither a seed nor a stored room is refused at load.
            None => self.0.legacy_room().unwrap_or_default().to_string(),
        }
    }

    /// The pairing secret, derived from the seed when there is one.
    ///
    /// PRIVATE on purpose, and the struct's promise is unchanged: there is still no *public* way to
    /// read the psk, so [`Identity::pairing`] remains the only route out of the type for it.
    fn psk(&self) -> String {
        match self.seed_bytes() {
            Some(seed) => bsc_tunnel::relay::derive_psk(&seed, bsc_tunnel::relay::FEATURE_EAR),
            None => self.0.legacy_psk().unwrap_or_default().to_string(),
        }
    }

    /// The seed as raw bytes, or `None` when this identity predates seeds.
    ///
    /// A present-but-unparseable seed also answers `None` here, but it cannot reach this point:
    /// [`load_or_create`] refuses that identity outright rather than letting it fall back to a
    /// stored room, because silently pairing into the wrong room is the failure this whole item is
    /// about. [`Identity::validate`] is the guard, and a test pins it.
    fn seed_bytes(&self) -> Option<Vec<u8>> {
        let bytes = hex_decode(self.0.seed()?)?;
        (bytes.len() == SEED_BYTES).then_some(bytes)
    }

    /// Standard padded base64 of the static public key — the value the phone pins.
    pub fn host_pub_key(&self) -> &str {
        self.0.host_pub_key()
    }

    /// The remembered relay URL, if one has been supplied.
    pub fn relay_url(&self) -> Option<&str> {
        self.0.relay_url()
    }

    /// The raw X25519 private key, for the eventual relay client (`noise::responder` takes bytes).
    ///
    /// # Errors
    /// If the stored key is not valid base64 — which means the keychain value has been corrupted.
    pub fn static_priv(&self) -> Result<Vec<u8>, String> {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD
            .decode(self.0.static_priv())
            .map_err(|e| format!("the stored private key is not valid base64: {e}"))
    }

    /// Remember `relay_url` as this identity's relay and persist it.
    ///
    /// The keypair, room and psk are untouched: changing where the ear dials must never rotate WHO
    /// the ear is, or every paired phone would be dropped by a settings change.
    ///
    /// # Errors
    /// If the URL is empty, or the vault cannot durably store the updated identity.
    pub fn remember_relay(&mut self, relay_url: &str, vault: &dyn Vault) -> Result<(), String> {
        // Delegated: the trim, the no-op-when-unchanged and the read-back all live with the storage
        // now, and the app's tunnel reaches the same code for the same account.
        self.0.remember_relay(relay_url, vault)
    }

    /// The payload the phone parses — `{ relayUrl, room, hostPubKey, psk }`, and nothing else.
    ///
    /// `relay_override` wins over the remembered URL for this one rendering without persisting.
    ///
    /// # Errors
    /// If no relay URL is available from either source, naming how to supply one.
    pub fn pairing(&self, relay_override: Option<&str>) -> Result<PairingPayload, String> {
        let relay = match relay_override {
            Some(r) => normalize_relay(r)?,
            None => self
                .0
                .relay_url()
                .map(str::to_string)
                .ok_or_else(|| format!(
                    "no relay URL: pass `--relay <url>` or set {RELAY_ENV}. The relay is the \
                     zero-knowledge Worker both peers dial; it is not guessable, so there is no \
                     default to fall back to"
                ))?,
        };
        Ok(PairingPayload {
            relay_url: relay,
            room: self.room(),
            host_pub_key: self.0.host_pub_key().to_string(),
            psk: self.psk(),
        })
    }
}

/// What the phone reads from the QR (or from pasted text). Field-for-field the mobile client's
/// `PairingPayload`, whose parser requires all four to be present, non-empty strings.
#[derive(Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PairingPayload {
    /// The relay Worker URL to dial.
    pub relay_url: String,
    /// The room to join on it.
    pub room: String,
    /// Standard base64 of the desktop's static Noise public key — pinned by the phone.
    pub host_pub_key: String,
    /// The pairing secret the phone echoes back inside the Noise session.
    pub psk: String,
}

impl std::fmt::Debug for PairingPayload {
    /// Redacts the psk — the payload is meant to be SHOWN by `bsc ear pair`, never logged.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PairingPayload")
            .field("relayUrl", &self.relay_url)
            .field("room", &self.room)
            .field("hostPubKey", &self.host_pub_key)
            .field("psk", &"<redacted>")
            .finish()
    }
}

/// The RFC 4648 base32 alphabet. Every character is inside QR's 45-character ALPHANUMERIC set,
/// which is the entire point: that mode packs 5.5 bits per character where byte mode spends 8.
const B32_ALPHABET: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/// The compact encoding's version tag. A phone reads this first and can refuse a future format
/// outright rather than mis-parsing it into a pairing that fails much later, inside the handshake.
pub const COMPACT_VERSION: &str = "B1";

/// Bytes → unpadded base32. Padding is dropped because `=` is NOT in QR's alphanumeric set and
/// would force the whole code back into byte mode — losing the only reason to use base32 here.
fn b32_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(5) * 8);
    let (mut acc, mut bits) = (0u32, 0u32);
    for &b in bytes {
        acc = (acc << 8) | u32::from(b);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(B32_ALPHABET[((acc >> bits) & 0x1f) as usize] as char);
        }
    }
    if bits > 0 {
        out.push(B32_ALPHABET[((acc << (5 - bits)) & 0x1f) as usize] as char);
    }
    out
}

/// Hex → bytes, rejecting odd lengths and non-hex digits.
fn hex_decode(s: &str) -> Option<Vec<u8>> {
    if !s.len().is_multiple_of(2) {
        return None;
    }
    let b = s.as_bytes();
    (0..b.len() / 2)
        .map(|i| {
            let hi = (b[i * 2] as char).to_digit(16)?;
            let lo = (b[i * 2 + 1] as char).to_digit(16)?;
            Some((hi * 16 + lo) as u8)
        })
        .collect()
}

/// A pairing seed is 32 bytes — the width [`bsc_tunnel::relay::generate_seed`] produces and the
/// width the HMAC derivation keys on. Named rather than inlined so the validator and the encoder
/// cannot disagree about it.
const SEED_BYTES: usize = 32;

/// Bytes → lowercase hex, the shape the seed is stored in and the shape a psk is compared in.
fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The relay URL reduced to the `HOST[:PORT]` the compact form carries, uppercased.
///
/// Returns `None` when the URL carries a PATH. Uppercasing is lossless for a hostname — DNS is
/// case-insensitive — but a path is case-sensitive, so folding one would produce a URL that dials
/// the wrong place. The caller falls back to the JSON encoding rather than shipping a corrupt QR.
fn compact_host(relay_url: &str) -> Option<String> {
    let s = relay_url.trim();
    let rest = s
        .strip_prefix("https://")
        .or_else(|| s.strip_prefix("http://"))
        .or_else(|| s.strip_prefix("wss://"))
        .or_else(|| s.strip_prefix("ws://"))
        .unwrap_or(s)
        .trim_end_matches('/');
    if rest.is_empty() || rest.contains('/') {
        return None;
    }
    Some(rest.to_ascii_uppercase())
}

impl PairingPayload {
    /// The QR-optimised encoding: `B1*<HOST>*<ROOM>*<PK>*<PSK>`, every field uppercase base32 of
    /// the RAW BYTES rather than of the canonical string.
    ///
    /// MEASURED against the live payload: 239 bytes of JSON needs QR version 10 (57x57 modules) at
    /// EC level M; this needs version 6 (41x41). Roughly half the modules, so each one renders
    /// ~1.4x larger at the same pixel size — which is what actually makes a code scan.
    ///
    /// Returns `None` when the payload cannot be represented — a relay URL with a path, a room or
    /// key that is not valid base64, a psk that is not hex, or a key of the wrong width. Every one
    /// of those means the JSON form must be shown instead; none of them may be papered over,
    /// because a QR that decodes to a SLIGHTLY wrong key fails inside the Noise handshake, where
    /// the error says nothing about the encoding that caused it.
    ///
    /// The returned string CONTAINS THE PSK, exactly as the JSON form does. It belongs only on the
    /// same explicit-print path `bsc ear pair` already uses — never in a log line, which is why
    /// this is a separate method and not part of `Debug`.
    pub fn to_compact(&self) -> Option<String> {
        use base64::Engine;
        let host = compact_host(&self.relay_url)?;
        let room = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(&self.room)
            .ok()?;
        let pk = base64::engine::general_purpose::STANDARD
            .decode(&self.host_pub_key)
            .ok()?;
        let psk = hex_decode(&self.psk)?;
        // Widths are CHECKED, not assumed: both are X25519/32-byte values, so a short field is a
        // corrupt payload rather than a shorter key.
        if pk.len() != 32 || psk.len() != 32 || room.len() < 12 {
            return None;
        }
        Some(format!(
            "{COMPACT_VERSION}*{host}*{}*{}*{}",
            b32_encode(&room),
            b32_encode(&pk),
            b32_encode(&psk)
        ))
    }
}

/// Load the MACHINE's tunnel identity — the same one the desktop app loads — minting one the first
/// time and promoting `bsc ear`'s own older entry if that is all there is.
///
/// THE EAR NO LONGER HAS AN IDENTITY OF ITS OWN, and that is the fix rather than a simplification.
/// Two hosts with two seeds derive two different `room("ear")` values, so a phone paired from the
/// app's QR dialed a room `bsc ear room` was not hosting; and the QR carries ONE host public key,
/// which two keypairs cannot both satisfy. Sharing one identity is what makes a single pairing reach
/// both rooms.
///
/// The storage, the load order, the legacy promotion and the write-then-read-back guard all live in
/// [`bsc_secret::vault`] now — the app reached the same code for the same account, and keeping two
/// copies of it is how the two hosts drifted apart in the first place. What stays here is the ear's
/// READING of that shared value: derive for [`bsc_tunnel::relay::FEATURE_EAR`].
///
/// # Errors
/// If the keychain cannot be read (never treated as an absence — minting then would hand out a
/// second identity and unpair every phone that pinned the first), if a stored entry does not parse or
/// cannot name a room, or if a freshly minted identity does not survive a read-back.
pub fn load_or_create(vault: &dyn Vault) -> Result<Identity, String> {
    bsc_secret::vault::load_or_create_machine_identity(vault, || {
        use base64::Engine;
        let kp = bsc_tunnel::noise::generate_keypair()
            .map_err(|e| format!("could not generate a Noise keypair: {e}"))?;
        Ok(bsc_secret::vault::Minted {
            static_priv: base64::engine::general_purpose::STANDARD.encode(&kp.private),
            host_pub_key: base64::engine::general_purpose::STANDARD.encode(&kp.public),
            seed: hex_encode(&bsc_tunnel::relay::generate_seed()),
        })
    })
    .map(Identity)
}

/// Trim a relay URL the way `tunnel_start` does — whitespace, then trailing slashes.
///
/// The scheme is deliberately left alone: the phone's `normalizeRelayUrl` maps `http(s)://` to
/// `ws(s)://` itself, and doing it twice in two places is how the two ends drift.
fn normalize_relay(url: &str) -> Result<String, String> {
    let trimmed = url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("a relay URL is required".into());
    }
    Ok(trimmed.to_string())
}

// The two private generators that used to live here — `generate_room_id` and `generate_psk`, copies
// of `transport::`'s — ARE GONE. They existed only because the relay client was trapped in a Tauri
// module this crate could not depend on, and their own comment named this as the moment to retire
// them once it moved. `mint` now calls `bsc_tunnel::relay`'s derivation, so the ear and the desktop
// compute a room from ONE implementation instead of two shapes kept equal by hand.
//
// The shared `relay::generate_room_id` / `generate_psk` survive there: the B1 compact path still
// rolls a random room, and the desktop's own tests pin them.

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    use bsc_secret::vault::{Lookup, MapVault};

    /// A vault that accepts every write and remembers nothing — `keyring`'s `mock` backend, which
    /// is what a Linux build with no Secret Service feature silently falls back to.
    struct AmnesiacVault;
    impl Vault for AmnesiacVault {
        fn has(&self, _id: &str) -> bool {
            false
        }
        fn put(&self, _id: &str, _value: &str) -> Result<(), String> {
            Ok(())
        }
        fn forget(&self, _id: &str) -> Result<(), String> {
            Ok(())
        }
        fn get(&self, _id: &str) -> Option<String> {
            None
        }
        /// ABSENT, not unreadable. This backend answers every question it is asked — it simply has
        /// no record, because it threw the write away. That is exactly what `Absent` means, and it
        /// is what makes `load_or_create`'s read-back able to call the forgotten write a failure.
        fn lookup(&self, _id: &str) -> Lookup {
            Lookup::Absent
        }
    }

    /// A vault that cannot store anything — a locked keychain.
    struct RefusingVault;
    impl Vault for RefusingVault {
        fn has(&self, _id: &str) -> bool {
            false
        }
        fn put(&self, _id: &str, _value: &str) -> Result<(), String> {
            Err("the keychain is locked".into())
        }
        fn forget(&self, _id: &str) -> Result<(), String> {
            Ok(())
        }
        fn get(&self, _id: &str) -> Option<String> {
            None
        }
        /// UNREADABLE, never absent. A locked keychain answers nothing: it cannot say whether an
        /// identity is stored, so reporting `Absent` would assert the one falsehood this enum was
        /// added to prevent — and for an always-on ear that falsehood mints a SECOND identity and
        /// silently unpairs every phone that pinned the first.
        fn lookup(&self, _id: &str) -> Lookup {
            Lookup::Unreadable("the keychain is locked".into())
        }
    }

    // ── The compact (B1) QR encoding ──────────────────────────────────────────────────────
    //
    // THESE VECTORS ARE A COPY of the `pairing` section in
    // `src/features/tunnel/lib/tunnelProtocol.fixtures.json` and must be changed in lockstep
    // with it. The copy is deliberate: this crate has no `find_fixture` helper, and reaching
    // from a crate test into the repo's frontend tree depends on the working directory. The
    // desktop and mobile tests DO read that file, so the cross-implementation contract is
    // enforced on two of the three sides; this side proves the encoder against the same bytes.

    const FIXTURE_RELAY: &str = "https://relay.example.workers.dev";
    const FIXTURE_ROOM: &str = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYX";
    const FIXTURE_PK: &str = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
    const FIXTURE_PSK: &str = "202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f";
    const FIXTURE_COMPACT: &str = "B1*RELAY.EXAMPLE.WORKERS.DEV*AAAQEAYEAUDAOCAJBIFQYDIOB4IBCEQTCQKRMFY*AAAQEAYEAUDAOCAJBIFQYDIOB4IBCEQTCQKRMFYYDENBWHA5DYPQ*EAQSEIZEEUTCOKBJFIVSYLJOF4YDCMRTGQ2TMNZYHE5DWPB5HY7Q";

    fn fixture_payload() -> PairingPayload {
        PairingPayload {
            relay_url: FIXTURE_RELAY.into(),
            room: FIXTURE_ROOM.into(),
            host_pub_key: FIXTURE_PK.into(),
            psk: FIXTURE_PSK.into(),
        }
    }

    /// A base32 encoder written by hand is worth nothing until it is shown to be REAL base32
    /// rather than a private alphabet ordering that happens to round-trip against itself. These
    /// are RFC 4648 §10's own vectors, with the padding dropped as the compact form drops it.
    #[test]
    fn base32_is_rfc4648_and_not_an_invention() {
        assert_eq!(b32_encode(b""), "");
        assert_eq!(b32_encode(b"f"), "MY");
        assert_eq!(b32_encode(b"fo"), "MZXQ");
        assert_eq!(b32_encode(b"foo"), "MZXW6");
        assert_eq!(b32_encode(b"foob"), "MZXW6YQ");
        assert_eq!(b32_encode(b"fooba"), "MZXW6YTB");
        assert_eq!(b32_encode(b"foobar"), "MZXW6YTBOI");
    }

    /// The cross-implementation contract: this encoder must produce the fixture EXACTLY, because
    /// the phone decodes that same string back into the canonical values.
    #[test]
    fn the_compact_form_is_the_fixture_byte_for_byte() {
        assert_eq!(fixture_payload().to_compact().unwrap(), FIXTURE_COMPACT);
    }

    /// The property the whole encoding exists for. If any character falls outside QR's 45-char
    /// alphanumeric set the encoder silently drops to byte mode and the code grows again — which
    /// would be invisible without this assertion, since the string still *looks* fine.
    #[test]
    fn the_compact_form_stays_inside_qr_alphanumeric() {
        let s = fixture_payload().to_compact().unwrap();
        for c in s.chars() {
            assert!(
                c.is_ascii_digit() || c.is_ascii_uppercase() || " $%*+-./:".contains(c),
                "character {c:?} is outside QR alphanumeric mode"
            );
        }
    }

    /// Uppercasing is lossless for a hostname and NOT for a path, so a relay URL carrying one must
    /// refuse the compact form rather than emit a QR that dials somewhere else.
    #[test]
    fn a_relay_url_with_a_path_refuses_the_compact_form() {
        let mut p = fixture_payload();
        p.relay_url = "https://relay.example.workers.dev/Tunnel".into();
        assert!(p.to_compact().is_none());
        assert!(compact_host("https://host.example/a/b").is_none());
        // A bare host, a port, and a trailing slash all remain encodable.
        assert_eq!(compact_host("https://host.example/").unwrap(), "HOST.EXAMPLE");
        assert_eq!(compact_host("wss://host.example:8787").unwrap(), "HOST.EXAMPLE:8787");
    }

    /// A short key is a corrupt payload, not a shorter key. Encoding one would produce a QR that
    /// fails inside the Noise handshake, where the error says nothing about the encoding.
    #[test]
    fn a_wrong_width_key_refuses_rather_than_truncating() {
        use base64::Engine;
        let mut p = fixture_payload();
        p.host_pub_key = base64::engine::general_purpose::STANDARD.encode([0u8; 16]);
        assert!(p.to_compact().is_none());

        let mut p = fixture_payload();
        p.psk = "abcd".into();
        assert!(p.to_compact().is_none());

        let mut p = fixture_payload();
        p.psk = "zz".repeat(32); // right length, not hex
        assert!(p.to_compact().is_none());
    }

    /// THE POINT OF THE WHOLE MODULE: a second load is the same identity, so a phone that pinned
    /// `hostPubKey` yesterday is still paired today.
    #[test]
    fn an_identity_is_generated_once_and_is_stable_across_loads() {
        let vault = MapVault::default();
        let first = load_or_create(&vault).unwrap();
        let second = load_or_create(&vault).unwrap();
        assert_eq!(first, second, "a reload must not mint a new identity");
        assert_eq!(first.host_pub_key(), second.host_pub_key());
        assert_eq!(first.room(), second.room());
        assert_eq!(
            first.pairing(Some("wss://r.example")).unwrap().psk,
            second.pairing(Some("wss://r.example")).unwrap().psk,
            "the psk must survive a reload too — the phone echoes it back"
        );
    }

    /// Two ears (or one ear on two machines) must not collide.
    #[test]
    fn two_independent_vaults_get_independent_identities() {
        let a = load_or_create(&MapVault::default()).unwrap();
        let b = load_or_create(&MapVault::default()).unwrap();
        assert_ne!(a.host_pub_key(), b.host_pub_key());
        assert_ne!(a.room(), b.room());
    }

    /// The mobile client decodes `hostPubKey` as standard base64 and warns when the result is not
    /// 32 bytes — an X25519 static key is exactly 32.
    #[test]
    fn the_host_pub_key_is_standard_base64_of_exactly_32_bytes() {
        let id = load_or_create(&MapVault::default()).unwrap();
        let raw = base64::engine::general_purpose::STANDARD
            .decode(id.host_pub_key())
            .expect("standard padded base64, as TunnelState::host_pub_key_b64 emits");
        assert_eq!(raw.len(), 32, "an X25519 public key is 32 bytes");
        assert_eq!(id.static_priv().unwrap().len(), 32, "and so is the private half");
    }

    /// The relay's `validateRoomId` is `[A-Za-z0-9_-]{16,64}`; 24 random bytes base64url-encode to
    /// 32 characters with no padding.
    #[test]
    fn the_room_id_is_in_the_shape_the_relay_accepts() {
        let id = load_or_create(&MapVault::default()).unwrap();
        let room = id.room();
        assert_eq!(room.len(), 32, "24 bytes → 32 base64url chars: {room}");
        assert!((16..=64).contains(&room.len()));
        assert!(
            room.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'),
            "a padded or standard-alphabet room id would be rejected by the relay: {room}"
        );
    }

    #[test]
    fn the_psk_is_sixty_four_lowercase_hex_chars() {
        let id = load_or_create(&MapVault::default()).unwrap();
        let psk = id.pairing(Some("wss://r.example")).unwrap().psk;
        assert_eq!(psk.len(), 64, "32 bytes as hex");
        assert!(psk.chars().all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c)), "{psk}");
    }

    // ── The seed, and the identity that predates it ───────────────────────────────────────
    //
    // The keychain on the maintainer's machine holds an identity minted BEFORE seeds existed, and a
    // phone has pinned its `hostPubKey`. Migration is therefore not a nicety: an upgrade that
    // changed which room that identity names would unpair a working phone, and would do it silently.

    /// A pre-seed identity, in exactly the shape the keychain holds one today — no `seed` key at all.
    const LEGACY_IDENTITY_JSON: &str = concat!(
        r#"{"staticPriv":"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=","#,
        r#""hostPubKey":"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=","#,
        r#""room":"AAECAwQFBgcICQoLDA0ODxAREhMUFRYX","#,
        r#""psk":"202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f","#,
        r#""relayUrl":"wss://legacy.example"}"#
    );

    /// The same identity WITH a seed. `room` and `psk` deliberately keep the legacy values, which
    /// disagree with what the seed derives — that is what makes "the seed wins" observable.
    fn identity_json_with_seed(seed_hex: &str) -> String {
        format!(
            r#"{{"staticPriv":"{pk}","hostPubKey":"{pk}","room":"{room}","psk":"{psk}","seed":"{seed_hex}","relayUrl":"wss://r.example"}}"#,
            pk = FIXTURE_PK,
            room = FIXTURE_ROOM,
            psk = FIXTURE_PSK,
        )
    }

    /// A PRE-SEED ENTRY AT THE SHARED ACCOUNT keeps the room and psk it already had, so a phone that
    /// paired against it yesterday is still paired today.
    ///
    /// NOTE WHICH ACCOUNT THIS COVERS. `IDENTITY_ID` is the SHARED one now, so this exercises
    /// "found, parsed, returned without a re-save" — not the promotion of `bsc ear`'s own older
    /// entry. That migration is a different path and has its own test below; this one used to cover
    /// both only because the ear's account and the account it reads were the same string.
    #[test]
    fn an_identity_stored_without_a_seed_keeps_its_original_room_and_psk() {
        let vault = MapVault::default();
        vault.put(IDENTITY_ID, LEGACY_IDENTITY_JSON).unwrap();

        let id = load_or_create(&vault).unwrap();
        assert_eq!(id.room(), FIXTURE_ROOM, "a seedless identity must keep the room the phone pinned");

        let payload = id.pairing(None).unwrap();
        assert_eq!(payload.room, FIXTURE_ROOM);
        assert_eq!(payload.psk, FIXTURE_PSK, "and the secret it echoes back");

        // A LOAD MUST NOT UPGRADE IT IN PLACE. Writing a seed here would change the room this
        // identity names from the next load onward — the same silent unpairing, one release later.
        assert_eq!(
            vault.get(IDENTITY_ID).as_deref(),
            Some(LEGACY_IDENTITY_JSON),
            "loading a legacy identity must not rewrite it"
        );
    }

    /// The cross-implementation pin at the EAR's level. `bsc-tunnel` proves the derivation matches
    /// `pairingV2`; this proves the ear asks it for the EAR's feature. A `FEATURE_CONSOLE` here would
    /// pass every shape assertion in this file and hand the phone the app's room.
    #[test]
    fn the_ear_derives_the_fixtures_ear_room_and_not_the_consoles() {
        // pairingV2.seedHex — 000102…1f, chosen so a reader can check it by eye.
        let seed_hex = hex_encode(&(0u8..=31).collect::<Vec<u8>>());
        let id: Identity = serde_json::from_str(&identity_json_with_seed(&seed_hex)).unwrap();

        assert_eq!(
            id.room(),
            "NmX5pb7cs2Vn9SsGtOLRbEx7SSWsLkBw",
            "pairingV2.features.ear.room"
        );
        assert_eq!(
            id.pairing(None).unwrap().psk,
            "d59994408599a34fbd3fd2adcf9668ad07dcbc147915d20ced8df0979feec996",
            "pairingV2.features.ear.psk"
        );
        assert_ne!(
            id.room(),
            "X3nsvjcpmyYsFxCvWdrhWB5_5zthMDr9",
            "that is the CONSOLE's room — the ear must not host it"
        );
        // And the seed beats the stored legacy values rather than the other way round.
        assert_ne!(id.room(), FIXTURE_ROOM, "a present seed is authoritative over the stored room");
    }

    // THE STORED room/psk MIRROR IS GONE, and it was removed on purpose — do not re-add it.
    //
    // A test used to assert that a freshly minted identity ALSO wrote the derived `room` and `psk`,
    // so an older `bsc` binary reading the ear's private entry still found the right room. There is
    // no private entry any more: the identity is the MACHINE's, shared with the app, and a fresh one
    // stores only the seed. A second copy of a derived value is exactly the kind of mirror that
    // drifts, and the drift it enabled here — two hosts, two seeds, two different `room("ear")` —
    // is the bug this whole change exists to remove. `legacy_room`/`legacy_psk` are read ONLY when a
    // pre-seed entry has no seed to derive from, which `an_identity_stored_without_a_seed_...` pins.

    /// THE MIGRATION THAT KEEPS AN ALREADY-PAIRED EAR PAIRED. Before the identity was shared, the ear
    /// stored its own under `ear-tunnel-identity`, and a phone may have pinned that keypair. Loading
    /// must PROMOTE that entry to the shared account rather than mint a fresh one: minting would
    /// change both the room this ear hosts and the key the phone pins, unpairing it in silence.
    ///
    /// `bsc-secret` pins the promotion at the STORAGE level. This pins the half that is the ear's own:
    /// that it reads the promoted identity and derives ITS feature's room from the promoted seed.
    #[test]
    fn an_identity_under_the_legacy_ear_account_is_promoted_and_read() {
        let vault = MapVault::default();
        let seed_hex = hex_encode(&(0u8..=31).collect::<Vec<u8>>());
        vault
            .put(bsc_secret::vault::LEGACY_EAR_IDENTITY_ID, &identity_json_with_seed(&seed_hex))
            .unwrap();

        let id = load_or_create(&vault).unwrap();
        // pairingV2.features.ear.room — derived from the PROMOTED seed, for the ear's feature.
        assert_eq!(id.room(), "NmX5pb7cs2Vn9SsGtOLRbEx7SSWsLkBw");
        assert_eq!(id.host_pub_key(), FIXTURE_PK, "the key the phone pinned survives the promotion");

        assert!(vault.has(IDENTITY_ID), "it is promoted to the shared account");
        assert!(
            vault.has(bsc_secret::vault::LEGACY_EAR_IDENTITY_ID),
            "and the legacy entry is NOT deleted, so an older bsc ear binary keeps working"
        );

        // A second load reads the shared account: no promotion, and above all no minting.
        let again = load_or_create(&vault).unwrap();
        assert_eq!(again.room(), id.room());
        assert_eq!(again.host_pub_key(), id.host_pub_key());
    }

    /// A seed that is present and malformed must be REFUSED, never quietly ignored in favour of the
    /// stored room — that would host one room while the phone dialed another, which is the exact
    /// silent failure `one-pairing-assigns-every-room` was written from.
    #[test]
    fn a_present_but_malformed_seed_is_refused_rather_than_falling_back() {
        for bad in ["zz".repeat(32), "00010203".into(), String::new()] {
            let vault = MapVault::default();
            vault.put(IDENTITY_ID, &identity_json_with_seed(&bad)).unwrap();
            let e = load_or_create(&vault).unwrap_err();
            assert!(e.contains(IDENTITY_ID), "the error should name the entry: {e}");
            assert!(
                !e.is_empty() && (e.contains("seed") || e.contains("hex")),
                "and should say the seed is the problem: {e}"
            );
        }
    }

    /// An identity that can name no room at all is corrupt, and saying so beats returning an empty
    /// room id that the relay would reject much later with an unrelated-looking error.
    #[test]
    fn an_identity_with_neither_a_seed_nor_a_room_is_refused() {
        let vault = MapVault::default();
        vault
            .put(
                IDENTITY_ID,
                r#"{"staticPriv":"AA==","hostPubKey":"AA==","room":"","psk":""}"#,
            )
            .unwrap();
        let e = load_or_create(&vault).unwrap_err();
        assert!(e.contains("cannot name a room"), "{e}");
    }

    /// The seed is a WIDER secret than the psk — it derives every feature's — so it must never reach
    /// a `{:?}`, which is where values end up inside logged errors.
    #[test]
    fn debug_redacts_the_seed_as_well() {
        let vault = MapVault::default();
        let id = load_or_create(&vault).unwrap();
        let stored: serde_json::Value = serde_json::from_str(&vault.get(IDENTITY_ID).unwrap()).unwrap();
        let seed = stored["seed"].as_str().unwrap();

        let rendered = format!("{id:?}");
        assert!(!rendered.contains(seed), "the seed leaked: {rendered}");
        assert!(rendered.contains("seed"), "but the field is still named, so its absence is visible");
    }

    /// The phone's parser requires exactly these four non-empty strings and reads nothing else.
    #[test]
    fn the_pairing_payload_is_exactly_the_four_fields_the_phone_parses() {
        let id = load_or_create(&MapVault::default()).unwrap();
        let payload = id.pairing(Some("  https://relay.example.workers.dev/  ")).unwrap();
        let v: serde_json::Value = serde_json::to_value(&payload).unwrap();
        let obj = v.as_object().unwrap();
        let mut keys: Vec<&str> = obj.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, vec!["hostPubKey", "psk", "relayUrl", "room"]);
        assert!(obj.values().all(|x| x.as_str().is_some_and(|s| !s.is_empty())));
        assert_eq!(
            obj["relayUrl"], "https://relay.example.workers.dev",
            "whitespace and trailing slashes go; the SCHEME is left for the phone to normalize"
        );
    }

    #[test]
    fn pairing_without_any_relay_url_says_how_to_supply_one() {
        let id = load_or_create(&MapVault::default()).unwrap();
        let e = id.pairing(None).unwrap_err();
        assert!(e.contains("--relay"), "{e}");
        assert!(e.contains(RELAY_ENV), "{e}");
    }

    /// Remembering the relay is what makes `bsc ear pair` reproducible — and it must not rotate the
    /// identity, or changing a setting would unpair the phone.
    #[test]
    fn the_relay_url_is_remembered_without_rotating_the_identity() {
        let vault = MapVault::default();
        let mut id = load_or_create(&vault).unwrap();
        let before = id.host_pub_key().to_string();
        let room = id.room();
        id.remember_relay("wss://relay.example/", &vault).unwrap();

        let reloaded = load_or_create(&vault).unwrap();
        assert_eq!(reloaded.relay_url(), Some("wss://relay.example"));
        assert_eq!(reloaded.host_pub_key(), before, "the keypair must survive a relay change");
        assert_eq!(reloaded.room(), room);
        assert_eq!(reloaded.pairing(None).unwrap().relay_url, "wss://relay.example");
    }

    #[test]
    fn an_empty_relay_url_is_refused() {
        let vault = MapVault::default();
        let mut id = load_or_create(&vault).unwrap();
        assert!(id.remember_relay("   ", &vault).is_err());
        assert!(id.pairing(Some("")).is_err());
    }

    /// A vault that forgets the write must be an ERROR. Reporting success would hand out a pairing
    /// that dies at the next restart — the exact failure the ear cannot have.
    #[test]
    fn a_vault_that_forgets_the_write_is_a_failure_not_a_fresh_identity() {
        let e = load_or_create(&AmnesiacVault).unwrap_err();
        assert!(e.contains(IDENTITY_ID), "the error should name the entry: {e}");
        assert!(e.to_lowercase().contains("restart") || e.to_lowercase().contains("no record"), "{e}");
    }

    #[test]
    fn a_vault_that_cannot_store_is_reported_rather_than_ignored() {
        let e = load_or_create(&RefusingVault).unwrap_err();
        assert!(e.contains("locked"), "the underlying reason should survive: {e}");
    }

    /// A corrupt entry is refused, NOT replaced. Replacing it would unpair every phone silently,
    /// which is worse than an error a human can look at.
    #[test]
    fn a_corrupt_stored_identity_is_refused_rather_than_rotated() {
        let vault = MapVault::default();
        vault.put(IDENTITY_ID, "{not json").unwrap();
        let e = load_or_create(&vault).unwrap_err();
        assert!(e.contains(IDENTITY_ID), "{e}");
        assert_eq!(
            vault.get(IDENTITY_ID).as_deref(),
            Some("{not json"),
            "the failed load must not have overwritten the stored value"
        );
    }

    /// Neither secret may appear in a `{:?}`, which is where values end up in logged errors.
    #[test]
    fn debug_redacts_both_secrets() {
        let vault = MapVault::default();
        let id = load_or_create(&vault).unwrap();
        let payload = id.pairing(Some("wss://r.example")).unwrap();
        let stored = vault.get(IDENTITY_ID).unwrap();
        let secret_priv = serde_json::from_str::<serde_json::Value>(&stored).unwrap()["staticPriv"]
            .as_str()
            .unwrap()
            .to_string();

        let rendered = format!("{id:?}");
        assert!(!rendered.contains(&secret_priv), "the private key leaked: {rendered}");
        assert!(!rendered.contains(&payload.psk), "the psk leaked: {rendered}");
        assert!(!format!("{payload:?}").contains(&payload.psk));
        assert!(rendered.contains(id.host_pub_key()), "the PUBLIC half is fine to show");
    }
}
