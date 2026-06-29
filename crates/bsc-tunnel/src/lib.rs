//! `bsc-tunnel` — the base-studio-code mobile-tunnel **wire contract + Noise crypto** (#1919). Tauri-free,
//! extracted from `src-tauri/src/mobile/tunnel/` so the byte-exact wire protocol (conforming to
//! mobile-studio-code's `src/lib/types.ts`) and the Noise IK handshake live in one shareable crate.
//!
//! - [`protocol`] — the serde wire types (the cross-repo contract; pinned by `tunnelProtocol.fixtures.json`).
//! - [`noise`] — the Noise IK handshake helpers (`Noise_IK_25519_ChaChaPoly_BLAKE2s`).
//!
//! The desktop-specific glue — the in-process bus (`TunnelState`), the relay transport, the Tauri
//! commands, and the FCM push worker — stays in `src-tauri/src/mobile/tunnel/` and depends on this crate.

pub mod protocol;
pub mod noise;
