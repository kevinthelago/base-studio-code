// THE SHARED INTEGRATION-TEST ROOT — one file, pointed at by every `[[test]]` target whose source
// lives in the graph:
//
//     [[test]]
//     name = "wire_contract"
//     path = "../graph-materialize/test_root.rs"
//
// The exact shape `crate_root.rs` beside this file already has, one tier down. It is byte-identical
// for every adopter and for every target within one crate BECAUSE it is one file: `CARGO_CRATE_NAME`
// is the TARGET's name, not the package's, so two `[[test]]` entries sharing this path each resolve
// their own materialized body out of the `$OUT_DIR` the shared build script writes. Verified with two
// targets in one package before any of this was written — cargo accepts the shared path and emits no
// warning.
//
// A carried Rust test is therefore a FIRST-CLASS cargo test target: `cargo nextest` compiles and runs
// it exactly as it runs a file, and a broken record turns the gate red. That is the whole reason this
// file exists — before it, `bsc algorithms test <id> --run` was the only executor, it was manual, and
// nothing in any gate ever reached a record's carried Rust test.
include!(concat!(env!("OUT_DIR"), "/tests/", env!("CARGO_CRATE_NAME"), ".rs"));
