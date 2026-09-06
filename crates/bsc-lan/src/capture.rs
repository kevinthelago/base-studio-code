//! Monitor-mode frame capture — the sensor's Tier 2 input.
//!
//! ## Why the socket is here and the parsing is not
//!
//! `bsc-rf` owns what a frame MEANS and carries no I/O: `tests/lean.rs` pins its
//! dependency closure, and every parsing case there is a byte array in a test
//! rather than an attack somebody has to mount. This module is the other half —
//! it opens a raw socket and hands the bytes over. Nothing here interprets
//! anything.
//!
//! ## What it costs, stated plainly
//!
//! `AF_PACKET` + `SOCK_RAW` needs `CAP_NET_RAW`, and the sensor's unit was
//! written with an empty capability set. So enabling this widens the unit by
//! exactly one capability and one address family, and that is a real reduction
//! in what the hardening claims. It buys the only tier that can see a deauth
//! flood at all: the attack is performed with entirely legal frames and
//! radiates no excess energy, so the spectral tier is blind to it by
//! construction.
//!
//! ## It never transmits
//!
//! The socket is opened, bound and read. There is no `send`, no `sendto` and no
//! injection path, and a test asserts this file contains none — the same
//! promise `bsc-rf` makes about itself, kept at the layer that actually holds a
//! file descriptor.

use bsc_rf::deauth::FrameObservation;
use std::io;
use std::os::unix::io::RawFd;

/// Big enough for a radiotap header and a management frame with room to spare.
/// A jumbo data frame is truncated, which costs nothing: this only reads
/// management frames, and those are small.
const BUF: usize = 2048;

/// A bound monitor-mode capture socket.
///
/// Holds a file descriptor and closes it on drop. Deliberately not `Clone`:
/// two owners of one fd is two closers.
pub struct MonitorCapture {
    fd: RawFd,
    iface: String,
}

impl MonitorCapture {
    /// Open and bind a capture socket on `iface`.
    ///
    /// The interface must already be in monitor mode; putting it there is the
    /// radio unit's job and needs `CAP_NET_ADMIN`, which this process
    /// deliberately does not hold. A managed-mode interface yields ordinary
    /// ethernet frames with no radiotap header, which the parser refuses rather
    /// than misreads.
    pub fn open(iface: &str) -> io::Result<Self> {
        // SAFETY: plain libc calls with checked returns; no aliasing, no
        // lifetimes crossing the boundary. Every fd is closed on Drop or here.
        unsafe {
            let fd = libc::socket(
                libc::AF_PACKET,
                libc::SOCK_RAW | libc::SOCK_NONBLOCK,
                (libc::ETH_P_ALL as u16).to_be() as i32,
            );
            if fd < 0 {
                return Err(io::Error::last_os_error());
            }
            let idx = if_index(iface);
            if idx == 0 {
                libc::close(fd);
                return Err(io::Error::new(
                    io::ErrorKind::NotFound,
                    format!("no interface named {iface:?}"),
                ));
            }
            let mut addr: libc::sockaddr_ll = std::mem::zeroed();
            addr.sll_family = libc::AF_PACKET as u16;
            addr.sll_protocol = (libc::ETH_P_ALL as u16).to_be();
            addr.sll_ifindex = idx as i32;
            let rc = libc::bind(
                fd,
                std::ptr::addr_of!(addr).cast(),
                std::mem::size_of::<libc::sockaddr_ll>() as libc::socklen_t,
            );
            if rc < 0 {
                let e = io::Error::last_os_error();
                libc::close(fd);
                return Err(e);
            }
            Ok(Self { fd, iface: iface.to_string() })
        }
    }

    /// The interface this is bound to.
    pub fn iface(&self) -> &str {
        &self.iface
    }

    /// Read everything waiting, appending the disconnect frames to `out`.
    ///
    /// Returns how many frames were read in total — including the ones that
    /// were not disconnects, which is nearly all of them. That count is the
    /// difference between "the radio is quiet" and "the capture is not working",
    /// and those must never look the same.
    ///
    /// BOUNDED PER CALL. A busy channel can deliver faster than one window is
    /// drained, and a loop that ran until the socket was empty would starve the
    /// spectral read that shares this thread.
    pub fn drain(&self, at_ms: u64, max_frames: usize, out: &mut Vec<FrameObservation>) -> usize {
        let mut buf = [0u8; BUF];
        let mut seen = 0usize;
        while seen < max_frames {
            // SAFETY: `buf` is a live local of exactly this length.
            let n = unsafe { libc::recv(self.fd, buf.as_mut_ptr().cast(), buf.len(), 0) };
            if n <= 0 {
                // EWOULDBLOCK is the normal end of a drain, not a fault.
                break;
            }
            seen += 1;
            if let Some(o) = bsc_rf::deauth::parse_frame(&buf[..n as usize], at_ms) {
                out.push(o);
            }
        }
        seen
    }
}

impl Drop for MonitorCapture {
    fn drop(&mut self) {
        // SAFETY: the fd was ours and is not used again.
        unsafe { libc::close(self.fd) };
    }
}

/// The kernel's index for an interface name, or 0 when there is none.
fn if_index(iface: &str) -> u32 {
    let Ok(c) = std::ffi::CString::new(iface) else { return 0 };
    // SAFETY: a NUL-terminated string that outlives the call.
    unsafe { libc::if_nametoindex(c.as_ptr()) }
}

/// Drop observations older than the window, in place.
///
/// Pure, so the retention rule is testable without a socket. The sensor keeps a
/// rolling buffer and asks for a verdict each window; without this it would
/// grow for the life of the process and every verdict would be computed over
/// more and more history.
pub fn retain_window(obs: &mut Vec<FrameObservation>, now_ms: u64, window_ms: u64) {
    let floor = now_ms.saturating_sub(window_ms);
    obs.retain(|o| o.at_ms >= floor);
}

#[cfg(test)]
mod tests {
    use super::*;
    use bsc_rf::deauth::FrameKind;

    fn obs(at_ms: u64) -> FrameObservation {
        FrameObservation {
            at_ms,
            kind: FrameKind::Deauthentication,
            bssid: "aa:bb:cc:dd:ee:ff".into(),
            target: "ff:ff:ff:ff:ff:ff".into(),
            transmitter: "aa:bb:cc:dd:ee:ff".into(),
            reason: Some(7),
            freq_mhz: 2437,
            signal_dbm: Some(-40),
        }
    }

    #[test]
    fn the_rolling_buffer_forgets_what_is_past_the_window() {
        // Without this the buffer grows for the life of the process and each
        // verdict is computed over more history than the one before it.
        let mut v: Vec<FrameObservation> = (0..10).map(|i| obs(i * 1_000)).collect();
        retain_window(&mut v, 9_000, 5_000);
        assert_eq!(v.len(), 6, "kept: {:?}", v.iter().map(|o| o.at_ms).collect::<Vec<_>>());
        assert!(v.iter().all(|o| o.at_ms >= 4_000));
    }

    #[test]
    fn a_window_wider_than_the_clock_keeps_everything_rather_than_underflowing() {
        let mut v: Vec<FrameObservation> = (0..5).map(|i| obs(i * 100)).collect();
        retain_window(&mut v, 100, u64::MAX);
        assert_eq!(v.len(), 5);
    }

    #[test]
    fn an_interface_that_does_not_exist_is_named_rather_than_guessed_at() {
        assert_eq!(if_index("definitely-not-an-interface"), 0);
        // `unwrap_err` would want Debug on the socket, which deliberately has
        // none: a Debug on a live file descriptor invites printing one.
        let e = match MonitorCapture::open("definitely-not-an-interface") {
            Err(e) => e,
            Ok(_) => panic!("an interface that does not exist was opened anyway"),
        };
        assert!(
            e.kind() == io::ErrorKind::NotFound || e.kind() == io::ErrorKind::PermissionDenied,
            "unexpected: {e:?}"
        );
    }

    #[test]
    fn this_module_holds_no_transmit_path() {
        // The same promise bsc-rf makes about itself, kept at the layer that
        // actually holds a file descriptor. Asserted against the SOURCE because
        // nothing at run time can observe the absence of a send.
        let src = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/capture.rs"),
        )
        .expect("this file is readable");
        // Trim the tests AND the comments, or this assertion reads its own
        // text: the module doc names the very calls it forbids, and the first
        // version of this guard failed on its own paragraph. A scanner that
        // cannot tell its subject from its own prose is not evidence about the
        // subject.
        let body = &src[..src.find("#[cfg(test)]").expect("a test module delimits the scan")];
        let code: String = body
            .lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(code.contains("libc::recv"), "the scanner is looking at the wrong file");
        for forbidden in ["libc::send", "sendto", "sendmsg", "inject"] {
            assert!(
                !code.contains(forbidden),
                "a transmit path appeared in the capture module: {forbidden}"
            );
        }
    }
}
