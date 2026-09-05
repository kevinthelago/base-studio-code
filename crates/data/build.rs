fn main() {
    // Materialize this crate's graph records into `$OUT_DIR/crate.rs`, which `lib.rs`
    // `include!`s. A package gets exactly ONE build script and this one is already spoken for, so
    // the materializer is CALLED here rather than reached with `build = "../graph-materialize/
    // build.rs"` — same source, same output, one manifest line's difference
    // (`graph-materialize-becomes-a-real-build-dependency`).
    graph_materialize::emit();

    // DuckDB's Windows build references the Restart Manager API (RmStartSession,
    // RmEndSession, …) for additional file-lock diagnostics, but `libduckdb-sys`
    // doesn't link its import library — so the bundled build fails at link time with
    // unresolved externals. Link it explicitly on Windows.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        println!("cargo:rustc-link-lib=dylib=rstrtmgr");
    }
}
