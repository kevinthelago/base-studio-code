//! `bsc-cad` (#2621) — a Rust-native mesh/SDF geometry kernel for the Design Studio's AI-authored 3D
//! objects. The pipeline:
//!
//! ```text
//! declarative op-tree (Node)  →  SDF evaluation  →  dual-contouring polygonization  →  Mesh  →  binary STL
//! ```
//!
//! Everything is millimetres. The op-tree is the source of truth an AI authors (describe *what the
//! part is*, not matrices); booleans + a smooth-min fillet (`smooth_union`) cover the common CSG moves.
//! Tauri-free and dependency-light so the same crate powers the `bsc cad` subcommand ([`cli`], #3387)
//! and a WASM/web build. Trade-offs vs OCCT/B-rep (no true STEP, no named topology, …) are
//! tracked on #2621; the icebox split into a standalone package is #2620.
pub mod cli;
pub mod math;
pub mod mesh;
pub mod node;
pub mod qef;
pub mod stl;

pub use math::{Aabb, Vec3};
pub use mesh::{polygonize, polygonize_with, Mesh, Method};
pub use node::Node;
pub use qef::Qef;
pub use stl::to_binary_stl;
