// Mobile tunnel — desktop bus + protocol + end-to-end crypto (#242a).
//
// The desktop mirrors its terminal panes to mobile-studio-code over a zero-knowledge
// Cloudflare relay (#241): both peers dial out, the relay forwards only opaque
// `{ room, ciphertext }`, and the payload is an end-to-end **Noise IK** session so the
// relay can never read terminal data. This module is the transport-FREE core, split across:
//
//   * `protocol` — the wire protocol (serde, conforming to mobile's `src/lib/types.ts`),
//   * `state` — `TunnelState`, the in-process bus that tees PTY output + holds pane metadata
//     and the desktop's static Noise keypair, plus the FCM push worker and wire helpers,
//   * `commands` — the metadata-push / status / relay-control Tauri commands,
//   * `transport` — the relay dial-out client that drains the bus through a Noise session
//     (#242b); `tunnel_write_pty` / `tunnel_resize_pty` (the inbound PTY bridge) live there,
//   * `noise` — the Noise IK handshake/transport helper (the desktop is the responder;
//     mobile is the initiator and learns the desktop's static key from the QR).
//
// See docs/tunnel-protocol.md.

// The wire protocol + Noise crypto moved to the Tauri-free `bsc-tunnel` crate (#1919); re-export them
// here so the desktop glue below (state / transport / commands / tests) keeps referencing
// `super::protocol` / `super::noise` and external consumers keep `crate::mobile::tunnel::<WireType>`.
pub use bsc_tunnel::noise;
pub(crate) use bsc_tunnel::protocol;
mod transport;
mod state;
mod commands;
#[cfg(test)]
mod tests;

pub(crate) use protocol::*;
pub use state::*;
pub use commands::*;
