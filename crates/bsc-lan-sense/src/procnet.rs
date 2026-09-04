//! Parsing `/proc/net/{tcp,udp,tcp6,udp6}` into sockets.
//!
//! Pure text in, structured sockets out. The sensor is emit-only and updated
//! by swapping its SD card, so the ONLY way to have confidence in this code is
//! to test it exhaustively from fixtures -- there is no logging in to check.
//!
//! ## The formats, from the real files rather than from memory
//!
//! ```text
//!   sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid ...
//!    0: 0100007F:0BB7 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000 ...
//! ```
//!
//! `local_address` is `HEXADDR:HEXPORT`. The address is hex **little-endian
//! per 32-bit word**, so `0100007F` is 127.0.0.1 and `00000000` is the
//! wildcard `0.0.0.0`. IPv6 packs four such words into 32 hex characters.
//! The port is plain big-endian hex.

use crate::error::ProcNetError;

/// TCP socket in `LISTEN`.
const TCP_LISTEN: &str = "0A";
/// UDP socket that is bound but not connected.
const UDP_UNCONNECTED: &str = "07";

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum Protocol {
    Tcp,
    Udp,
}

/// What a row in one of the tables actually represents.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum Role {
    /// TCP `LISTEN`, or UDP bound with no peer: something can arrive here.
    Inbound,
    /// A socket with a peer address set. On this sensor that is the outbound
    /// multicast emitter doing its job -- NOT an inbound surface. Conflating
    /// the two would have the sensor report itself exposed for transmitting.
    ConnectedOutbound,
}

/// How reachable a bound address is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum Reach {
    /// `0.0.0.0` / `::` -- bound to every interface. The binding that matters.
    Wildcard,
    /// A specific, routable address.
    Routable,
    /// `127.0.0.0/8` or `::1`: not reachable across the network.
    Loopback,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Socket {
    pub transport: Protocol,
    pub role: Role,
    pub reach: Reach,
    pub local_port: u16,
    /// Rendered for humans; the verdict never parses this back.
    pub local_addr: String,
}

impl Socket {
    /// Whether this socket is a way INTO the box from the network.
    pub fn is_network_reachable_inbound(&self) -> bool {
        match self.role {
            Role::ConnectedOutbound => false,
            Role::Inbound => match self.reach {
                Reach::Wildcard | Reach::Routable => true,
                Reach::Loopback => false,
            },
        }
    }
}

/// One parsed table, carrying how many rows it actually understood.
///
/// The count is not decoration. A parser that has stopped matching returns an
/// empty socket list, which is indistinguishable from a hardened box unless
/// the caller can see that zero rows were read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Table {
    pub sockets: Vec<Socket>,
    /// Data rows present in the input, whether or not they were understood.
    pub rows_seen: usize,
    /// Rows successfully parsed.
    pub rows_parsed: usize,
}

/// Decode a `/proc/net` hex address into a display string and its reach.
fn decode_addr(hex: &str) -> Result<(String, Reach), ProcNetError> {
    match hex.len() {
        8 => {
            let raw = u32::from_str_radix(hex, 16)
                .map_err(|_| ProcNetError::BadAddress(hex.to_string()))?;
            // Little-endian per word: the first hex pair is the LAST octet.
            let o = raw.to_le_bytes();
            let text = format!("{}.{}.{}.{}", o[0], o[1], o[2], o[3]);
            let reach = if raw == 0 {
                Reach::Wildcard
            } else if o[0] == 127 {
                Reach::Loopback
            } else {
                Reach::Routable
            };
            Ok((text, reach))
        }
        32 => {
            let mut words = [0u32; 4];
            for (i, w) in words.iter_mut().enumerate() {
                *w = u32::from_str_radix(&hex[i * 8..i * 8 + 8], 16)
                    .map_err(|_| ProcNetError::BadAddress(hex.to_string()))?;
            }
            let bytes: Vec<u8> = words.iter().flat_map(|w| w.to_le_bytes()).collect();
            let all_zero = bytes.iter().all(|b| *b == 0);
            // ::1 -- fifteen zero bytes then 1.
            let loopback = bytes[..15].iter().all(|b| *b == 0) && bytes[15] == 1;
            // The two cases that actually show up are the ones an operator most
            // needs to recognise instantly, and they are the least readable
            // fully expanded: a wildcard bind and loopback.
            let text = if all_zero {
                "::".to_string()
            } else if loopback {
                "::1".to_string()
            } else {
                bytes
                    .chunks(2)
                    .map(|c| format!("{:02x}{:02x}", c[0], c[1]))
                    .collect::<Vec<_>>()
                    .join(":")
            };
            let reach = if all_zero {
                Reach::Wildcard
            } else if loopback {
                Reach::Loopback
            } else {
                Reach::Routable
            };
            Ok((text, reach))
        }
        _ => Err(ProcNetError::BadAddress(hex.to_string())),
    }
}

fn split_addr(field: &str) -> Result<(&str, u16), ProcNetError> {
    let (a, p) = field
        .split_once(':')
        .ok_or_else(|| ProcNetError::BadAddress(field.to_string()))?;
    let port = u16::from_str_radix(p, 16).map_err(|_| ProcNetError::BadAddress(field.to_string()))?;
    Ok((a, port))
}

/// Parse one `/proc/net` table.
///
/// Never returns `Ok` with a silently-empty result for input it did not
/// understand: a row it cannot parse increments `rows_seen` without
/// incrementing `rows_parsed`, and the caller compares the two.
pub fn parse_table(text: &str, transport: Protocol) -> Result<Table, ProcNetError> {
    let mut lines = text.lines();
    let header = lines.next().ok_or(ProcNetError::Empty)?;
    // The header is the one thing every kernel version has kept stable, so it
    // is the cheapest way to notice we are reading something else entirely.
    if !header.contains("local_address") {
        return Err(ProcNetError::UnrecognisedHeader(
            header.chars().take(60).collect(),
        ));
    }

    let mut sockets = Vec::new();
    let mut rows_seen = 0usize;
    let mut rows_parsed = 0usize;

    for line in lines {
        if line.trim().is_empty() {
            continue;
        }
        rows_seen += 1;

        let f: Vec<&str> = line.split_whitespace().collect();
        // sl, local, rem, st -- the four fields this parser needs.
        if f.len() < 4 {
            continue;
        }

        let (Ok((local_hex, local_port)), Ok((rem_hex, rem_port))) =
            (split_addr(f[1]), split_addr(f[2]))
        else {
            continue;
        };
        let Ok((local_addr, reach)) = decode_addr(local_hex) else {
            continue;
        };
        let Ok((_, _)) = decode_addr(rem_hex) else {
            continue;
        };

        let state = f[3];
        let has_peer = rem_port != 0;

        let role = match transport {
            Protocol::Tcp => {
                if state == TCP_LISTEN {
                    Role::Inbound
                } else {
                    // Every other TCP state implies an established or closing
                    // conversation, which is not a listening surface.
                    Role::ConnectedOutbound
                }
            }
            Protocol::Udp => {
                if state == UDP_UNCONNECTED && !has_peer {
                    Role::Inbound
                } else {
                    Role::ConnectedOutbound
                }
            }
        };

        rows_parsed += 1;
        sockets.push(Socket { transport, role, reach, local_port, local_addr });
    }

    Ok(Table { sockets, rows_seen, rows_parsed })
}
