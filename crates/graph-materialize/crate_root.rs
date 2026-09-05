// THE SHARED CRATE ROOT — one file, pointed at by every crate whose whole source is in the graph:
//
//     [lib]
//     path = "../graph-materialize/crate_root.rs"
//
// It is byte-identical for every adopter BY CONSTRUCTION, because it is one file rather than a copy
// per crate. Both halves come out of `$OUT_DIR`, written by the shared build script beside this file:
// `crate_doc.md` is the crate's OWN documentation, materialized from its `<crate>--lib.rs` doc record,
// so two adopters sharing this file still produce different rustdoc. Inner attributes a crate needs
// (`#![forbid(unsafe_code)]`) go in its manifest's `[lints]` table, which is a file that stays anyway.
#![doc = include_str!(concat!(env!("OUT_DIR"), "/crate_doc.md"))]
include!(concat!(env!("OUT_DIR"), "/crate.rs"));
