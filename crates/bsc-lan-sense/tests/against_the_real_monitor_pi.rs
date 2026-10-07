//! The posture checker against the REAL monitor Pi.
//!
//! The fixtures are verbatim `/proc/net/*` tables captured from the live sensor (Raspberry Pi
//! 5, Debian 13, aarch64), alongside `ss -ltun` output taken from the same host at the same
//! moment. This test asserts the checker's verdict matches what `ss` independently reported.
//!
//! ## Why this is worth its weight
//!
//! Everything else about the posture checker is exercised against fixtures I wrote. Those
//! prove the parser does what I intended; they cannot prove I understood the format the target
//! platform actually emits. This one is captured from the machine the code will run on, on a
//! different architecture and a different distribution from the development box, and checked
//! against a tool that parses those tables independently.
//!
//! `ss` reported exactly six listening sockets on the sensor, every one a wildcard bind:
//!
//! ```text
//! tcp 0.0.0.0:22      tcp [::]:22
//! udp 0.0.0.0:42607   udp 0.0.0.0:5353
//! udp *:39727         udp *:5353
//! ```
//!
//! ## The capture is not in this repo
//!
//! `/proc/net` tables name this network's real hosts, so they live in the hub with the rest of
//! the project's private data — `projects/lan/fixtures/monitor-pi/`, described by
//! `projects/lan/estate.md`. These tests resolve them and SKIP when absent, so a fresh clone
//! and CI are green without data they were never given.

mod common;

use bsc_lan_sense::posture::{assess, Posture};
use bsc_lan_sense::procnet::{parse_table, Protocol, Reach, Role};
use bsc_lan_sense::ProcNetError;

fn table(name: &str, proto: Protocol) -> Option<bsc_lan_sense::procnet::Table> {
    let text = common::fixture(name)?;
    Some(parse_table(&text, proto).unwrap_or_else(|e| panic!("fixture {name} parses: {e}")))
}

/// All four tables, or `None` when the capture is absent.
fn all_tables() -> Option<Vec<Result<bsc_lan_sense::procnet::Table, ProcNetError>>> {
    Some(vec![
        Ok(table("tcp", Protocol::Tcp)?),
        Ok(table("tcp6", Protocol::Tcp)?),
        Ok(table("udp", Protocol::Udp)?),
        Ok(table("udp6", Protocol::Udp)?),
    ])
}

#[test]
fn every_row_the_real_sensor_emits_is_understood() {
    // The whole point of the row counts: a parser that stopped matching on the
    // target platform would report zero listeners, which reads as a hardened
    // box. Assert nothing was skipped.
    for (name, proto) in [
        ("tcp", Protocol::Tcp),
        ("tcp6", Protocol::Tcp),
        ("udp", Protocol::Udp),
        ("udp6", Protocol::Udp),
    ] {
        let Some(t) = table(name, proto) else {
            return common::skip("every_row_the_real_sensor_emits_is_understood");
        };
        assert!(t.rows_seen > 0, "{name} fixture has no data rows");
        assert_eq!(
            t.rows_parsed, t.rows_seen,
            "{name}: understood only {} of {} rows from a real Pi 5 running Debian 13 — \
             the format on the target platform differs from what this parser expects",
            t.rows_parsed, t.rows_seen
        );
    }
}

#[test]
fn the_verdict_matches_what_ss_reported_on_the_same_host() {
    let Some(tables) = all_tables() else {
        return common::skip("the_verdict_matches_what_ss_reported_on_the_same_host");
    };
    match assess(&tables) {
        Posture::Exposed { reachable, rows_examined } => {
            assert!(rows_examined > 0);
            // `ss -ltun` found exactly six listening sockets on the sensor.
            assert_eq!(
                reachable.len(),
                6,
                "expected the six listeners ss reported, got: {:?}",
                reachable.iter().map(|s| (&s.local_addr, s.local_port)).collect::<Vec<_>>()
            );
            let mut ports: Vec<u16> = reachable.iter().map(|s| s.local_port).collect();
            ports.sort_unstable();
            assert_eq!(ports, vec![22, 22, 5353, 5353, 39727, 42607]);

            // Every one is a wildcard bind — a real way in, not loopback.
            for s in &reachable {
                assert_eq!(s.reach, Reach::Wildcard, "{}:{}", s.local_addr, s.local_port);
                assert!(s.is_network_reachable_inbound());
            }
        }
        Posture::Sealed { .. } => panic!(
            "the checker called the sensor SEALED while ss showed six listeners including \
             sshd on 0.0.0.0:22 — this is the silent-pass failure the design exists to prevent"
        ),
        Posture::Unknown { reason } => panic!("could not assess real tables: {reason}"),
    }
}

/// The sensor is NOT currently sealed, and that is the honest starting point
/// for the work: it runs sshd, avahi and a dhcp client, all reachable.
#[test]
fn the_sensor_is_not_yet_sealed_and_the_checker_says_so_plainly() {
    let Some(tables) = all_tables() else {
        return common::skip("the_sensor_is_not_yet_sealed_and_the_checker_says_so_plainly");
    };
    let p = assess(&tables);
    assert!(!p.is_sealed());
    assert!(p.needs_attention(), "a box with sshd on a wildcard address wants attention");
}

/// An ESTABLISHED inbound connection is not an additional way in — the LISTEN
/// socket is the surface, and the conversation is its consequence. The capture
/// was taken over a live SSH session to the sensor, so this is exercised for
/// real rather than hypothetically.
#[test]
fn an_established_connection_is_not_counted_as_another_listening_surface() {
    let Some(t) = table("tcp", Protocol::Tcp) else {
        return common::skip("an_established_connection_is_not_counted_as_another_listening_surface");
    };
    let established: Vec<_> =
        t.sockets.iter().filter(|s| s.role == Role::ConnectedOutbound).collect();
    assert!(
        !established.is_empty(),
        "the capture should contain the live SSH session it was taken over"
    );
    for s in established {
        assert!(
            !s.is_network_reachable_inbound(),
            "an established conversation on {}:{} was counted as a listening surface",
            s.local_addr, s.local_port
        );
    }
    // And exactly one TCP listener, not one per connection.
    let listeners = t.sockets.iter().filter(|s| s.role == Role::Inbound).count();
    assert_eq!(listeners, 1, "sshd is one surface however many sessions are open");
}
