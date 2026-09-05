//! The two key documents have to describe ONE working stream, and nothing
//! about reading them separately can prove that.
//!
//! Each document parses on its own merits: sixty-four hex characters, a valid
//! address, a mode nobody else can read. All of that passes when an operator
//! pastes the group key from one keygen and the sensor's public key from
//! another, or transposes the signing key and the public half between the two
//! files. What they get is a sensor that transmits happily and a subscriber
//! that hears nothing — reported, correctly and unhelpfully, as `NEVER HEARD`,
//! the same line a dead switch produces.
//!
//! So this test carries a sealed datagram from the sensor document's keys to
//! the subscriber document's keys and asserts it arrives, and then asserts
//! that the near-miss — a subscriber holding the wrong public half — is
//! REJECTED rather than quietly accepted.

use bsc_lan_sense::config::{parse_sensor, parse_subscriber, refuse_if_readable_by_others};
use bsc_lan_stream::crypto::{GroupKey, Sensor, Subscriber};
use bsc_lan_stream::envelope::Kind;
use ed25519_dalek::{SigningKey, VerifyingKey};

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// The pair an operator is meant to produce: one signing key, its own public
/// half, and one group key shared by both documents.
fn documents(signing: &SigningKey, public: &VerifyingKey, group: [u8; 32]) -> (String, String) {
    let sensor = format!(
        r#"{{"destination":"239.10.20.30:5140","sensorKey":"{}","groupKey":"{}"}}"#,
        hex(&signing.to_bytes()),
        hex(&group)
    );
    let subscriber = format!(
        r#"{{"group":"239.10.20.30:5140","sensors":[{{"name":"monitor-pi","publicKey":"{}"}}],"groupKey":"{}"}}"#,
        hex(&public.to_bytes()),
        hex(&group)
    );
    (sensor, subscriber)
}

#[test]
fn a_matched_pair_of_documents_carries_a_real_datagram() {
    let signing = SigningKey::from_bytes(&[7u8; 32]);
    let public = signing.verifying_key();
    let (sensor_doc, subscriber_doc) = documents(&signing, &public, [9u8; 32]);

    let sen = parse_sensor(&sensor_doc).expect("the sensor document parses");
    let sub = parse_subscriber(&subscriber_doc).expect("the subscriber document parses");

    // Built the way the CLI and the app build them: from the config's bytes,
    // never from the values this test happens to hold.
    let sensor = Sensor::new(
        SigningKey::from_bytes(&sen.sensor_key_bytes().unwrap()),
        GroupKey::from_bytes(sen.group_key_bytes().unwrap()),
        [1u8; 16],
    );
    let subscriber = Subscriber::new(
        VerifyingKey::from_bytes(&sub.roster().unwrap()[0].1).expect("a valid public key"),
        GroupKey::from_bytes(sub.group_key_bytes().unwrap()),
    );

    let plain = b"a spectrum record".to_vec();
    let datagram = sensor.seal(Kind::Delta, 0, [3u8; 12], &plain).expect("seals");
    let (env, got) = subscriber.open(&datagram).expect("the pair must describe ONE stream");
    assert_eq!(got, plain, "the payload did not survive the round trip");
    assert_eq!(env.seq, 0);
}

#[test]
fn a_subscriber_holding_the_wrong_public_half_is_refused_not_ignored() {
    // The transposition an operator actually makes: two keygens, and the
    // public key pasted from the wrong one. Both documents are individually
    // valid; only carrying a datagram between them can tell.
    let signing = SigningKey::from_bytes(&[7u8; 32]);
    let other = SigningKey::from_bytes(&[8u8; 32]).verifying_key();
    let (sensor_doc, subscriber_doc) = documents(&signing, &other, [9u8; 32]);

    let sen = parse_sensor(&sensor_doc).expect("parses");
    let sub = parse_subscriber(&subscriber_doc).expect("parses — which is the whole problem");

    let sensor = Sensor::new(
        SigningKey::from_bytes(&sen.sensor_key_bytes().unwrap()),
        GroupKey::from_bytes(sen.group_key_bytes().unwrap()),
        [1u8; 16],
    );
    let subscriber = Subscriber::new(
        VerifyingKey::from_bytes(&sub.roster().unwrap()[0].1).unwrap(),
        GroupKey::from_bytes(sub.group_key_bytes().unwrap()),
    );

    let datagram = sensor.seal(Kind::Delta, 0, [3u8; 12], b"x").expect("seals");
    assert!(
        subscriber.open(&datagram).is_err(),
        "a mismatched public key accepted the stream — the signature would then prove nothing"
    );
}

#[test]
fn a_mismatched_group_key_is_refused_too() {
    // The other half of the same mistake, and it fails at a different layer:
    // the signature verifies, and the decryption does not.
    let signing = SigningKey::from_bytes(&[7u8; 32]);
    let public = signing.verifying_key();
    let (sensor_doc, _) = documents(&signing, &public, [9u8; 32]);
    let (_, subscriber_doc) = documents(&signing, &public, [10u8; 32]);

    let sen = parse_sensor(&sensor_doc).unwrap();
    let sub = parse_subscriber(&subscriber_doc).unwrap();
    let sensor = Sensor::new(
        SigningKey::from_bytes(&sen.sensor_key_bytes().unwrap()),
        GroupKey::from_bytes(sen.group_key_bytes().unwrap()),
        [1u8; 16],
    );
    let subscriber = Subscriber::new(
        VerifyingKey::from_bytes(&sub.roster().unwrap()[0].1).unwrap(),
        GroupKey::from_bytes(sub.group_key_bytes().unwrap()),
    );
    let datagram = sensor.seal(Kind::Delta, 0, [3u8; 12], b"x").unwrap();
    assert!(subscriber.open(&datagram).is_err(), "a mismatched group key decrypted the stream");
}

#[cfg(unix)]
#[test]
fn the_documents_are_read_from_real_files_with_a_real_mode() {
    // The parse tests work on strings. This one puts both documents on a disk,
    // because the mode check is the guard that only exists against a file and
    // the loaders are the only path production takes.
    use std::os::unix::fs::PermissionsExt;
    let signing = SigningKey::from_bytes(&[7u8; 32]);
    let public = signing.verifying_key();
    let (sensor_doc, subscriber_doc) = documents(&signing, &public, [9u8; 32]);

    let dir = std::env::temp_dir().join(format!("bsc-lan-pair-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let sp = dir.join("sensor.json");
    let up = dir.join("subscriber.json");
    std::fs::write(&sp, &sensor_doc).unwrap();
    std::fs::write(&up, &subscriber_doc).unwrap();
    std::fs::set_permissions(&sp, std::fs::Permissions::from_mode(0o600)).unwrap();
    std::fs::set_permissions(&up, std::fs::Permissions::from_mode(0o600)).unwrap();

    refuse_if_readable_by_others(&sp).expect("mode 600 is acceptable");
    refuse_if_readable_by_others(&up).expect("mode 600 is acceptable");
    let sen = parse_sensor(&std::fs::read_to_string(&sp).unwrap()).unwrap();
    let sub = parse_subscriber(&std::fs::read_to_string(&up).unwrap()).unwrap();
    assert_eq!(sen.group_key_bytes().unwrap(), sub.group_key_bytes().unwrap());

    // And one of them made world-readable is refused, from the same disk.
    std::fs::set_permissions(&up, std::fs::Permissions::from_mode(0o644)).unwrap();
    let e = refuse_if_readable_by_others(&up).unwrap_err();
    assert!(e.contains("0644"), "the refusal hides the mode: {e}");

    std::fs::remove_dir_all(&dir).ok();
}
