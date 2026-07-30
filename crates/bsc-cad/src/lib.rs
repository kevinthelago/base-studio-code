//! `bsc-cad` (#2621) — a Rust-native mesh/SDF geometry kernel for the Design Studio's AI-authored 3D
//! objects. The pipeline:
//!
//! ```text
//! declarative op-tree (Node)  →  SDF evaluation  →  dual-contouring polygonization  →  Mesh  →  STL / glTF
//! ```
//!
//! Two exports, two audiences: **STL** ([`stl`]) is the maker/slicer interchange, **glTF/GLB**
//! ([`gltf`], #3389) is the viewer format that lets the Design Studio preview a part in-app.
//!
//! Everything is millimetres. The op-tree is the source of truth an AI authors (describe *what the
//! part is*, not matrices); booleans + a smooth-min fillet (`smooth_union`) cover the common CSG moves.
//! Tauri-free and dependency-light so the same crate powers the `bsc cad` subcommand ([`cli`], #3387)
//! and a WASM/web build. Trade-offs vs OCCT/B-rep (no true STEP, no named topology, …) are
//! tracked on #2621; the icebox split into a standalone package is #2620.
pub mod cli;
pub mod gltf;
pub mod math;
pub mod mesh;
pub mod node;
pub mod qef;
pub mod sketch;
pub mod stl;

pub use gltf::{to_glb, to_gltf_json};
pub use math::{Aabb, Vec3};
pub use mesh::{polygonize, polygonize_with, Mesh, Method};
pub use node::Node;
pub use qef::Qef;
pub use sketch::Profile;
pub use stl::to_binary_stl;
