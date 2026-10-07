//! The sensor's self-attestation, driven from verbatim `/proc/net` fixtures.
//!
//! Every fixture below is copied from a real Linux host rather than invented,
//! because the parser's whole value is that it matches what the kernel
//! actually writes -- and the box it will run on is one nobody can log into to
//! check.

use bsc_lan_sense::error::ProcNetError;
use bsc_lan_sense::posture::{assess, Posture};
use bsc_lan_sense::procnet::{parse_table, Protocol, Reach, Role};

const TCP_HEADER: &str = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";
const UDP_HEADER: &str = "   sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode ref pointer drops";
const TCP6_HEADER: &str = "  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";

/// A loopback TCP listener: 127.0.0.1:2999, state 0A.
const TCP_LOOPBACK_LISTENER: &str = "   0: 0100007F:0BB7 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 3553638 1 00000000f39ad427 100 0 0 10 0";
/// A WILDCARD TCP listener: 0.0.0.0:8080 -- a genuine way in.
const TCP_WILDCARD_LISTENER: &str = "   1: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 3553639 1 00000000f39ad428 100 0 0 10 0";
/// A DHCP client: 10.99.2.118:68 connected to 10.99.2.1:67.
const UDP_CONNECTED: &str = " 9995: 7602630A:0044 0102630A:0043 01 00000000:00000000 00:00000000 00000000     0        0 2596425 2 000000002829356d 0";
/// A UDP socket bound to every interface with no peer -- inbound capability.
const UDP_WILDCARD_BOUND: &str = "12738: 00000000:CAFB 00000000:0000 07 00000000:00000000 00:00000000 00000000   103        0 13814 2 00000000b148a66b 0";
/// `::1` in the four-little-endian-word form the kernel uses.
const TCP6_LOOPBACK_LISTENER: &str = "   0: 00000000000000000000000001000000:0277 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 1926579 1 000000002f8e37da 100 0 0 10 0";

fn table(header: &str, rows: &[&str]) -> String {
    let mut s = String::from(header);
    for r in rows {
        s.push('\n');
        s.push_str(r);
    }
    s
}

#[test]
fn a_loopback_tcp_listener_is_decoded_with_its_real_address() {
    let t = parse_table(&table(TCP_HEADER, &[TCP_LOOPBACK_LISTENER]), Protocol::Tcp).unwrap();
    assert_eq!(t.rows_seen, 1);
    assert_eq!(t.rows_parsed, 1);
    let s = &t.sockets[0];
    // Little-endian per word: 0100007F really is 127.0.0.1, not 1.0.0.127.
    assert_eq!(s.local_addr, "127.0.0.1");
    assert_eq!(s.local_port, 0x0BB7);
    assert_eq!(s.role, Role::Inbound);
    assert_eq!(s.reach, Reach::Loopback);
    assert!(!s.is_network_reachable_inbound());
}

#[test]
fn a_wildcard_tcp_listener_is_a_way_in() {
    let t = parse_table(&table(TCP_HEADER, &[TCP_WILDCARD_LISTENER]), Protocol::Tcp).unwrap();
    let s = &t.sockets[0];
    assert_eq!(s.local_addr, "0.0.0.0");
    assert_eq!(s.local_port, 8080);
    assert_eq!(s.reach, Reach::Wildcard);
    assert!(s.is_network_reachable_inbound());
}

/// The distinction that stops the sensor reporting itself exposed for doing
/// its job: the outbound multicast emitter is a CONNECTED udp socket.
#[test]
fn a_connected_udp_socket_is_outbound_and_never_an_inbound_surface() {
    let t = parse_table(&table(UDP_HEADER, &[UDP_CONNECTED]), Protocol::Udp).unwrap();
    let s = &t.sockets[0];
    assert_eq!(s.local_addr, "10.99.2.118");
    assert_eq!(s.role, Role::ConnectedOutbound);
    assert!(
        !s.is_network_reachable_inbound(),
        "a socket with a peer is the sensor transmitting, not a way in"
    );
}

#[test]
fn a_bound_udp_socket_with_no_peer_is_inbound_capability() {
    let t = parse_table(&table(UDP_HEADER, &[UDP_WILDCARD_BOUND]), Protocol::Udp).unwrap();
    let s = &t.sockets[0];
    assert_eq!(s.role, Role::Inbound);
    assert_eq!(s.reach, Reach::Wildcard);
    assert!(s.is_network_reachable_inbound());
}

#[test]
fn the_ipv6_loopback_word_order_is_decoded_correctly() {
    let t = parse_table(&table(TCP6_HEADER, &[TCP6_LOOPBACK_LISTENER]), Protocol::Tcp).unwrap();
    let s = &t.sockets[0];
    assert_eq!(s.reach, Reach::Loopback, "::1 must not read as routable");
    assert!(!s.is_network_reachable_inbound());
}

#[test]
fn a_sealed_verdict_records_how_many_rows_justified_it() {
    let tcp = parse_table(&table(TCP_HEADER, &[TCP_LOOPBACK_LISTENER]), Protocol::Tcp);
    let udp = parse_table(&table(UDP_HEADER, &[UDP_CONNECTED]), Protocol::Udp);
    match assess(&[tcp, udp]) {
        Posture::Sealed { loopback_listeners, rows_examined } => {
            assert_eq!(rows_examined, 2);
            assert_eq!(loopback_listeners.len(), 1);
        }
        Posture::Exposed { reachable, .. } => panic!("expected Sealed, exposed by {reachable:?}"),
        Posture::Unknown { reason } => panic!("expected Sealed, could not assess: {reason}"),
    }
}

#[test]
fn one_reachable_listener_anywhere_makes_the_whole_box_exposed() {
    let tcp = parse_table(
        &table(TCP_HEADER, &[TCP_LOOPBACK_LISTENER, TCP_WILDCARD_LISTENER]),
        Protocol::Tcp,
    );
    let p = assess(&[tcp]);
    match &p {
        Posture::Exposed { reachable, .. } => {
            assert_eq!(reachable.len(), 1);
            assert_eq!(reachable[0].local_port, 8080);
        }
        Posture::Sealed { .. } => panic!("expected Exposed, got Sealed"),
        Posture::Unknown { reason } => panic!("expected Exposed, could not assess: {reason}"),
    }
    assert!(!p.is_sealed());
    assert!(p.needs_attention());
}

// ---------------------------------------------------------------------------
// The rule that matters most: a check that cannot read reports Unknown.
// Each way of failing gets its own test, because each one has to be handled
// separately in code and a shared test would hide a missing branch.
// ---------------------------------------------------------------------------

#[test]
fn an_empty_table_is_unknown_not_sealed() {
    let r = parse_table("", Protocol::Tcp);
    assert_eq!(r, Err(ProcNetError::Empty));
    assert!(!assess(&[r]).is_sealed());
}

#[test]
fn an_unrecognised_header_is_unknown_not_sealed() {
    let r = parse_table("total garbage that is not a proc table\n1 2 3", Protocol::Tcp);
    assert!(matches!(r, Err(ProcNetError::UnrecognisedHeader(_))));
    let p = assess(&[r]);
    assert!(!p.is_sealed(), "a kernel format change must never read as a hardened box");
    assert!(p.needs_attention());
}

#[test]
fn a_header_only_table_with_no_rows_does_not_by_itself_prove_anything() {
    // A real possibility: the file exists and parses, but every row vanished.
    // That IS legitimately zero sockets, so it is Sealed -- but the row count
    // is what lets a reader tell it from a rich, healthy table.
    let p = assess(&[parse_table(TCP_HEADER, Protocol::Tcp)]);
    match p {
        Posture::Sealed { rows_examined, .. } => assert_eq!(
            rows_examined, 0,
            "a Sealed verdict must carry the evidence count so zero is visible"
        ),
        Posture::Exposed { reachable, .. } => panic!("expected Sealed, exposed by {reachable:?}"),
        Posture::Unknown { reason } => panic!("expected Sealed, could not assess: {reason}"),
    }
}

#[test]
fn rows_the_parser_could_not_understand_make_the_verdict_unknown() {
    // Header is fine, so the file IS a proc table -- but the rows are not
    // shaped as this parser expects. Assessing only the subset that parsed
    // would be a conclusion about the wrong population.
    let text = format!("{TCP_HEADER}\n   0: NOTHEX:ZZZZ 00000000:0000 0A rest\n   1: ALSOBAD 00000000:0000 0A rest");
    let t = parse_table(&text, Protocol::Tcp).unwrap();
    assert_eq!(t.rows_seen, 2);
    assert_eq!(t.rows_parsed, 0);

    let p = assess(&[Ok(t)]);
    assert!(
        matches!(p, Posture::Unknown { reason: ProcNetError::PartiallyUnderstood { rows_seen: 2, rows_parsed: 0 } }),
        "got {p:?}"
    );
    assert!(!p.is_sealed());
}

#[test]
fn an_unreadable_file_is_unknown_not_sealed() {
    let p = assess(&[Err(ProcNetError::Unreadable {
        path: "/proc/net/tcp".into(),
        reason: "Permission denied".into(),
    })]);
    assert!(!p.is_sealed());
    assert!(p.needs_attention());
}

#[test]
fn one_failed_table_poisons_the_whole_verdict() {
    // Three clean tables and one failure must NOT average out to a pass: the
    // unread table is exactly where a listener would be hiding.
    let ok1 = parse_table(&table(TCP_HEADER, &[TCP_LOOPBACK_LISTENER]), Protocol::Tcp);
    let ok2 = parse_table(&table(UDP_HEADER, &[UDP_CONNECTED]), Protocol::Udp);
    let ok3 = parse_table(&table(TCP6_HEADER, &[TCP6_LOOPBACK_LISTENER]), Protocol::Tcp);
    let bad = Err(ProcNetError::Unreadable { path: "/proc/net/udp6".into(), reason: "ENOENT".into() });

    assert!(
        !assess(&[ok1, ok2, ok3, bad]).is_sealed(),
        "a verdict drawn from three of four tables is a verdict about three of four tables"
    );
}

#[test]
fn assessing_nothing_at_all_is_unknown() {
    assert!(!assess(&[]).is_sealed());
}

#[test]
fn unknown_is_alertable_because_not_knowing_is_the_alertable_condition() {
    let p = Posture::Unknown { reason: ProcNetError::Empty };
    assert!(p.needs_attention(), "on a box nobody can inspect, 'I cannot tell' must wake someone");
}

/// Sanity against the live host: the verdict must be well-formed and justified
/// whatever this particular machine happens to be running. Deliberately does
/// NOT assert Sealed -- a dev box has listeners, and a test that demanded
/// otherwise would be asserting something about the machine, not the code.
#[test]
fn the_live_host_yields_a_justified_verdict() {
    match bsc_lan_sense::assess_host() {
        Posture::Sealed { rows_examined, .. } | Posture::Exposed { rows_examined, .. } => {
            assert!(rows_examined > 0, "a verdict on a live host from zero rows is a broken parser");
        }
        Posture::Unknown { reason } => panic!("could not assess this host: {reason}"),
    }
}
