//! The emitter and the posture checker have to agree about the emitter.
//!
//! These are the two halves of the sensor, written separately, and the place
//! they could silently disagree is exactly here: the checker reads
//! `/proc/net/udp` and calls a UDP socket with no peer an inbound surface, so
//! an emitter that used `send_to` on an unconnected socket would make the
//! sensor attest itself `Exposed` **for the act of transmitting**. Nothing in
//! either crate's own tests could catch that, because each is individually
//! correct.
//!
//! So this test opens a real socket the way the sensor will, then reads the
//! real `/proc/net/udp` and asks the real checker what it thinks of it.

use bsc_lan_sense::procnet::{parse_table, Protocol, Role};
use bsc_lan_sense::transport::UdpMulticast;
use std::net::{Ipv4Addr, SocketAddrV4};

#[test]
fn the_sensors_own_emitter_socket_is_classified_outbound_not_a_listener() {
    let group = SocketAddrV4::new(Ipv4Addr::new(239, 10, 20, 30), 5140);
    let emitter = UdpMulticast::bind(Ipv4Addr::LOCALHOST, group)
        .expect("binding a multicast emitter on loopback must work; if this fails the sensor cannot emit at all");

    let local = emitter.local_addr().expect("a bound socket has a local address");
    let port = match local {
        std::net::SocketAddr::V4(v4) => v4.port(),
        std::net::SocketAddr::V6(v6) => panic!("expected an IPv4 socket, got {v6}"),
    };

    let text = std::fs::read_to_string("/proc/net/udp").expect("/proc/net/udp is readable");
    let table = parse_table(&text, Protocol::Udp).expect("the live udp table parses");

    // Population check first: if the parser found nothing, the assertion below
    // would pass vacuously and prove nothing at all.
    assert!(
        table.rows_parsed > 0,
        "parsed no rows from the live /proc/net/udp, so this test would pass without checking anything"
    );

    let ours: Vec<_> = table.sockets.iter().filter(|s| s.local_port == port).collect();
    assert!(
        !ours.is_empty(),
        "could not find the emitter's own socket (port {port}) among {} parsed rows -- \
         the test cannot conclude anything about a socket it did not find",
        table.rows_parsed
    );

    for s in ours {
        assert_eq!(
            s.role,
            Role::ConnectedOutbound,
            "the sensor's own emitter socket on port {port} reads as {:?}. If it is Inbound, \
             the sensor will attest itself Exposed for transmitting, and whoever watches the \
             posture will be trained to ignore a real alert. The fix is `connect()` rather \
             than `send_to` in UdpMulticast::bind.",
            s.role
        );
        assert!(!s.is_network_reachable_inbound());
    }
}

/// TTL 1 is what physically confines the telemetry to the local segment, so
/// it is asserted rather than trusted to a default.
#[test]
fn the_stream_cannot_be_routed_off_the_local_segment() {
    let group = SocketAddrV4::new(Ipv4Addr::new(239, 10, 20, 31), 5141);
    let emitter = UdpMulticast::bind(Ipv4Addr::LOCALHOST, group).expect("bind");
    assert_eq!(
        emitter.multicast_ttl().expect("ttl readable"),
        1,
        "a TTL above 1 lets a router carry the sensor's telemetry off the segment"
    );
}

/// A datagram that is too large must be refused by the wire contract before it
/// ever reaches the socket, since a fragmented multicast datagram loses the
/// whole payload if any fragment drops and there is no retransmission.
#[test]
fn the_emitter_refuses_an_oversized_payload_rather_than_letting_the_kernel_fragment_it() {
    use bsc_lan_sense::emit::{Emitter, SnapshotPolicy};
    use bsc_lan_stream::crypto::{GroupKey, Sensor};
    use bsc_lan_stream::frame::{Event, SensorState};
    use ed25519_dalek::SigningKey;

    struct Null;
    impl bsc_lan_sense::transport::Transport for Null {
        fn send(&self, _: &[u8]) -> std::io::Result<()> {
            Ok(())
        }
    }

    let sensor = Sensor::new(
        SigningKey::from_bytes(&[3u8; 32]),
        GroupKey::from_bytes([7u8; 32]),
        [1u8; 16],
    );
    let mut e = Emitter::new(sensor, Null, SnapshotPolicy { interval_ms: 10_000 });

    // A snapshot fat enough to exceed one datagram.
    let mut state = SensorState::default();
    for i in 0..500u64 {
        state.counters.insert(format!("counter.number.{i}"), i);
        state.active_alerts.push(Event::Health {
            uptime_s: i,
            soc_temp_c: 90.0,
            capture_drops: i,
        });
    }
    let posture = bsc_lan_sense::posture::Posture::Sealed {
        loopback_listeners: vec![],
        rows_examined: 10,
    };

    let err = e
        .emit_snapshot(state, &posture, 0)
        .expect_err("an oversized snapshot must be refused, not fragmented");
    assert!(
        err.to_string().contains("budget") || err.to_string().contains("over the"),
        "expected a size refusal, got: {err}"
    );
    assert_eq!(e.next_seq(), 0, "a refused datagram must not burn a sequence number");
}
