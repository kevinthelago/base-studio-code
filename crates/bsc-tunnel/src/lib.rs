//! `bsc-tunnel` — the base-studio-code mobile-tunnel **wire contract + Noise crypto** (#1919). Tauri-free,
//! extracted from `src-tauri/src/mobile/tunnel/` so the byte-exact wire protocol (conforming to
//! mobile-studio-code's `src/lib/types.ts`) and the Noise IK handshake live in one shareable crate.
//!
//! - [`protocol`] — the serde wire types (the cross-repo contract; pinned by `tunnelProtocol.fixtures.json`).
//! - [`noise`] — the Noise IK handshake helpers (`Noise_IK_25519_ChaChaPoly_BLAKE2s`).
//!
//! The desktop-specific glue — the in-process bus (`TunnelState`), the relay transport, the Tauri
//! commands, and the FCM push worker — stays in `src-tauri/src/mobile/tunnel/` and depends on this crate.

// This crate's modules are IN THE GRAPH, not in this directory.
// src/protocol.rs, src/noise.rs do not exist — they are records in the
// committed graph/algorithms.json, materialized into $OUT_DIR by the shared build script.
// To change one, edit the RECORD and promote it; editing a file here would be editing nothing:
//     bsc graph impl get bsc-tunnel--<module>.rs
//     bsc graph impl set --id bsc-tunnel--<module>.rs --code-file <f>
//     bsc graph promote --id bsc-tunnel--<module>.rs
//
// This header stays a file because include! refuses crate-level //! docs and #![…] inner
// attributes (E0753 / "an inner attribute is not permitted in this context").
include!(concat!(env!("OUT_DIR"), "/crate.rs"));