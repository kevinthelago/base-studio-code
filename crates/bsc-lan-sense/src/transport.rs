//! Where a datagram goes once it is sealed.
//!
//! A seam, so that everything worth testing in [`crate::emit`] -- sequencing,
//! nonce derivation, snapshot scheduling, posture wiring -- runs without a
//! socket, and the real implementation stays a thin shell over the standard
//! library with nothing clever in it.

use std::io;
use std::net::{Ipv4Addr, SocketAddrV4, UdpSocket};

/// Somewhere to put a finished datagram.
pub trait Transport {
    fn send(&self, datagram: &[u8]) -> io::Result<()>;
}

/// Multicast UDP over one named interface.
///
/// ## `connect`, not `sendto` -- for two independent reasons
///
/// The posture checker in [`crate::procnet`] classifies a UDP socket **with**
/// a peer as connected-outbound and one **without** as a bound inbound
/// surface, because that is exactly how the kernel distinguishes them in
/// `/proc/net/udp`. An emitter using `send_to` on an unconnected socket would
/// therefore appear in the sensor's own attestation as a socket bound with no
/// peer -- the sensor would report itself `Exposed` for the act of
/// transmitting, and whoever watches the posture would learn to ignore it.
///
/// Independently, a connected UDP socket discards datagrams from anyone but
/// its peer, which narrows what can even reach the socket on a box whose whole
/// premise is that nothing reaches it.
///
/// ## TTL 1 is a security property, not a default
///
/// A multicast TTL of one means the telemetry **physically cannot be routed
/// off the local segment**, whatever some router elsewhere is configured to
/// do with the group. It bounds the blast radius of a misconfigured multicast
/// route to nothing.
/// Whether the kernel loops our own multicast back to this host.
///
/// The sensor wants this OFF: it has no receive path at all, so looping its
/// own traffic back up the stack is pure cost on a thermally-saturated box.
///
/// ## What this setting does NOT do, measured rather than assumed
///
/// An earlier version of this comment claimed a same-host end-to-end test
/// needs the loop enabled. **That is false**, and a bite test proved it: the
/// end-to-end test in [`crate::receive`] passes with `Loopback::Off`.
/// `IP_MULTICAST_LOOP` has no observable effect when the outgoing interface is
/// loopback — the datagram is delivered either way — so the setting is
/// meaningful on a real NIC and indifferent on `lo`.
///
/// It is kept as a named parameter because Off is a deliberate choice for the
/// sensor that a future reader should see and not "optimise" away, not because
/// the tests depend on it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Loopback {
    /// The sensor. Nothing on this host listens.
    Off,
    /// Same-host tests.
    On,
}

pub struct UdpMulticast {
    socket: UdpSocket,
}

impl UdpMulticast {
    /// Bind to `interface_addr` and connect to the multicast `group`.
    ///
    /// There is deliberately no receive path on this type. Not "unused" -- 
    /// absent, so that no future edit can casually add a read to the sensor's
    /// one outbound socket.
    pub fn bind(interface_addr: Ipv4Addr, group: SocketAddrV4) -> io::Result<Self> {
        Self::bind_with(interface_addr, group, Loopback::Off)
    }

    /// As [`bind`](Self::bind), choosing whether our own multicast loops back.
    pub fn bind_with(
        interface_addr: Ipv4Addr,
        group: SocketAddrV4,
        loopback: Loopback,
    ) -> io::Result<Self> {
        // Port 0: the kernel picks the source port. The sensor is never
        // addressed, so a fixed source port would buy nothing and would be one
        // more stable thing to aim at.
        let socket = UdpSocket::bind(SocketAddrV4::new(interface_addr, 0))?;
        // NOTE: std exposes no `IP_MULTICAST_IF`. Binding the socket to the
        // interface's own address is the std-only lever for selecting the
        // egress interface, and on this Pi -- one routable interface -- that
        // is unambiguous. If the sensor ever becomes multi-homed, this is the
        // line that needs `socket2::Socket::set_multicast_if_v4`, and the
        // symptom of not fixing it would be telemetry leaving the wrong NIC.
        socket.set_multicast_ttl_v4(1)?;
        socket.set_multicast_loop_v4(matches!(loopback, Loopback::On))?;
        socket.connect(group)?;
        Ok(Self { socket })
    }

    /// The multicast TTL actually set on the socket. Exposed so the
    /// segment-confinement property can be asserted rather than assumed.
    pub fn multicast_ttl(&self) -> io::Result<u32> {
        self.socket.multicast_ttl_v4()
    }

    /// The local address the kernel assigned. Only for reporting.
    pub fn local_addr(&self) -> io::Result<std::net::SocketAddr> {
        self.socket.local_addr()
    }
}

impl Transport for UdpMulticast {
    fn send(&self, datagram: &[u8]) -> io::Result<()> {
        // `send`, not `send_to` -- the socket is connected, and using the
        // unconnected form here would defeat the reasoning above.
        self.socket.send(datagram).map(|_| ())
    }
}
