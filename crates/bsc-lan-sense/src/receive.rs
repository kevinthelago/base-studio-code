//! The receiving side: joining the group, and a loop that can notice silence.
//!
//! ## A blocking receive loop defeats every silence guard built so far
//!
//! The obvious loop is a blocking `recv_from` in a `while`: take a datagram,
//! handle it, repeat. **That loop can never report silence.** When the sensor
//! dies, or the switch stops forwarding, or somebody unplugs it, `recv_from`
//! simply blocks forever — and the code path that would notice is the one that
//! has stopped running. The watcher sits there looking healthy, indefinitely,
//! at exactly the moment it has the most important thing to say.
//!
//! It is worth being clear how much that one ordinary-looking line would cost:
//! the sequence tracker, the liveness deadlines, `NeverHeard` as a distinct
//! state — all of it is reachable only if something keeps running while
//! nothing arrives.
//!
//! So the socket carries a **read timeout**, and a timeout is a first-class
//! tick rather than an error to swallow: it is what drives the liveness poll.
//! [`Tick`] makes that explicit at the type level, so a future edit cannot
//! quietly drop the case.

use std::io;
use std::net::{Ipv4Addr, SocketAddrV4, UdpSocket};
use std::time::Duration;

/// What one turn of the loop produced.
#[derive(Debug)]
pub enum Tick {
    /// A datagram arrived.
    Datagram(Vec<u8>),
    /// Nothing arrived before the read timeout. **Not an error** — this is the
    /// only opportunity a watcher gets to notice that a stream has stopped.
    Quiet,
}

/// The largest datagram we will read. Anything bigger is not ours: the wire
/// contract refuses to emit past its own budget, so an oversized read is
/// either corruption or somebody else's traffic on the group.
const READ_BUFFER: usize = 2048;

/// A subscriber's socket, joined to the sensor's multicast group.
pub struct MulticastReceiver {
    socket: UdpSocket,
}

impl MulticastReceiver {
    /// Join `group` on the interface owning `interface_addr`.
    ///
    /// `read_timeout` is what makes silence observable; it is required rather
    /// than optional for that reason.
    pub fn join(
        interface_addr: Ipv4Addr,
        group: SocketAddrV4,
        read_timeout: Duration,
    ) -> io::Result<Self> {
        // Bind to the group's port on all addresses: a multicast receiver must
        // not bind the group address itself on every platform, and binding the
        // wildcard is the portable form.
        let socket = UdpSocket::bind(SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, group.port()))?;
        socket.set_multicast_loop_v4(true)?;
        socket.join_multicast_v4(group.ip(), &interface_addr)?;
        // The line this module exists for.
        socket.set_read_timeout(Some(read_timeout))?;
        Ok(Self { socket })
    }

    /// One turn: a datagram, or the quiet tick.
    pub fn next_tick(&self) -> io::Result<Tick> {
        let mut buf = vec![0u8; READ_BUFFER];
        match self.socket.recv_from(&mut buf) {
            Ok((n, _from)) => {
                buf.truncate(n);
                Ok(Tick::Datagram(buf))
            }
            // A read timeout is the quiet tick, not a failure. Both kinds are
            // matched because the platforms disagree about which they raise.
            Err(e) if e.kind() == io::ErrorKind::WouldBlock || e.kind() == io::ErrorKind::TimedOut => {
                Ok(Tick::Quiet)
            }
            Err(e) => Err(e),
        }
    }

    /// Bind a plain UDP port with no multicast join.
    ///
    /// Needed because MULTICAST DOES NOT CROSS A VLAN without a multicast
    /// router, and this network has none — so a subscriber on another segment
    /// can never receive the group however correctly it joins. Such a
    /// subscriber is fed by unicast instead, and this is the socket that
    /// receives it. Same read timeout, for the same reason: a blocking loop
    /// cannot report silence.
    pub fn bind_unicast(port: u16, read_timeout: Duration) -> io::Result<Self> {
        let socket = UdpSocket::bind(SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, port))?;
        socket.set_read_timeout(Some(read_timeout))?;
        Ok(Self { socket })
    }

    pub fn local_addr(&self) -> io::Result<std::net::SocketAddr> {
        self.socket.local_addr()
    }

    /// The read timeout actually set on the socket.
    ///
    /// Exposed so the property can be ASSERTED rather than demonstrated. A
    /// test that proved this by waiting for a blocking read would hang rather
    /// than fail when the timeout is missing, and a hanging test is a worse
    /// signal than a failing one — it looks like an infrastructure problem.
    pub fn read_timeout(&self) -> io::Result<Option<Duration>> {
        self.socket.read_timeout()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::{Loopback, Transport, UdpMulticast};
    use bsc_lan_stream::crypto::{GroupKey, Sensor, Subscriber};
    use bsc_lan_stream::envelope::Kind;
    use bsc_lan_stream::frame::{Event, Frame};
    use bsc_lan_stream::liveness::{Cadence, Liveliness};
    use bsc_lan_stream::subscription::{Finding, Subscription};
    use ed25519_dalek::SigningKey;

    const GROUP_KEY: [u8; 32] = [7u8; 32];

    fn cadence() -> Cadence {
        Cadence { snapshot_interval_ms: 10_000, grace_ms: 2_000, missed_snapshots_before_alert: 3 }
    }

    fn subscription(now: u64) -> Subscription {
        Subscription::new(
            Subscriber::new(
                SigningKey::from_bytes(&[3u8; 32]).verifying_key(),
                GroupKey::from_bytes(GROUP_KEY),
            ),
            cadence(),
            now,
        )
    }

    #[test]
    fn a_unicast_bind_also_carries_the_read_timeout() {
        // A cross-VLAN subscriber uses this socket, and it needs to notice
        // silence exactly as much as a multicast one does.
        let rx = MulticastReceiver::bind_unicast(45141, Duration::from_millis(40)).expect("bind");
        assert_eq!(rx.read_timeout().unwrap(), Some(Duration::from_millis(40)));
        assert!(matches!(rx.next_tick().expect("quiet is not an error"), Tick::Quiet));
    }

    /// The line the whole module turns on, asserted directly.
    #[test]
    fn the_socket_carries_a_read_timeout() {
        let group = SocketAddrV4::new(Ipv4Addr::new(239, 12, 0, 90), 5190);
        let rx = MulticastReceiver::join(Ipv4Addr::LOCALHOST, group, Duration::from_millis(40))
            .expect("join");
        assert_eq!(
            rx.read_timeout().unwrap(),
            Some(Duration::from_millis(40)),
            "without a read timeout the loop blocks forever on a quiet group and every \
             silence guard built in this crate becomes unreachable"
        );
    }

    /// THE PROPERTY THIS MODULE EXISTS FOR. Nothing is ever sent; the loop must
    /// still produce a liveness finding. A blocking `recv_from` could not.
    #[test]
    fn a_watcher_reports_liveness_with_no_traffic_at_all() {
        let group = SocketAddrV4::new(Ipv4Addr::new(239, 12, 0, 91), 5191);
        let rx = MulticastReceiver::join(Ipv4Addr::LOCALHOST, group, Duration::from_millis(40))
            .expect("joining a multicast group on loopback must work");

        // One turn against a group nobody is sending to.
        let tick = rx.next_tick().expect("a quiet group is not an error");
        assert!(
            matches!(tick, Tick::Quiet),
            "an empty group must yield the quiet tick, not block and not error"
        );

        // And the quiet tick is what lets the subscriber speak.
        let mut sub = subscription(0);
        let findings = sub.poll(0);
        assert!(
            findings.iter().any(|f| matches!(
                f,
                Finding::LivelinessChanged { to: Liveliness::NeverHeard { .. } }
            )),
            "a watcher that has heard nothing must say so: {findings:?}"
        );
    }

    /// END TO END over real sockets: the real emitter transport, the real
    /// receiver, and the real subscriber. No fake transport on either side, so
    /// this cannot pass while the shipped path is broken.
    #[test]
    fn a_real_datagram_travels_from_the_emitter_transport_to_the_subscriber() {
        let group = SocketAddrV4::new(Ipv4Addr::new(239, 12, 0, 92), 5192);
        let rx = MulticastReceiver::join(Ipv4Addr::LOCALHOST, group, Duration::from_millis(500))
            .expect("join");
        // Loopback::On is what a same-host sender would normally need on a real
        // NIC. On `lo` the setting turns out to be indifferent (see Loopback's
        // docs — a bite test showed this passes either way), so it is written
        // explicitly here to exercise the real transport rather than because
        // the delivery depends on it.
        let tx = UdpMulticast::bind_with(Ipv4Addr::LOCALHOST, group, Loopback::On).expect("bind");

        let sensor = Sensor::new(
            SigningKey::from_bytes(&[3u8; 32]),
            GroupKey::from_bytes(GROUP_KEY),
            [1u8; 16],
        );
        let event = Event::Alert {
            sid: 2010935,
            msg: "ET SCAN Potential SSH Scan".into(),
            src: "10.99.4.66".into(),
            dst: "10.99.2.1".into(),
            severity: 2,
        };
        let datagram = sensor
            .seal(Kind::Delta, 0, [1u8; 12], &Frame::Delta(event.clone()).encode().unwrap())
            .unwrap();
        tx.send(&datagram).expect("send");

        let mut sub = subscription(0);
        let mut saw = None;
        for _ in 0..10 {
            match rx.next_tick().expect("tick") {
                Tick::Datagram(d) => {
                    for f in sub.receive(&d, 1) {
                        if let Finding::Event(e) = f {
                            saw = Some(e);
                        }
                    }
                    break;
                }
                Tick::Quiet => continue,
            }
        }
        assert_eq!(saw, Some(event), "the event did not survive the real socket path");
    }

    /// A forged datagram injected into the group must surface as a finding by
    /// the same real path — not be dropped somewhere between socket and
    /// subscriber.
    #[test]
    fn a_forgery_injected_into_the_real_group_is_reported() {
        let group = SocketAddrV4::new(Ipv4Addr::new(239, 12, 0, 93), 5193);
        let rx = MulticastReceiver::join(Ipv4Addr::LOCALHOST, group, Duration::from_millis(500))
            .expect("join");
        let tx = UdpMulticast::bind_with(Ipv4Addr::LOCALHOST, group, Loopback::On).expect("bind");

        // Holds the group key — it is a subscriber — but signs with its own key.
        let attacker = Sensor::new(
            SigningKey::from_bytes(&[9u8; 32]),
            GroupKey::from_bytes(GROUP_KEY),
            [1u8; 16],
        );
        let lie = Frame::Delta(Event::Health { uptime_s: 0, soc_temp_c: 20.0, capture_drops: 0 });
        tx.send(&attacker.seal(Kind::Delta, 0, [2u8; 12], &lie.encode().unwrap()).unwrap())
            .expect("send");

        let mut sub = subscription(0);
        let mut reported = false;
        for _ in 0..10 {
            match rx.next_tick().expect("tick") {
                Tick::Datagram(d) => {
                    reported = sub
                        .receive(&d, 1)
                        .iter()
                        .any(|f| matches!(f, Finding::ForgeryRejected { .. }));
                    break;
                }
                Tick::Quiet => continue,
            }
        }
        assert!(reported, "an injection into the group must reach the operator as a finding");
        assert_eq!(sub.rejections().forged, 1);
    }
}
