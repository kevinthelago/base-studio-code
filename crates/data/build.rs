fn main() {
    // DuckDB's Windows build references the Restart Manager API (RmStartSession,
    // RmEndSession, …) for additional file-lock diagnostics, but `libduckdb-sys`
    // doesn't link its import library — so the bundled build fails at link time with
    // unresolved externals. Link it explicitly on Windows.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        println!("cargo:rustc-link-lib=dylib=rstrtmgr");
    }
}
