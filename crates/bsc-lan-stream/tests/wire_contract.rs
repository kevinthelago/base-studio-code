//! End-to-end properties of the sensor stream, exercised over real datagrams.
//!
//! Every test here builds a genuine sealed datagram and opens it the way a
//! subscriber would. Keys are fixed rather than random so a failure is
//! reproducible from the test name alone.

use bsc_lan_stream::crypto::{GroupKey, Sensor, Subscriber};
use bsc_lan_stream::envelope::{Kind, MAX_PLAINTEXT_BYTES};
use bsc_lan_stream::frame::{Event, Frame, SensorState};
use bsc_lan_stream::sequence::{Completeness, Reception, Tracker};
use bsc_lan_stream::WireError;
use ed25519_dalek::SigningKey;

const GROUP: [u8; 32] = [7u8; 32];
const BOOT: [u8; 16] = [42u8; 16];

fn sensor_key() -> SigningKey {
    SigningKey::from_bytes(&[3u8; 32])
}

/// A key an attacker might hold instead of the sensor's.
fn other_key() -> SigningKey {
    SigningKey::from_bytes(&[9u8; 32])
}

fn sensor() -> Sensor {
    Sensor::new(sensor_key(), GroupKey::from_bytes(GROUP), BOOT)
}

fn subscriber() -> Subscriber {
    Subscriber::new(sensor_key().verifying_key(), GroupKey::from_bytes(GROUP))
}

fn an_alert() -> Frame {
    Frame::Delta(Event::Alert {
        sid: 2010935,
        msg: "ET SCAN Potential SSH Scan".into(),
        src: "10.99.4.66".into(),
        dst: "10.99.2.1".into(),
        severity: 2,
    })
}

#[test]
fn a_datagram_round_trips_through_seal_and_open() {
    let frame = an_alert();
    let dg = sensor()
        .seal(Kind::Delta, 0, [1u8; 12], &frame.encode().unwrap())
        .unwrap();

    let (env, plaintext) = subscriber().open(&dg).unwrap();
    assert_eq!(env.kind, Kind::Delta);
    assert_eq!(env.seq, 0);
    assert_eq!(env.boot_id, BOOT);
    assert_eq!(Frame::decode(&plaintext).unwrap(), frame);
}

#[test]
fn every_single_byte_of_the_datagram_is_covered_by_the_signature() {
    let dg = sensor()
        .seal(Kind::Delta, 0, [1u8; 12], &an_alert().encode().unwrap())
        .unwrap();
    let sub = subscriber();

    // Not a spot check: flipping ANY byte anywhere must be refused. A partial
    // guard here would leave an editable region on the wire.
    for i in 0..dg.len() {
        let mut tampered = dg.clone();
        tampered[i] ^= 0x01;
        assert!(
            sub.open(&tampered).is_err(),
            "byte {i} of {} could be altered without detection",
            dg.len()
        );
    }
}

/// THE COMPROMISED-SUBSCRIBER PROPERTY -- the reason the group key and the
/// signing key are separate.
///
/// A subscriber necessarily holds the group key, so it can read the stream.
/// It must never be able to WRITE to it. Since the operator intends to add
/// many subscribing devices, a design where any subscriber could fabricate an
/// alert would get less trustworthy with every device added.
#[test]
fn a_subscriber_holding_the_group_key_cannot_forge_a_datagram() {
    // The attacker has the group key (it is a subscriber) and encrypts a
    // perfectly well-formed lie -- but must sign with a key it does not have.
    let attacker = Sensor::new(other_key(), GroupKey::from_bytes(GROUP), BOOT);
    let lie = Frame::Delta(Event::Alert {
        sid: 1,
        msg: "all clear".into(),
        src: "10.0.0.1".into(),
        dst: "10.0.0.2".into(),
        severity: 0,
    });

    let forged = attacker
        .seal(Kind::Delta, 99, [5u8; 12], &lie.encode().unwrap())
        .unwrap();

    assert_eq!(
        subscriber().open(&forged),
        Err(WireError::BadSignature),
        "a group-key holder forged a datagram that a subscriber accepted"
    );
}

#[test]
fn a_datagram_from_the_right_sensor_but_the_wrong_group_key_does_not_decrypt() {
    let wrong_group = Sensor::new(sensor_key(), GroupKey::from_bytes([8u8; 32]), BOOT);
    let dg = wrong_group
        .seal(Kind::Delta, 0, [1u8; 12], &an_alert().encode().unwrap())
        .unwrap();
    // The signature is genuine, so this is specifically a confidentiality
    // failure rather than an authenticity one -- the errors must not blur.
    assert_eq!(subscriber().open(&dg), Err(WireError::Undecryptable));
}

#[test]
fn a_payload_over_the_budget_is_refused_at_build_time_rather_than_fragmented() {
    let too_big = vec![b'x'; MAX_PLAINTEXT_BYTES + 1];
    assert!(matches!(
        sensor().seal(Kind::Delta, 0, [1u8; 12], &too_big),
        Err(WireError::PayloadTooLarge { .. })
    ));

    // And the largest permitted payload really does fit the wire budget.
    let at_limit = vec![b'x'; MAX_PLAINTEXT_BYTES];
    let dg = sensor().seal(Kind::Delta, 0, [1u8; 12], &at_limit).unwrap();
    assert!(dg.len() <= bsc_lan_stream::MAX_DATAGRAM_BYTES);
    assert_eq!(subscriber().open(&dg).unwrap().1, at_limit);
}

#[test]
fn garbage_on_the_multicast_group_is_rejected_by_shape_before_any_crypto() {
    let sub = subscriber();
    assert_eq!(sub.open(&[]), Err(WireError::Truncated { got: 0, need: 122 }));
    assert!(matches!(sub.open(&[0u8; 200]), Err(WireError::BadMagic)));
    assert!(matches!(
        sub.open(&vec![0u8; bsc_lan_stream::MAX_DATAGRAM_BYTES + 1]),
        Err(WireError::TooLarge { .. })
    ));
}

/// The recovery story, driven end to end: a subscriber misses live traffic,
/// notices exactly what it missed, and is made whole by a snapshot alone --
/// having asked the sensor for nothing, because it cannot.
#[test]
fn a_subscriber_that_missed_deltas_recovers_from_the_next_snapshot() {
    let sensor = sensor();
    let sub = subscriber();
    let mut tracker = Tracker::new();

    let emit = |kind: Kind, seq: u64, frame: &Frame| {
        sensor.seal(kind, seq, [seq as u8; 12], &frame.encode().unwrap()).unwrap()
    };

    // seq 0: an opening snapshot. The subscriber is whole.
    let mut state = SensorState { monotonic_us: 1_000, ..Default::default() };
    state.counters.insert("alerts.total".into(), 0);
    let dg = emit(Kind::Snapshot, 0, &Frame::Snapshot(state.clone()));
    let (env, _) = sub.open(&dg).unwrap();
    assert_eq!(tracker.accept(&env).unwrap(), Reception::Started);
    assert_eq!(tracker.completeness(), Some(Completeness::Whole));

    // seq 1..=3 are emitted but LOST in flight -- never opened, never seen.

    // seq 4 arrives. The subscriber must notice precisely what it missed.
    let dg = emit(Kind::Delta, 4, &an_alert());
    let (env, _) = sub.open(&dg).unwrap();
    assert_eq!(tracker.accept(&env).unwrap(), Reception::Gap { missing: 1..=3 });
    assert_eq!(
        tracker.completeness(),
        Some(Completeness::Degraded),
        "a subscriber that lost datagrams must not believe its view is complete"
    );

    // seq 5: the periodic snapshot. No request was made and none was possible.
    state.counters.insert("alerts.total".into(), 4);
    state.monotonic_us = 6_000;
    let dg = emit(Kind::Snapshot, 5, &Frame::Snapshot(state.clone()));
    let (env, plaintext) = sub.open(&dg).unwrap();
    assert_eq!(tracker.accept(&env).unwrap(), Reception::InOrder);
    assert_eq!(
        tracker.completeness(),
        Some(Completeness::Whole),
        "the snapshot is the entire recovery mechanism on a one-way stream"
    );

    // And the recovered state is the sensor's real state, not a patched-up
    // guess assembled from the deltas that did survive.
    match Frame::decode(&plaintext).unwrap() {
        Frame::Snapshot(recovered) => assert_eq!(recovered, state),
        Frame::Delta(d) => panic!("expected a snapshot, got {d:?}"),
    }
}

#[test]
fn a_sensor_reboot_is_visible_to_subscribers_as_a_restart() {
    let sub_key = sensor_key();
    let first = Sensor::new(sub_key.clone(), GroupKey::from_bytes(GROUP), [1u8; 16]);
    let after_reboot = Sensor::new(sub_key, GroupKey::from_bytes(GROUP), [2u8; 16]);
    let sub = subscriber();
    let mut tracker = Tracker::new();

    let dg = first.seal(Kind::Snapshot, 7, [1u8; 12], &an_alert().encode().unwrap()).unwrap();
    let (env, _) = sub.open(&dg).unwrap();
    tracker.accept(&env).unwrap();

    // Sequence restarts at 0 -- which without the boot id would read as a
    // replay and be silently discarded, hiding the reboot entirely.
    let dg = after_reboot.seal(Kind::Delta, 0, [2u8; 12], &an_alert().encode().unwrap()).unwrap();
    let (env, _) = sub.open(&dg).unwrap();
    assert_eq!(
        tracker.accept(&env).unwrap(),
        Reception::SensorRestarted { previous_boot: [1u8; 16], previous_last_seq: 7 }
    );
}
