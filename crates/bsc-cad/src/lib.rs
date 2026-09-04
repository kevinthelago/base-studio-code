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

pub use gltf::{to_glb, to_gltf_json};
pub use math::{Aabb, Vec3};
pub use mesh::{polygonize, polygonize_with, Mesh, Method};
pub use node::Node;
pub use qef::Qef;
pub use stl::to_binary_stl;

// This crate's modules are IN THE GRAPH, not in this directory.
// src/cli.rs, src/gltf.rs, src/math.rs, src/mesh.rs, src/node.rs, src/qef.rs, src/stl.rs do not exist — they are records in the
// committed graph/algorithms.json, materialized into $OUT_DIR by the shared build script.
// To change one, edit the RECORD and promote it; editing a file here would be editing nothing:
//     bsc graph impl get bsc-cad--<module>.rs
//     bsc graph impl set --id bsc-cad--<module>.rs --code-file <f>
//     bsc graph promote --id bsc-cad--<module>.rs
//
// This header stays a file because include! refuses crate-level //! docs and #![…] inner
// attributes (E0753 / "an inner attribute is not permitted in this context").
include!(concat!(env!("OUT_DIR"), "/crate.rs"));